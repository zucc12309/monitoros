//! Graphics & Enhancements for the chosen Dolphin game: presets, and the
//! HD texture pack manager.
//!
//! Presets are stored in MonitorOS's own settings and handed to Dolphin as
//! per-run `-C` launch arguments (see gaming_core::graphics), so GFX.ini,
//! Dolphin.ini and every controller file stay exactly as the user left
//! them. Pack changes are refused while the game is running; a preset change
//! only affects the next launch, so a race in progress is never interrupted.

use crate::game::{dolphin_install, game_file, Games};
use crate::AppState;
use gaming_core::disc::{self, Region};
use gaming_core::dolphin::Install;
use gaming_core::graphics::{self, Effective, GraphicsSettings, Preset};
use gaming_core::texture_install::{self as pack, PackStatus, Progress};
use gaming_core::textures::{self, Preview, Source};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Largest slice of dolphin.log read when looking for texture-load lines.
const LOG_SCAN_BYTES: u64 = 16 << 20;

#[derive(Default)]
pub struct Graphics {
    job: Mutex<Option<InstallJob>>,
    /// dolphin.log and its length when the current/last game started.
    log_mark: Mutex<Option<(PathBuf, u64)>>,
    confirmed: Mutex<Option<usize>>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallJob {
    pub done: usize,
    pub total: usize,
    pub finished: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    preset: Preset,
    custom: GraphicsSettings,
}

impl Default for Stored {
    fn default() -> Self {
        Stored { preset: Preset::Balanced, custom: Preset::Balanced.settings() }
    }
}

impl Stored {
    fn settings(&self) -> GraphicsSettings {
        match self.preset {
            Preset::Custom => self.custom.clone(),
            p => p.settings(),
        }
    }
}

/// Settings are kept per game (by the 3-letter ID, so all regions share).
fn key(game_id: Option<&str>) -> String {
    format!("graphics.{}", game_id.and_then(|g| g.get(..3)).unwrap_or("default"))
}

fn stored(state: &AppState, game_id: Option<&str>) -> Stored {
    state.store.lock().unwrap().get_setting::<Stored>(&key(game_id)).ok().flatten().filter(|s| s.custom.validate().is_ok()).unwrap_or_default()
}

fn current_game_id(state: &AppState) -> Option<String> {
    game_file(state).and_then(|f| disc::read_game_id(&f))
}

/// The pack ID MonitorOS manages for this game: whichever is installed
/// (full ID first), else the region-free 3-letter ID packs normally use.
fn pack_id_for(install: &Install, game_id: &str) -> String {
    let full = pack::managed_dir(&install.user_dir, game_id);
    if pack::read_manifest(&full).is_some() {
        game_id.to_string()
    } else {
        game_id[..3].to_string()
    }
}

fn pack_status(install: &Install, game_id: &str) -> PackStatus {
    pack::status(&install.user_dir, &pack_id_for(install, game_id), game_id)
}

/// The `-C` arguments for launching `game_id` with its saved settings.
/// Called by game_launch; also marks dolphin.log so loads can be confirmed.
pub fn launch_config(state: &AppState, install: &Install, game_id: Option<&str>) -> Vec<String> {
    let settings = stored(state, game_id).settings();
    let hd = game_id.is_some_and(|g| pack_status(install, g).discoverable);
    let requested = graphics::requested(&settings, hd, graphics::fxaa_available(&install.sys_dir));
    let overrides = game_id.map(|g| graphics::game_overrides(&install.sys_dir, &install.user_dir, g)).unwrap_or_default();
    let mut args = graphics::dolphin_args(&requested, &overrides);
    let g = &state.graphics;
    *g.confirmed.lock().unwrap() = None;
    *g.log_mark.lock().unwrap() = None;
    if hd {
        args.extend(graphics::TEXTURE_LOG_ARGS.iter().map(|s| s.to_string()));
        let log = install.user_dir.join("Logs").join("dolphin.log");
        let len = std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
        *g.log_mark.lock().unwrap() = Some((log, len));
    }
    tracing::info!(?args, "graphics: launch settings");
    args
}

/// How many of the pack's textures Dolphin has logged loading since launch.
fn confirm_from_log(state: &AppState, manifest: &pack::Manifest) -> Option<usize> {
    use std::io::{Read, Seek, SeekFrom};
    let g = &state.graphics;
    let (log, start) = g.log_mark.lock().unwrap().clone()?;
    let mut f = std::fs::File::open(&log).ok()?;
    let len = f.metadata().ok()?.len();
    let start = if len < start { 0 } else { start }; // log was rotated
    f.seek(SeekFrom::Start(start.max(len.saturating_sub(LOG_SCAN_BYTES)))).ok()?;
    let mut text = String::new();
    f.take(LOG_SCAN_BYTES).read_to_string(&mut text).ok();
    let names = manifest.names.iter().map(String::as_str).collect();
    let n = pack::loaded_from_log(&text, &names);
    let mut c = g.confirmed.lock().unwrap();
    *c = Some(c.unwrap_or(0).max(n));
    *c
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsInfo {
    game_id: Option<String>,
    region: &'static str,
    mario_kart_wii: bool,
    running: bool,
    dolphin_error: Option<String>,
    user_dir: Option<String>,
    textures_folder: Option<String>,
    preset: Preset,
    settings: GraphicsSettings,
    presets: Vec<(Preset, GraphicsSettings)>,
    backends: &'static [graphics::Backend],
    effective: Vec<Effective>,
    pack: Option<PackStatus>,
    /// Textures Dolphin's log shows it loaded this session (None = no evidence yet).
    confirmed_loaded: Option<usize>,
    job: Option<InstallJob>,
}

#[tauri::command]
pub fn graphics_info(state: State<'_, AppState>) -> GraphicsInfo {
    let game_id = current_game_id(&state);
    let install = dolphin_install(&state);
    let saved = stored(&state, game_id.as_deref());
    let settings = saved.settings();
    let (pack, effective, user_dir, textures_folder, dolphin_error) = match (&install, game_id.as_deref()) {
        (Ok(i), Some(g)) => {
            let status = pack_status(i, g);
            let req = graphics::requested(&settings, status.discoverable, graphics::fxaa_available(&i.sys_dir));
            let eff = graphics::effective(&req, &graphics::game_overrides(&i.sys_dir, &i.user_dir, g));
            (Some(status), eff, Some(i.user_dir.display().to_string()), Some(pack::textures_root(&i.user_dir).display().to_string()), None)
        }
        (Ok(i), None) => (None, graphics::effective(&graphics::requested(&settings, false, graphics::fxaa_available(&i.sys_dir)), &[]), Some(i.user_dir.display().to_string()), None, None),
        (Err(e), _) => (None, vec![], None, None, Some(e.to_string())),
    };
    // Evidence only counts for a pack that's currently switched on.
    let confirmed_loaded = pack.as_ref().filter(|p| p.discoverable).and_then(|p| p.manifest.as_ref()).and_then(|m| confirm_from_log(&state, m));
    GraphicsInfo {
        region: game_id.as_deref().map(Region::of).unwrap_or(Region::Unknown).label(),
        mario_kart_wii: game_id.as_deref().is_some_and(disc::is_mario_kart_wii),
        running: state.games.running(),
        preset: saved.preset,
        presets: [Preset::Performance, Preset::Balanced, Preset::Ultra, Preset::FourK].into_iter().map(|p| (p, p.settings())).collect(),
        backends: graphics::Backend::available(),
        job: state.graphics.job.lock().unwrap().clone(),
        game_id,
        dolphin_error,
        user_dir,
        textures_folder,
        settings,
        effective,
        pack,
        confirmed_loaded,
    }
}

/// Saves a preset (or custom settings). Takes effect at the next launch.
#[tauri::command]
pub fn graphics_set(state: State<'_, AppState>, preset: Preset, custom: Option<GraphicsSettings>) -> Result<(), String> {
    let game_id = current_game_id(&state);
    let mut s = stored(&state, game_id.as_deref());
    s.preset = preset;
    if let Some(c) = custom {
        c.validate().map_err(|e| e.to_string())?;
        s.custom = c;
    } else if preset != Preset::Custom {
        s.custom = preset.settings(); // custom starts from the last preset
    }
    state.store.lock().unwrap().set_setting(&key(game_id.as_deref()), &s, monitoros_core::now_ms() as i64).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn graphics_restore_defaults(state: State<'_, AppState>) -> Result<(), String> {
    let game_id = current_game_id(&state);
    state.store.lock().unwrap().set_setting(&key(game_id.as_deref()), &Stored::default(), monitoros_core::now_ms() as i64).map_err(|e| e.to_string())
}

/// A pack change makes earlier load evidence stale.
fn forget_evidence(state: &AppState) {
    *state.graphics.log_mark.lock().unwrap() = None;
    *state.graphics.confirmed.lock().unwrap() = None;
}

fn not_running(games: &Games) -> Result<(), String> {
    if games.running() {
        return Err("Stop the game first: Dolphin is using the texture folder".into());
    }
    Ok(())
}

/// Reads a pack the user picked and returns the import preview.
#[tauri::command]
pub async fn texture_pack_inspect(app: AppHandle, path: String) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state: State<AppState> = app.state();
        let game_id = current_game_id(&state);
        let source = Source::open(Path::new(&path)).map_err(|e| e.to_string())?;
        textures::inspect(&source, game_id.as_deref()).map(|(p, _, _)| p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Installs the pack in the background; progress shows in graphics_info.
#[tauri::command]
pub fn texture_pack_install(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    not_running(&state.games)?;
    let install = dolphin_install(&state).map_err(|e| e.to_string())?;
    let game_id = current_game_id(&state).ok_or("Choose your Mario Kart Wii game file first")?;
    {
        let mut job = state.graphics.job.lock().unwrap();
        if job.as_ref().is_some_and(|j| !j.finished) {
            return Err("An install is already running".into());
        }
        *job = Some(InstallJob::default());
    }
    forget_evidence(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let state: State<AppState> = app.state();
        let set = |f: &dyn Fn(&mut InstallJob)| {
            if let Some(j) = state.graphics.job.lock().unwrap().as_mut() {
                f(j)
            }
        };
        let result = (|| {
            // Re-read and re-check: the file may have changed since the preview.
            let source = Source::open(Path::new(&path)).map_err(|e| e.to_string())?;
            let (preview, root, entries) = textures::inspect(&source, Some(&game_id)).map_err(|e| e.to_string())?;
            if preview.compatible == Some(false) {
                return Err(format!("This pack is for {}, not your game ({game_id})", preview.pack_id));
            }
            let report = |done, total| set(&|j| {
                j.done = done;
                j.total = total;
            });
            pack::install(&source, &preview, &root, &entries, &install.user_dir, monitoros_core::now_ms(), Progress { report: &report }).map_err(|e| e.to_string())?;
            let status = pack_status(&install, &game_id);
            if !status.discoverable {
                return Err("Installed, but Dolphin's folder lookup doesn't find it; see Troubleshooting".into());
            }
            Ok(())
        })();
        if let Err(e) = &result {
            tracing::warn!("texture pack install failed: {e}");
        }
        set(&|j| {
            j.finished = true;
            j.error = result.clone().err();
        });
    });
    Ok(())
}

#[tauri::command]
pub fn texture_pack_set_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    not_running(&state.games)?;
    let install = dolphin_install(&state).map_err(|e| e.to_string())?;
    let game_id = current_game_id(&state).ok_or("Choose a game first")?;
    forget_evidence(&state);
    pack::set_enabled(&install.user_dir, &pack_id_for(&install, &game_id), enabled).map_err(|e| e.to_string())
}

/// Removes MonitorOS's installed copy (the downloaded original stays).
#[tauri::command]
pub fn texture_pack_remove(state: State<'_, AppState>) -> Result<(), String> {
    not_running(&state.games)?;
    let install = dolphin_install(&state).map_err(|e| e.to_string())?;
    let game_id = current_game_id(&state).ok_or("Choose a game first")?;
    forget_evidence(&state);
    pack::remove(&install.user_dir, &pack_id_for(&install, &game_id)).map_err(|e| e.to_string())?;
    *state.graphics.job.lock().unwrap() = None;
    Ok(())
}

/// Shows Dolphin's texture folder (or the installed pack) in Finder/Explorer.
#[tauri::command]
pub fn texture_folder_open(state: State<'_, AppState>) -> Result<(), String> {
    let install = dolphin_install(&state).map_err(|e| e.to_string())?;
    let root = pack::textures_root(&install.user_dir);
    let managed = current_game_id(&state).map(|g| pack::managed_dir(&install.user_dir, &pack_id_for(&install, &g)));
    match managed.filter(|d| d.is_dir()) {
        Some(dir) => tauri_plugin_opener::reveal_item_in_dir(dir),
        None => {
            std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
            tauri_plugin_opener::open_path(root, None::<&str>)
        }
    }
    .map_err(|e| e.to_string())
}
