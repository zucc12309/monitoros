//! Local multiplayer: paired phones become Dolphin controllers.
//!
//! A phone joins with `game join`; its player slot is bound to its
//! authenticated device ID (never chosen by the phone). Pad updates drive
//! only that slot through the loopback DSU bridge. A dropped connection
//! releases the pad at once and keeps the slot for 30 s; revoking the phone
//! frees it.

use crate::{merge_status, AppState};
use gamepad_bridge::{proto::PadState, Bridge, DEFAULT_PORT};
use gaming_core::{dolphin, PadEffect, Slots};
use monitoros_core::remote::{GameAction, RemoteCommand};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

const GAME_FILE_KEY: &str = "gameFile";

#[derive(Default)]
pub struct Games {
    slots: Mutex<Slots>,
    bridge: Mutex<Option<Bridge>>,
    /// Open remote connections per device (a reconnect can overlap the old one).
    sockets: Mutex<HashMap<String, usize>>,
    dolphin: Mutex<Option<Child>>,
    error: Mutex<Option<String>>,
}

impl Games {
    fn apply(&self, effects: Vec<PadEffect>) {
        let bridge = self.bridge.lock().unwrap();
        let Some(b) = bridge.as_ref() else { return };
        for e in effects {
            match e {
                PadEffect::Connect(i) => b.set_connected(i, true),
                PadEffect::Release(i) => b.release(i),
                PadEffect::Disconnect(i) => b.set_connected(i, false),
            }
        }
    }

    fn running(&self) -> bool {
        let mut d = self.dolphin.lock().unwrap();
        if let Some(child) = d.as_mut() {
            if !matches!(child.try_wait(), Ok(None)) {
                *d = None;
            }
        }
        d.is_some()
    }
}

/// Pushes the player list to the TV UI and every phone.
fn publish(state: &AppState) {
    let g = &state.games;
    let players = g.slots.lock().unwrap().view();
    let running = g.running();
    let error = g.error.lock().unwrap().clone();
    merge_status(state, serde_json::json!({ "game": { "players": players, "running": running, "error": error } }));
}

/// Starts the DSU server on first use (it holds a UDP port, so not before).
async fn ensure_bridge(app: &AppHandle) -> bool {
    let state: State<AppState> = app.state();
    if state.games.bridge.lock().unwrap().is_some() {
        return true;
    }
    match Bridge::start(DEFAULT_PORT).await {
        Ok(b) => {
            let mut slot = state.games.bridge.lock().unwrap();
            if slot.is_none() {
                *slot = Some(b);
                drop(slot);
                *state.games.error.lock().unwrap() = None;
                // Expire reservations and notice Dolphin exiting.
                let a = app.clone();
                tauri::async_runtime::spawn(async move {
                    let mut was_running = false;
                    loop {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        let state: State<AppState> = a.state();
                        let effects = state.games.slots.lock().unwrap().expire(Instant::now());
                        let running = state.games.running();
                        if !effects.is_empty() || running != was_running {
                            state.games.apply(effects);
                            publish(&state);
                        }
                        was_running = running;
                    }
                });
            } else {
                b.stop();
            }
            true
        }
        Err(e) => {
            tracing::warn!("controller bridge: {e}");
            *state.games.error.lock().unwrap() = Some("Another program is using the controller port (26760). Close it and try again.".into());
            publish(&state);
            false
        }
    }
}

pub fn is_game_command(c: &RemoteCommand) -> bool {
    matches!(c, RemoteCommand::Game { .. } | RemoteCommand::Pad { .. })
}

