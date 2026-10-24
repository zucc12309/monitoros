//! End-to-end tests against a real server bound to 127.0.0.1: pairing,
//! authenticated WebSocket, replay protection, origin/host attacks.

use futures_util::{SinkExt, StreamExt};
use monitoros_core::pairing::PairingManager;
use remote_server::{start, ServerConfig, ServerEvent};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

struct Harness {
    url: String,
    host: String,
    pairing: Arc<Mutex<PairingManager>>,
    events: mpsc::Receiver<ServerEvent>,
    commands: mpsc::Receiver<remote_server::InboundCommand>,
    _status: watch::Sender<serde_json::Value>,
    _handle: remote_server::ServerHandle,
}

async fn harness() -> Harness {
    let pairing = Arc::new(Mutex::new(PairingManager::default()));
    let (ctx, crx) = mpsc::channel(32);
    let (etx, erx) = mpsc::channel(32);
    let (stx, srx) = watch::channel(serde_json::json!({ "mode": "tv" }));
    let handle = start(ServerConfig { bind_ip: "127.0.0.1".parse().unwrap(), port: 0, static_dir: None, pairing: pairing.clone(), commands: ctx, events: etx, status: srx })
        .await
        .unwrap();
    Harness { url: handle.url(), host: handle.addr.to_string(), pairing, events: erx, commands: crx, _status: stx, _handle: handle }
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn pair(h: &mut Harness) -> String {
    let c = client();
    let origin = h.url.clone();
    let res: serde_json::Value = c.post(format!("{}/api/pair/request", h.url)).header("origin", &origin).json(&serde_json::json!({ "deviceName": "Test iPhone" })).send().await.unwrap().json().await.unwrap();
    let request_id = res["requestId"].as_str().unwrap().to_string();
    assert!(res.get("code").is_none(), "code must not be sent to the phone");

    let code = match h.events.recv().await.unwrap() {
        ServerEvent::PairingRequested { request } => request.code,
        other => panic!("unexpected {other:?}"),
    };
    // Before approval → 202
    let r = c.post(format!("{}/api/pair/complete", h.url)).header("origin", &origin).json(&serde_json::json!({ "requestId": request_id, "code": code })).send().await.unwrap();
    assert_eq!(r.status(), 202);
    h.pairing.lock().unwrap().approve(&request_id, monitoros_core::now_ms()).unwrap();
    let r = c.post(format!("{}/api/pair/complete", h.url)).header("origin", &origin).json(&serde_json::json!({ "requestId": request_id, "code": "000000" })).send().await.unwrap();
    assert!(r.status() == 401 || code == "000000");
    let r: serde_json::Value = c.post(format!("{}/api/pair/complete", h.url)).header("origin", &origin).json(&serde_json::json!({ "requestId": request_id, "code": code })).send().await.unwrap().json().await.unwrap();
    r["token"].as_str().unwrap().to_string()
}

async fn ws(h: &Harness, origin: &str) -> Result<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Box<tokio_tungstenite::tungstenite::Error>> {
    let mut req = format!("ws://{}/ws", h.host).into_client_request().unwrap();
    req.headers_mut().insert("origin", origin.parse().unwrap());
    tokio_tungstenite::connect_async(req).await.map(|(s, _)| s).map_err(Box::new)
}

async fn next_json<S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin>(s: &mut S) -> serde_json::Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(3), s.next()).await.unwrap().unwrap().unwrap() {
            Message::Text(t) => {
                let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                if v["type"] != "status" {
                    return v;
                }
            }
            _ => continue,
        }
    }
}

