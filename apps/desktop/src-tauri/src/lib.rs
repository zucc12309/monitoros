//! MonitorOS desktop shell: wires the UI to storage, mpv, the platform
//! adapter and the LAN remote server.

mod commands;
mod input;
mod remote;
mod routing;
mod services;

use media_engine::MpvSession;
use monitoros_core::{
    pairing::PairingManager,
    platform::{NullPlatform, Platform},
    Mode,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use storage::Store;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub struct AppState {
    pub store: Mutex<Store>,
    pub mpv_path: Option<PathBuf>,
    pub mpv: tokio::sync::Mutex<Option<MpvSession>>,
    pub platform: Box<dyn Platform>,
    pub pairing: Arc<Mutex<PairingManager>>,
    pub remote: tokio::sync::Mutex<Option<remote_server::ServerHandle>>,
    pub status: tokio::sync::watch::Sender<serde_json::Value>,
    pub mode: Mutex<Mode>,
    /// Focus of MonitorOS's own windows; neither focused = another app is in front.
    pub main_focused: std::sync::atomic::AtomicBool,
    pub service_focused: std::sync::atomic::AtomicBool,
    pub input: input::SystemInput,
}

/// Shallow-merge `patch` into the status object pushed to paired remotes.
pub fn merge_status(state: &AppState, patch: serde_json::Value) {
    state.status.send_modify(|cur| {
        if let (Some(cur), Some(patch)) = (cur.as_object_mut(), patch.as_object()) {
            for (k, v) in patch {
                cur.insert(k.clone(), v.clone());
            }
        }
    });
}

/// What the remote should drive right now.
/// Asks the windows themselves (focus events can be missed when a window
/// opens straight into a full-screen Space); falls back to the last events.
pub fn front(app: &AppHandle, state: &AppState) -> routing::Front {
    use std::sync::atomic::Ordering::SeqCst;
    let focused = |label: &str, cached: &std::sync::atomic::AtomicBool| {
        app.get_webview_window(label).map(|w| w.is_focused().unwrap_or_else(|_| cached.load(SeqCst))).unwrap_or(false)
    };
    if focused(services::SERVICE_WINDOW, &state.service_focused) {
        routing::Front::ServicePage
    } else if focused("main", &state.main_focused) {
        routing::Front::MonitorOs
    } else {
        routing::Front::OtherApp
    }
}

/// Settings › iPhone Remote › "Remote controls other apps" (default on).
pub fn other_apps_allowed(state: &AppState) -> bool {
    state
        .store
        .lock()
        .ok()
        .and_then(|s| s.get_setting::<serde_json::Value>("settings").ok().flatten())
        .and_then(|v| v.get("remoteControlsOtherApps").and_then(|b| b.as_bool()))
        .unwrap_or(true)
}

pub fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn platform() -> Box<dyn Platform> {
    #[cfg(target_os = "macos")]
    return Box::new(platform_macos::MacPlatform);
    #[cfg(windows)]
    return Box::new(platform_windows::WindowsPlatform);
    #[allow(unreachable_code)]
    Box::new(NullPlatform)
}

/// TV Mode = full-screen launcher. Desktop Mode = leave full screen and
/// minimise, so the normal desktop and every other app are untouched.
pub fn apply_mode(app: &AppHandle, mode: Mode) {
    let Some(w) = app.get_webview_window("main") else { return };
    match mode {
        Mode::Tv => {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_fullscreen(true);
            let _ = w.set_focus();
        }
        Mode::Desktop => {
            services::close(app);
            let _ = w.set_fullscreen(false);
            let _ = w.minimize();
        }
    }
    if let Some(state) = app.try_state::<AppState>() {
        *state.mode.lock().unwrap() = mode;
        merge_status(&state, serde_json::json!({ "mode": mode }));
    }
    let _ = app.emit("mode://changed", mode);
}

pub fn toggle_mode(app: &AppHandle) {
    let current = app.try_state::<AppState>().map(|s| *s.mode.lock().unwrap()).unwrap_or(Mode::Desktop);
    apply_mode(app, if current == Mode::Tv { Mode::Desktop } else { Mode::Tv });
}

fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("MonitorOS"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Recovery shortcut: always available even if full screen misbehaves.
    let toggle = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyM);
    let toggle_win = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyM);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| apply_mode(app, Mode::Tv)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, sc, ev| {
                    if ev.state() == ShortcutState::Pressed && (sc == &toggle || sc == &toggle_win) {
                        // First press closes an in-app service window; otherwise toggles mode.
                        if !services::close(app) {
                            toggle_mode(app);
                        }
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let handle = app.handle().clone();
            let store = Store::open(&data_dir(&handle).join("monitoros.db"))?;
            let devices: Vec<monitoros_core::pairing::PairedDevice> = store.devices().unwrap_or_default();
            let (status, _) = tokio::sync::watch::channel(serde_json::json!({ "mode": "desktop" }));
            app.manage(AppState {
                store: Mutex::new(store),
                mpv_path: media_engine::find_mpv(),
                mpv: tokio::sync::Mutex::new(None),
                platform: platform(),
                pairing: Arc::new(Mutex::new(PairingManager::with_devices(devices))),
                remote: tokio::sync::Mutex::new(None),
                status,
                mode: Mutex::new(Mode::Desktop),
                main_focused: std::sync::atomic::AtomicBool::new(true),
                service_focused: std::sync::atomic::AtomicBool::new(false),
                input: input::SystemInput::default(),
            });

            let gs = app.global_shortcut();
            let primary = if cfg!(target_os = "macos") { toggle } else { toggle_win };
            if let Err(e) = gs.register(primary) {
                tracing::warn!("could not register recovery shortcut: {e}");
            }

            let tv = MenuItem::with_id(app, "tv", "TV Mode", true, None::<&str>)?;
            let desk = MenuItem::with_id(app, "desktop", "Desktop Mode", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit MonitorOS", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&tv, &desk, &quit])?;
            let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("MonitorOS").on_menu_event(|app, e| match e.id.as_ref() {
                "tv" => apply_mode(app, Mode::Tv),
                "desktop" => apply_mode(app, Mode::Desktop),
                "quit" => app.exit(0),
                _ => {}
            });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            use std::sync::atomic::Ordering::SeqCst;
            let app = window.app_handle();
            let Some(state) = app.try_state::<AppState>() else { return };
            match (window.label(), event) {
                ("main", tauri::WindowEvent::Focused(f)) => state.main_focused.store(*f, SeqCst),
                (services::SERVICE_WINDOW, tauri::WindowEvent::Focused(f)) => state.service_focused.store(*f, SeqCst),
                (services::SERVICE_WINDOW, tauri::WindowEvent::Destroyed) => {
                    state.service_focused.store(false, SeqCst);
                    merge_status(&state, serde_json::json!({ "service": { "open": false } }));
                }
                _ => return,
            }
            // Tell the phone what it is driving (it switches the touchpad to
            // mouse mode outside MonitorOS's own interface).
            merge_status(&state, serde_json::json!({ "control": front(app, &state).as_str() }));
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::provider_fetch_json,
            commands::provider_fetch_text,
            commands::open_external,
            commands::open_service,
            commands::close_service,
            commands::set_mode,
            commands::player_play,
            commands::player_command,
            commands::player_stop,
            commands::store_get,
            commands::store_set,
            commands::library_add_root,
            commands::library_remove_root,
            commands::library_roots,
            commands::library_items,
            commands::library_rescan,
            commands::displays,
            commands::audio_outputs,
            commands::mpv_audio_devices,
            commands::set_audio_output,
            commands::volume_get,
            commands::volume_set,
            commands::mute_set,
            remote::remote_info,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_status,
            remote::pairing_approve,
            remote::pairing_deny,
            remote::devices_list,
            remote::device_revoke,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MonitorOS");
}
