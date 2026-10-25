//! LAN remote-control server for the iPhone PWA (spec §12).
//!
//! Security model:
//!  * Binds to one private LAN address (or loopback), never 0.0.0.0.
//!  * `Host` must be the bound IP literal → blocks DNS-rebinding pages.
//!  * `Origin` on POST/WS must match `http://<bound host>` → blocks CSWSH.
//!  * Pairing needs desktop approval *and* the 6-digit code shown on the TV.
//!  * Bearer token is sent as the first WS message (never in a URL/log).
//!  * Per-connection replay guard + token-bucket rate limit; 2 KiB messages.

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use monitoros_core::{
    now_ms,
    pairing::{PairedDevice, PairingError, PairingManager, PendingPairing},
    remote::{parse_envelope, RateLimiter, RemoteAck, RemoteCommand, ReplayGuard, MAX_MESSAGE_BYTES},
};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};
use tower_http::{limit::RequestBodyLimitLayer, services::ServeDir};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum ServerEvent {
    PairingRequested { request: PendingPairing },
    DevicePaired { device: PairedDevice },
    DeviceConnected { device_id: String, name: String },
    DeviceDisconnected { device_id: String },
}

#[derive(Debug, Clone)]
pub struct InboundCommand {
    pub device_id: String,
    pub command: RemoteCommand,
}

pub struct ServerConfig {
    pub bind_ip: IpAddr,
    pub port: u16,
    pub static_dir: Option<PathBuf>,
    pub pairing: Arc<Mutex<PairingManager>>,
    pub commands: mpsc::Sender<InboundCommand>,
    pub events: mpsc::Sender<ServerEvent>,
    pub status: watch::Receiver<serde_json::Value>,
}

#[derive(Clone)]
struct AppState {
    host: String,
    pairing: Arc<Mutex<PairingManager>>,
    commands: mpsc::Sender<InboundCommand>,
    events: mpsc::Sender<ServerEvent>,
    status: watch::Receiver<serde_json::Value>,
    pair_limiter: Arc<Mutex<RateLimiter>>,
    /// Flips to true when the server is stopped: open sessions close at once.
    stopped: watch::Receiver<bool>,
}

pub struct ServerHandle {
    pub addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Stops accepting connections and disconnects every connected phone.
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
    }
}

/// Picks the machine's private LAN IPv4, falling back to loopback.
pub fn default_bind_ip() -> IpAddr {
    match local_ip_address::local_ip() {
        Ok(IpAddr::V4(v4)) if v4.is_private() => IpAddr::V4(v4),
        _ => IpAddr::from([127, 0, 0, 1]),
    }
}

pub fn is_allowed_bind(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

pub async fn start(cfg: ServerConfig) -> std::io::Result<ServerHandle> {
    if !is_allowed_bind(cfg.bind_ip) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "remote server may only bind to a private LAN or loopback address"));
    }
    let listener = tokio::net::TcpListener::bind((cfg.bind_ip, cfg.port)).await?;
    let addr = listener.local_addr()?;
    let (shutdown, stopped) = watch::channel(false);
    let state = AppState {
        host: addr.to_string(),
        pairing: cfg.pairing,
        commands: cfg.commands,
        events: cfg.events,
        status: cfg.status,
        pair_limiter: Arc::new(Mutex::new(RateLimiter::new(10, 1, now_ms()))),
        stopped: stopped.clone(),
    };

    let mut app = Router::new()
        .route("/api/health", get(|| async { Json(serde_json::json!({ "ok": true, "app": "MonitorOS" })) }))
        .route("/api/pair/request", post(pair_request))
        .route("/api/pair/complete", post(pair_complete))
        .route("/ws", get(ws_upgrade));
    if let Some(dir) = cfg.static_dir {
        app = app.fallback_service(ServeDir::new(dir).append_index_html_on_directories(true));
    }
    let app = app
        .layer(RequestBodyLimitLayer::new(4096))
        .layer(middleware::from_fn_with_state(state.clone(), guard_host_origin))
        .layer(middleware::from_fn(security_headers))
        .with_state(state);

    let mut on_stop = stopped;
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = on_stop.wait_for(|s| *s).await;
            })
            .await;
    });
    Ok(ServerHandle { addr, shutdown, task })
}

