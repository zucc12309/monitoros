//! Tauri commands. Every argument from the WebView is treated as untrusted:
//! URLs are re-validated here, local paths must resolve inside a library
//! root, and nothing reaches a shell.

use crate::{apply_mode, services, AppState};
use media_engine::{library, MpvEvent, MpvSession, PlayOptions, PlayerCommand};
use monitoros_core::{now_ms, platform::{AudioDevice, DisplayInfo}, Mode};
use provider_runtime::{guarded_get_json, guarded_get_text, Egress};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

type CmdResult<T> = Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

const KEY_RE_MAX: usize = 64;
const ALLOWED_KEYS: &[&str] = &["settings", "watchlist", "progress", "addons", "catalog-cache"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    os: String,
    arch: String,
    native: bool,
    mpv_path: Option<String>,
    notes: Vec<String>,
    can_switch_audio_output: bool,
    can_set_volume: bool,
    chromium_app_window: bool,
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    let caps = state.platform.capabilities();
    let mut notes = caps.notes.clone();
    if state.mpv_path.is_none() {
        notes.push(if cfg!(windows) { "mpv not found: install it with `winget install mpv` or scoop, or place mpv.exe next to MonitorOS.".into() } else { "mpv not found: install it with `brew install mpv`.".into() });
    }
    AppInfo {
        version: app.package_info().version.to_string(),
        os: caps.os,
        arch: caps.arch,
        native: true,
        mpv_path: state.mpv_path.as_ref().map(|p| p.display().to_string()),
        notes,
        can_switch_audio_output: caps.can_switch_audio_output,
        can_set_volume: caps.can_set_volume,
        chromium_app_window: services::find_chromium().is_some(),
    }
}

#[tauri::command]
pub async fn provider_fetch_json(url: String, timeout_ms: u64) -> CmdResult<serde_json::Value> {
    guarded_get_json(&url, Duration::from_millis(timeout_ms.clamp(1000, 20_000))).await.map_err(err)
}

#[tauri::command]
pub async fn provider_fetch_text(url: String, allow_private_network: bool) -> CmdResult<String> {
    let egress = if allow_private_network { Egress::UserLan } else { Egress::Strict };
    guarded_get_text(&url, Duration::from_secs(15), egress).await.map_err(err)
}

fn https_only(url: &str) -> CmdResult<()> {
    provider_runtime::check_url(url).map(|_| ()).map_err(err)
}

#[tauri::command]
pub fn open_external(url: String) -> CmdResult<()> {
    https_only(&url)?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(err)
}

#[tauri::command]
pub fn open_service(app: AppHandle, state: State<'_, AppState>, url: String, mode: services::OpenMode) -> CmdResult<&'static str> {
    https_only(&url)?;
    let how = services::open(&app, &url, mode)?;
    crate::merge_status(&state, serde_json::json!({ "service": { "open": true } }));
    if how == "browser" {
        // A normal browser tab doesn't open full screen; once it is in front,
        // send the OS full-screen shortcut (Ctrl+Cmd+F / F11).
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            let state = tauri::Manager::state::<AppState>(&app2);
            if crate::front(&app2, &state) == crate::routing::Front::OtherApp {
                state.input.send_actions(vec![crate::input::fullscreen_combo()]);
            }
        });
    }
    Ok(how)
}

#[tauri::command]
pub fn close_service(app: AppHandle) -> bool {
    services::close(&app)
}

#[tauri::command]
pub fn set_mode(app: AppHandle, mode: Mode) {
    apply_mode(&app, mode);
}

// ---------- player ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayRequest {
    url: String,
    title: String,
    start_sec: Option<f64>,
    #[serde(default)]
    subtitle_urls: Vec<String>,
    audio_device: Option<String>,
    #[serde(default)]
    local_path: bool,
}