#[tokio::test]
async fn pair_connect_command_and_replay() {
    let mut h = harness().await;
    let token = pair(&mut h).await;
    let mut s = ws(&h, &h.url.clone()).await.unwrap();
    s.send(Message::Text(serde_json::json!({ "auth": token }).to_string())).await.unwrap();
    assert_eq!(next_json(&mut s).await["ok"], true);

    s.send(Message::Text(r#"{"seq":1,"sentAt":0,"command":{"type":"nav","key":"down"}}"#.into())).await.unwrap();
    assert_eq!(next_json(&mut s).await["ok"], true);
    let cmd = tokio::time::timeout(Duration::from_secs(2), h.commands.recv()).await.unwrap().unwrap();
    assert_eq!(format!("{:?}", cmd.command), "Nav { key: Down }");

    // replay
    s.send(Message::Text(r#"{"seq":1,"sentAt":0,"command":{"type":"nav","key":"down"}}"#.into())).await.unwrap();
    let ack = next_json(&mut s).await;
    assert_eq!(ack["ok"], false);
    assert!(ack["error"].as_str().unwrap().contains("replay"));

    // injected command type
    s.send(Message::Text(r#"{"seq":2,"sentAt":0,"command":{"type":"exec","cmd":"open -a Calculator"}}"#.into())).await.unwrap();
    assert_eq!(next_json(&mut s).await["ok"], false);
    assert!(h.commands.try_recv().is_err());
}

#[tokio::test]
async fn invalid_token_is_rejected() {
    let h = harness().await;
    let mut s = ws(&h, &h.url.clone()).await.unwrap();
    s.send(Message::Text(r#"{"auth":"forged-token"}"#.into())).await.unwrap();
    assert_eq!(next_json(&mut s).await["ok"], false);
}

#[tokio::test]
async fn revoked_device_is_disconnected() {
    let mut h = harness().await;
    let token = pair(&mut h).await;
    let mut s = ws(&h, &h.url.clone()).await.unwrap();
    s.send(Message::Text(serde_json::json!({ "auth": token }).to_string())).await.unwrap();
    assert_eq!(next_json(&mut s).await["ok"], true);
    let id = h.pairing.lock().unwrap().devices()[0].id.clone();
    h.pairing.lock().unwrap().revoke(&id);
    s.send(Message::Text(r#"{"seq":1,"sentAt":0,"command":{"type":"nav","key":"up"}}"#.into())).await.unwrap();
    let next = tokio::time::timeout(Duration::from_secs(3), s.next()).await.unwrap();
    assert!(matches!(next, None | Some(Ok(Message::Close(_))) | Some(Err(_))), "expected close, got {next:?}");
    assert!(h.commands.try_recv().is_err());
}

#[tokio::test]
async fn cross_origin_websocket_is_refused() {
    let h = harness().await;
    assert!(ws(&h, "http://evil.example.com").await.is_err());
}

#[tokio::test]
async fn dns_rebinding_host_is_refused() {
    let h = harness().await;
    let r = client().get(format!("{}/api/health", h.url)).header("host", format!("rebind.example.com:{}", h.host.split(':').nth(1).unwrap())).send().await.unwrap();
    assert_eq!(r.status(), 403);
    let ok = client().get(format!("{}/api/health", h.url)).send().await.unwrap();
    assert_eq!(ok.status(), 200);
}

#[tokio::test]
async fn cross_site_post_is_refused() {
    let h = harness().await;
    let r = client().post(format!("{}/api/pair/request", h.url)).header("origin", "http://evil.example.com").json(&serde_json::json!({ "deviceName": "x" })).send().await.unwrap();
    assert_eq!(r.status(), 403);
    let r = client().post(format!("{}/api/pair/request", h.url)).json(&serde_json::json!({ "deviceName": "x" })).send().await.unwrap();
    assert_eq!(r.status(), 403, "missing origin on POST must be refused");
}

#[tokio::test]
async fn oversized_body_is_refused() {
    let h = harness().await;
    let r = client().post(format!("{}/api/pair/request", h.url)).header("origin", &h.url).json(&serde_json::json!({ "deviceName": "x".repeat(10_000) })).send().await.unwrap();
    assert_eq!(r.status(), 413);
}

#[tokio::test]
async fn pwa_page_is_never_served_stale() {
    let dir = std::env::temp_dir().join(format!("mo-pwa-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html>remote").unwrap();
    std::fs::write(dir.join("assets/app-abc123.js"), "1").unwrap();
    let pairing = Arc::new(Mutex::new(PairingManager::default()));
    let (ctx, _crx) = mpsc::channel(4);
    let (etx, _erx) = mpsc::channel(4);
    let (_stx, srx) = watch::channel(serde_json::json!({}));
    let h = start(ServerConfig { bind_ip: "127.0.0.1".parse().unwrap(), port: 0, static_dir: Some(dir.clone()), pairing, commands: ctx, events: etx, status: srx }).await.unwrap();
    let page = client().get(format!("{}/", h.url())).send().await.unwrap();
    assert_eq!(page.headers()["cache-control"], "no-cache");
    let asset = client().get(format!("{}/assets/app-abc123.js", h.url())).send().await.unwrap();
    assert!(asset.headers()["cache-control"].to_str().unwrap().contains("immutable"));
    std::fs::remove_dir_all(dir).ok();
}