async fn security_headers(req: Request<Body>, next: Next) -> Response {
    // index.html / manifest aren't content-hashed: make iOS revalidate them so
    // the phone never keeps running an old remote after MonitorOS updates.
    // Vite's /assets/* files are hashed and can be cached for good.
    let cache = if req.uri().path().starts_with("/assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, cache.parse().unwrap());
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    h.insert("x-frame-options", "DENY".parse().unwrap());
    h.insert("referrer-policy", "no-referrer".parse().unwrap());
    h.insert(
        "content-security-policy",
        "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'".parse().unwrap(),
    );
    res
}

/// DNS-rebinding + cross-site defence.
pub fn host_origin_ok(headers: &HeaderMap, bound_host: &str, needs_origin: bool) -> bool {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !host.eq_ignore_ascii_case(bound_host) {
        return false;
    }
    match headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        Some(origin) => origin.eq_ignore_ascii_case(&format!("http://{bound_host}")) || origin.eq_ignore_ascii_case(&format!("https://{bound_host}")),
        None => !needs_origin,
    }
}

async fn guard_host_origin(State(s): State<AppState>, req: Request<Body>, next: Next) -> Response {
    let needs_origin = req.method() != axum::http::Method::GET || req.uri().path() == "/ws";
    if !host_origin_ok(req.headers(), &s.host, needs_origin) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    next.run(req).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairRequestBody {
    device_name: String,
    /// From the TV's QR code (scan to pair).
    #[serde(default)]
    ticket: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairCompleteBody {
    request_id: String,
    code: String,
}

fn pairing_status(e: &PairingError) -> StatusCode {
    match e {
        PairingError::NotApproved => StatusCode::ACCEPTED,
        PairingError::NotFound => StatusCode::NOT_FOUND,
        PairingError::WrongCode => StatusCode::UNAUTHORIZED,
        PairingError::TooManyAttempts | PairingError::Busy => StatusCode::TOO_MANY_REQUESTS,
        PairingError::InvalidName => StatusCode::BAD_REQUEST,
        PairingError::BadTicket => StatusCode::GONE,
    }
}

async fn pair_request(State(s): State<AppState>, Json(body): Json<PairRequestBody>) -> Response {
    if !s.pair_limiter.lock().unwrap().allow(now_ms()) {
        return (StatusCode::TOO_MANY_REQUESTS, "slow down").into_response();
    }
    let result = match &body.ticket {
        Some(t) => s.pairing.lock().unwrap().request_scanned(&body.device_name, t, now_ms()),
        None => s.pairing.lock().unwrap().request(&body.device_name, now_ms()),
    };
    match result {
        Ok(p) => {
            let _ = s.events.send(ServerEvent::PairingRequested { request: p.clone() }).await;
            // The code is NOT returned to the phone: the user reads it off the
            // TV (or, scanned, the phone already holds it as its ticket).
            Json(serde_json::json!({ "requestId": p.request_id, "expiresInSec": 120, "scanned": p.scanned })).into_response()
        }
        Err(e) => (pairing_status(&e), e.to_string()).into_response(),
    }
}

async fn pair_complete(State(s): State<AppState>, Json(body): Json<PairCompleteBody>) -> Response {
    let result = s.pairing.lock().unwrap().complete(&body.request_id, &body.code, now_ms());
    match result {
        Ok((device, token)) => {
            let _ = s.events.send(ServerEvent::DevicePaired { device: device.clone() }).await;
            Json(serde_json::json!({ "token": token, "deviceId": device.id, "expiresMs": device.expires_ms })).into_response()
        }
        Err(e) => (pairing_status(&e), e.to_string()).into_response(),
    }
}

async fn ws_upgrade(State(s): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_MESSAGE_BYTES).max_frame_size(MAX_MESSAGE_BYTES).on_upgrade(move |socket| ws_session(s, socket))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthMessage {
    auth: String,
}

async fn ws_session(s: AppState, socket: WebSocket) {
    let (mut tx, mut rx) = socket.split();

    // 1. Authenticate within 5 s. Only a token we don't know is a rejection
    // (the phone then forgets it); a slow or broken socket just closes, so a
    // flaky Wi-Fi moment never costs the phone its pairing.
    let auth = match tokio::time::timeout(Duration::from_secs(5), rx.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<AuthMessage>(&t).ok(),
        _ => None,
    };
    let Some(auth) = auth else {
        let _ = tx.close().await;
        return;
    };
    let Some(device) = s.pairing.lock().unwrap().authenticate(&auth.auth, now_ms()) else {
        let _ = tx.send(Message::Text(r#"{"type":"auth","ok":false}"#.into())).await;
        let _ = tx.close().await;
        return;
    };
    let _ = tx.send(Message::Text(serde_json::json!({ "type": "auth", "ok": true, "deviceId": device.id }).to_string())).await;
    let _ = s.events.send(ServerEvent::DeviceConnected { device_id: device.id.clone(), name: device.name.clone() }).await;

    let mut replay = ReplayGuard::default();
    let mut limiter = RateLimiter::new(60, 40, now_ms()); // touchpad cursor sends ~25 msgs/s
    let mut status = s.status.clone();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    let mut last_pong = tokio::time::Instant::now();
    let mut stopped = s.stopped.clone();

    loop {
        tokio::select! {
            msg = rx.next() => {
                let Some(Ok(msg)) = msg else { break };
                let text = match msg {
                    Message::Text(t) => t,
                    Message::Pong(_) => { last_pong = tokio::time::Instant::now(); continue }
                    Message::Close(_) => break,
                    _ => continue,
                };
                // Re-check on every message: revocation, expiry and stopping
                // the server take effect immediately, even mid-session.
                if *s.stopped.borrow() || !s.pairing.lock().unwrap().is_active(&device.id, now_ms()) {
                    break;
                }
                let ack = match parse_envelope(&text) {
                    Err(e) => RemoteAck { seq: 0, ok: false, error: Some(e.to_string()) },
                    Ok(env) => {
                        if !limiter.allow(now_ms()) {
                            RemoteAck { seq: env.seq, ok: false, error: Some("rate limited".into()) }
                        } else if let Err(e) = replay.check(env.seq) {
                            RemoteAck { seq: env.seq, ok: false, error: Some(e.to_string()) }
                        } else if matches!(env.command, RemoteCommand::Ping) {
                            RemoteAck { seq: env.seq, ok: true, error: None }
                        } else {
                            let ok = s.commands.send(InboundCommand { device_id: device.id.clone(), command: env.command }).await.is_ok();
                            RemoteAck { seq: env.seq, ok, error: (!ok).then(|| "app not ready".into()) }
                        }
                    }
                };
                let msg = serde_json::json!({ "type": "ack", "seq": ack.seq, "ok": ack.ok, "error": ack.error });
                if tx.send(Message::Text(msg.to_string())).await.is_err() { break }
            }
            res = stopped.changed() => {
                let stop = res.is_err() || *stopped.borrow();
                if stop {
                    let _ = tx.send(Message::Close(None)).await;
                    break;
                }
            }
            changed = status.changed() => {
                if changed.is_err() { break }
                let v = status.borrow_and_update().clone();
                if tx.send(Message::Text(serde_json::json!({ "type": "status", "status": v }).to_string())).await.is_err() { break }
            }
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > Duration::from_secs(45) { break }
                if tx.send(Message::Ping(Vec::new())).await.is_err() { break }
            }
        }
    }
    let _ = s.events.send(ServerEvent::DeviceDisconnected { device_id: device.id }).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bind_policy() {
        assert!(is_allowed_bind("192.168.1.10".parse().unwrap()));
        assert!(is_allowed_bind("127.0.0.1".parse().unwrap()));
        assert!(!is_allowed_bind("0.0.0.0".parse().unwrap()));
        assert!(!is_allowed_bind("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn host_and_origin_checks() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "192.168.1.10:8765".parse().unwrap());
        assert!(host_origin_ok(&h, "192.168.1.10:8765", false));
        assert!(!host_origin_ok(&h, "192.168.1.10:8765", true)); // origin required
        h.insert(header::ORIGIN, "http://192.168.1.10:8765".parse().unwrap());
        assert!(host_origin_ok(&h, "192.168.1.10:8765", true));
        h.insert(header::ORIGIN, "http://evil.example.com".parse().unwrap());
        assert!(!host_origin_ok(&h, "192.168.1.10:8765", true));
        let mut rebind = HeaderMap::new();
        rebind.insert(header::HOST, "evil.example.com:8765".parse().unwrap());
        assert!(!host_origin_ok(&rebind, "192.168.1.10:8765", false));
    }
}