#[tauri::command]
pub async fn player_play(app: AppHandle, state: State<'_, AppState>, req: PlayRequest) -> CmdResult<()> {
    let mpv = state.mpv_path.clone().ok_or("mpv is not installed")?;
    let target = if req.local_path {
        let roots = state.store.lock().unwrap().library_roots().map_err(err)?;
        library::resolve_in_roots(&req.url, &roots).map_err(err)?.to_string_lossy().into_owned()
    } else {
        let lower = req.url.to_ascii_lowercase();
        if !(lower.starts_with("https://") || lower.starts_with("http://")) {
            return Err("only http(s) streams or library files can be played".into());
        }
        req.url
    };
    let hwdec: Option<String> = state.store.lock().unwrap().get_setting::<serde_json::Value>("settings").ok().flatten().and_then(|s| s["hwdec"].as_str().map(String::from));
    let opts = PlayOptions {
        title: Some(req.title),
        start_sec: req.start_sec,
        fullscreen: true,
        subtitle_urls: req.subtitle_urls.into_iter().filter(|s| s.starts_with("https://")).collect(),
        hwdec,
        audio_device: req.audio_device,
        cache_mib: Some(150),
        headless: false,
    };

    let mut guard = state.mpv.lock().await;
    if let Some(mut old) = guard.take() {
        old.stop().await;
    }
    let (session, mut rx) = MpvSession::spawn(&mpv, &target, &opts).await.map_err(err)?;
    let app2 = app.clone();
    tokio::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            let done = matches!(ev, MpvEvent::Exited { .. } | MpvEvent::Ended { .. });
            let _ = app2.emit("player://event", &ev);
            if done {
                break;
            }
        }
    });
    *guard = Some(session);
    drop(guard);

    // Detect process exit (user closed the mpv window) and report it.
    let app3 = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(750)).await;
            let state: State<AppState> = tauri::Manager::state(&app3);
            let mut g = state.mpv.lock().await;
            let Some(s) = g.as_mut() else { break };
            if s.is_running() {
                continue;
            }
            *g = None;
            let _ = app3.emit("player://event", MpvEvent::Exited { code: None });
            break;
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn player_command(state: State<'_, AppState>, cmd: PlayerCommand) -> CmdResult<serde_json::Value> {
    let guard = state.mpv.lock().await;
    let s = guard.as_ref().ok_or("nothing is playing")?;
    s.command(cmd).await.map_err(err)
}

#[tauri::command]
pub async fn player_stop(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(mut s) = state.mpv.lock().await.take() {
        s.stop().await;
    }
    Ok(())
}

// ---------- key/value state ----------

#[tauri::command]
pub fn store_get(state: State<'_, AppState>, key: String) -> CmdResult<Option<serde_json::Value>> {
    if key.len() > KEY_RE_MAX || !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err("unknown key".into());
    }
    state.store.lock().unwrap().get_setting(&key).map_err(err)
}

#[tauri::command]
pub fn store_set(state: State<'_, AppState>, key: String, value: serde_json::Value) -> CmdResult<()> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err("unknown key".into());
    }
    if value.to_string().len() > 4 * 1024 * 1024 {
        return Err("value too large".into());
    }
    state.store.lock().unwrap().set_setting(&key, &value, now_ms() as i64).map_err(err)
}

// ---------- library ----------

async fn scan_root(state: &State<'_, AppState>, root: String) -> CmdResult<Vec<library::LibraryItem>> {
    let r = root.clone();
    let items = tokio::task::spawn_blocking(move || library::scan(std::path::Path::new(&r))).await.map_err(err)?.map_err(err)?;
    let pairs: Vec<(String, &library::LibraryItem)> = items.iter().map(|i| (i.id.clone(), i)).collect();
    state.store.lock().unwrap().replace_library_items(&root, &pairs).map_err(err)?;
    Ok(items)
}

#[tauri::command]
pub async fn library_add_root(state: State<'_, AppState>, path: String) -> CmdResult<Vec<library::LibraryItem>> {
    let canon = library::validate_root(std::path::Path::new(&path)).map_err(err)?.to_string_lossy().into_owned();
    state.store.lock().unwrap().add_library_root(&canon, now_ms() as i64).map_err(err)?;
    scan_root(&state, canon).await
}