pub async fn handle(app: &AppHandle, device_id: &str, command: RemoteCommand) {
    let state: State<AppState> = app.state();
    match command {
        RemoteCommand::Game { action: GameAction::Join } => {
            if !ensure_bridge(app).await {
                return;
            }
            let name = state.pairing.lock().unwrap().devices().into_iter().find(|d| d.id == device_id).map(|d| d.name).unwrap_or_else(|| "Phone".into());
            let result = state.games.slots.lock().unwrap().join(device_id, &name, Instant::now());
            match result {
                Ok((player, effects)) => {
                    tracing::info!(player, "game: player joined");
                    state.games.apply(effects);
                }
                Err(e) => tracing::info!("game: join refused: {e}"),
            }
            publish(&state);
        }
        RemoteCommand::Game { action: GameAction::Leave } => {
            let effects = state.games.slots.lock().unwrap().leave(device_id);
            state.games.apply(effects);
            publish(&state);
        }
        RemoteCommand::Pad { buttons, lx, ly } => {
            // Only the slot this device owns; input from anyone else is dropped.
            let Ok(slot) = state.games.slots.lock().unwrap().slot_for(device_id) else { return };
            if let Some(b) = state.games.bridge.lock().unwrap().as_ref() {
                b.set_state(slot, PadState { buttons, left: (lx as f32, ly as f32), ..PadState::neutral() });
            }
        }
        _ => {}
    }
}

pub fn device_connected(state: &AppState, device_id: &str) {
    *state.games.sockets.lock().unwrap().entry(device_id.to_string()).or_default() += 1;
}

/// The last connection of a device closed: release its pad, keep the slot.
pub fn device_disconnected(state: &AppState, device_id: &str) {
    let mut sockets = state.games.sockets.lock().unwrap();
    let n = sockets.entry(device_id.to_string()).or_default();
    *n = n.saturating_sub(1);
    if *n > 0 {
        return;
    }
    sockets.remove(device_id);
    drop(sockets);
    let effects = state.games.slots.lock().unwrap().disconnected(device_id, Instant::now());
    if !effects.is_empty() {
        state.games.apply(effects);
        publish(state);
    }
}

pub fn device_revoked(state: &AppState, device_id: &str) {
    let effects = state.games.slots.lock().unwrap().leave(device_id);
    state.games.apply(effects);
    publish(state);
}

// ---------- TV UI commands ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    dolphin_version: Option<String>,
    dolphin_error: Option<String>,
    game_file: Option<String>,
    running: bool,
    players: Vec<gaming_core::SlotView>,
    error: Option<String>,
}

fn game_file(state: &AppState) -> Option<PathBuf> {
    state.store.lock().unwrap().get_setting::<String>(GAME_FILE_KEY).ok().flatten().map(PathBuf::from)
}

#[tauri::command]
pub fn game_info(state: State<'_, AppState>) -> GameInfo {
    let (dolphin_version, dolphin_error) = match dolphin::detect() {
        Ok(i) => (Some(i.version), None),
        Err(e) => (None, Some(e.to_string())),
    };
    GameInfo {
        dolphin_version,
        dolphin_error,
        game_file: game_file(&state).and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())),
        running: state.games.running(),
        players: state.games.slots.lock().unwrap().view(),
        error: state.games.error.lock().unwrap().clone(),
    }
}

/// The user picked a game file in the TV's file dialog.
#[tauri::command]
pub fn game_set_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let path = dolphin::validate_game(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    state.store.lock().unwrap().set_setting(GAME_FILE_KEY, &path.to_string_lossy(), monitoros_core::now_ms() as i64).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn game_launch(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.games.running() {
        return Ok(());
    }
    let install = dolphin::detect().map_err(|e| e.to_string())?;
    let file = game_file(&state).ok_or("Choose a game file first")?;
    if !ensure_bridge(&app).await {
        return Err(state.games.error.lock().unwrap().clone().unwrap_or_default());
    }
    dolphin::configure(&install.config_dir).map_err(|e| e.to_string())?;
    let child = dolphin::launch(&install, &file).map_err(|e| e.to_string())?;
    tracing::info!(version = install.version, "game: Dolphin started");
    *state.games.dolphin.lock().unwrap() = Some(child);
    publish(&state);
    Ok(())
}

#[tauri::command]
pub fn game_stop(state: State<'_, AppState>) {
    if let Some(mut child) = state.games.dolphin.lock().unwrap().take() {
        // Ask politely first so Dolphin can finish writing saves.
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("kill").arg("-TERM").arg(child.id().to_string()).status();
            for _ in 0..30 {
                if !matches!(child.try_wait(), Ok(None)) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    publish(&state);
}

/// Host action: remove a player from the TV.
#[tauri::command]
pub fn game_remove_player(state: State<'_, AppState>, player: usize) {
    let effects = state.games.slots.lock().unwrap().remove_player(player);
    state.games.apply(effects);
    publish(&state);
}
