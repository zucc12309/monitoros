//! Bridges the LAN remote server to the app: pairing events go to the UI,
//! commands are dispatched natively where possible (mode, volume, closing a
//! service window) and forwarded to the UI for navigation.

use crate::routing::{route, Front, Native, Route};
use crate::{apply_mode, services, toggle_mode, AppState};
use monitoros_core::{
    now_ms,
    remote::{ModeTarget, VolumeAction},
    Mode,
};
use remote_server::{InboundCommand, ServerConfig, ServerEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub const REMOTE_PORT: u16 = 47815;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    running: bool,
    url: Option<String>,
    bind_ip: Option<String>,
}

#[tauri::command]
pub async fn remote_info(state: State<'_, AppState>) -> Result<RemoteInfo, String> {
    let g = state.remote.lock().await;
    Ok(match g.as_ref() {
        Some(h) => RemoteInfo { running: true, url: Some(h.url()), bind_ip: Some(h.addr.ip().to_string()) },
        None => RemoteInfo { running: false, url: None, bind_ip: None },
    })
}

fn persist_devices(state: &AppState) {
    let devices = state.pairing.lock().unwrap().devices();
    let pairs: Vec<(String, _)> = devices.into_iter().map(|d| (d.id.clone(), d)).collect();
    let _ = state.store.lock().unwrap().save_devices(&pairs);
}

fn dispatch(app: &AppHandle, c: InboundCommand) {
    let state: State<AppState> = app.state();
    let front = crate::front(app, &state);
    match route(&c.command, front, crate::other_apps_allowed(&state)) {
        Route::Native(Native::Mode(target)) => match target {
            ModeTarget::Tv => apply_mode(app, Mode::Tv),
            ModeTarget::Desktop => apply_mode(app, Mode::Desktop),
            ModeTarget::Toggle => toggle_mode(app),
        },
        Route::Native(Native::Volume(action)) => {
            let p = &state.platform;
            let _ = match action {
                VolumeAction::Mute => p.is_muted().and_then(|m| p.set_muted(!m)),
                VolumeAction::Up => p.volume().and_then(|v| p.set_volume(v.saturating_add(5).min(100))),
                VolumeAction::Down => p.volume().and_then(|v| p.set_volume(v.saturating_sub(5))),
            };
        }
        Route::Native(Native::Home) => {
            services::close(app);
            apply_mode(app, Mode::Tv);
        }
        Route::Native(Native::Fullscreen) => match front {
            Front::MonitorOs => toggle_mode(app),
            Front::ServicePage => services::toggle_fullscreen(app),
            Front::OtherApp => {
                state.input.send(&c.command);
            }
        },
        Route::Page => {
            services::forward(app, &c.command);
        }
        Route::System => {
            let granted = crate::input::permitted();
            crate::merge_status(&state, serde_json::json!({ "mouse": if granted { "system" } else { "needs-permission" } }));
            if !(granted && state.input.send(&c.command)) {
                state.input.request_permission_once();
                // Without OS input, the in-app page can still use its own cursor.
                if front == Front::ServicePage {
                    services::forward(app, &c.command);
                }
            }
        }
        Route::Ui => {
            let _ = app.emit("remote://command", &c.command);
        }
        Route::Drop => {}
    }
}

#[tauri::command]
pub async fn remote_start(app: AppHandle, state: State<'_, AppState>) -> Result<RemoteInfo, String> {
    let mut guard = state.remote.lock().await;
    if guard.is_none() {
        let (ctx, mut crx) = tokio::sync::mpsc::channel::<InboundCommand>(64);
        let (etx, mut erx) = tokio::sync::mpsc::channel::<ServerEvent>(32);
        let static_dir = app.path().resource_dir().ok().map(|d| d.join("remote")).filter(|d| d.join("index.html").is_file()).or_else(|| {
            // dev: serve the built PWA straight from the repo
            let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../remote/dist");
            dev.join("index.html").is_file().then_some(dev)
        });
        let cfg = ServerConfig {
            bind_ip: remote_server::default_bind_ip(),
            port: REMOTE_PORT,
            static_dir,
            pairing: state.pairing.clone(),
            commands: ctx,
            events: etx,
            status: state.status.subscribe(),
        };
        let handle = match remote_server::start(cfg).await {
            Ok(h) => h,
            Err(_) => {
                // Port busy: let the OS pick one.
                let (ctx2, crx2) = tokio::sync::mpsc::channel(64);
                let (etx2, erx2) = tokio::sync::mpsc::channel(32);
                crx = crx2;
                erx = erx2;
                remote_server::start(ServerConfig { bind_ip: remote_server::default_bind_ip(), port: 0, static_dir: None, pairing: state.pairing.clone(), commands: ctx2, events: etx2, status: state.status.subscribe() })
                    .await
                    .map_err(|e| e.to_string())?
            }
        };
        let a = app.clone();
        tokio::spawn(async move {
            while let Some(c) = crx.recv().await {
                dispatch(&a, c);
            }
        });
        let a = app.clone();
        tokio::spawn(async move {
            while let Some(ev) = erx.recv().await {
                if matches!(ev, ServerEvent::DevicePaired { .. }) {
                    persist_devices(&a.state::<AppState>());
                }
                let _ = a.emit("remote://event", &ev);
            }
        });
        *guard = Some(handle);
    }
    drop(guard);
    remote_info(state).await
}

#[tauri::command]
pub async fn remote_stop(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(h) = state.remote.lock().await.take() {
        h.stop().await;
    }
    Ok(())
}

#[tauri::command]
pub fn remote_status(state: State<'_, AppState>, status: serde_json::Value) {
    crate::merge_status(&state, status);
}

#[tauri::command]
pub fn pairing_approve(state: State<'_, AppState>, request_id: String) -> Result<(), String> {
    state.pairing.lock().unwrap().approve(&request_id, now_ms()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pairing_deny(state: State<'_, AppState>, request_id: String) {
    state.pairing.lock().unwrap().deny(&request_id);
}

#[tauri::command]
pub fn devices_list(state: State<'_, AppState>) -> Vec<serde_json::Value> {
    state
        .pairing
        .lock()
        .unwrap()
        .devices()
        .into_iter()
        .map(|d| serde_json::json!({ "id": d.id, "name": d.name, "pairedMs": d.paired_ms, "expiresMs": d.expires_ms, "lastSeenMs": d.last_seen_ms }))
        .collect()
}

#[tauri::command]
pub fn device_revoke(state: State<'_, AppState>, id: String) {
    state.pairing.lock().unwrap().revoke(&id);
    persist_devices(&state);
}