#[tauri::command]
pub fn library_remove_root(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    state.store.lock().unwrap().remove_library_root(&path, now_ms() as i64).map_err(err)
}

#[tauri::command]
pub fn library_roots(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    state.store.lock().unwrap().library_roots().map_err(err)
}

#[tauri::command]
pub fn library_items(state: State<'_, AppState>) -> CmdResult<Vec<serde_json::Value>> {
    state.store.lock().unwrap().library_items().map_err(err)
}

#[tauri::command]
pub async fn library_rescan(state: State<'_, AppState>) -> CmdResult<usize> {
    let roots = state.store.lock().unwrap().library_roots().map_err(err)?;
    let mut n = 0;
    for r in roots {
        n += scan_root(&state, r).await.map(|v| v.len()).unwrap_or(0);
    }
    Ok(n)
}

// ---------- display & audio ----------

#[tauri::command]
pub fn displays(state: State<'_, AppState>) -> CmdResult<Vec<DisplayInfo>> {
    state.platform.displays().map_err(err)
}

#[tauri::command]
pub fn audio_outputs(state: State<'_, AppState>) -> CmdResult<Vec<AudioDevice>> {
    state.platform.audio_outputs().map_err(err)
}

#[derive(Serialize)]
pub struct MpvAudioDevice {
    name: String,
    description: String,
}

/// Parses `mpv --audio-device=help`:  'coreaudio/BuiltInSpeakerDevice' (MacBook Air Speakers)
pub fn parse_mpv_audio_devices(out: &str) -> Vec<MpvAudioDevice> {
    out.lines()
        .filter_map(|l| {
            let l = l.trim();
            let rest = l.strip_prefix('\'')?;
            let (name, tail) = rest.split_once('\'')?;
            let desc = tail.trim().trim_start_matches('(').trim_end_matches(')').to_string();
            Some(MpvAudioDevice { name: name.to_string(), description: if desc.is_empty() { name.to_string() } else { desc } })
        })
        .collect()
}

#[tauri::command]
pub async fn mpv_audio_devices(state: State<'_, AppState>) -> CmdResult<Vec<MpvAudioDevice>> {
    let Some(mpv) = state.mpv_path.clone() else { return Ok(vec![]) };
    let out = tokio::process::Command::new(mpv).arg("--audio-device=help").arg("--no-config").output().await.map_err(err)?;
    Ok(parse_mpv_audio_devices(&String::from_utf8_lossy(&out.stdout)))
}

#[tauri::command]
pub fn set_audio_output(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.platform.set_audio_output(&id).map_err(err)
}

#[derive(Serialize)]
pub struct VolumeState {
    volume: u8,
    muted: bool,
}

#[tauri::command]
pub fn volume_get(state: State<'_, AppState>) -> CmdResult<VolumeState> {
    Ok(VolumeState { volume: state.platform.volume().map_err(err)?, muted: state.platform.is_muted().unwrap_or(false) })
}

#[tauri::command]
pub fn volume_set(state: State<'_, AppState>, percent: u8) -> CmdResult<()> {
    state.platform.set_volume(percent.min(100)).map_err(err)
}

#[tauri::command]
pub fn mute_set(state: State<'_, AppState>, muted: bool) -> CmdResult<()> {
    state.platform.set_muted(muted).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mpv_device_list() {
        let out = "List of detected audio devices:\n  'auto' (Autoselect device)\n  'coreaudio/BuiltInSpeakerDevice' (MacBook Air Speakers)\n  'coreaudio/AppleHDMI:1' (LG TV)\n";
        let d = parse_mpv_audio_devices(out);
        assert_eq!(d.len(), 3);
        assert_eq!(d[2].name, "coreaudio/AppleHDMI:1");
        assert_eq!(d[2].description, "LG TV");
    }

    #[test]
    fn external_urls_must_be_public_https() {
        assert!(https_only("https://www.netflix.com/browse").is_ok());
        assert!(https_only("file:///etc/passwd").is_err());
        assert!(https_only("http://www.netflix.com").is_err());
        assert!(https_only("https://192.168.1.1/").is_err());
    }
}
