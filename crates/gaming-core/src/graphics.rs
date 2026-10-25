//! Graphics presets mapped onto Dolphin's real config keys
//! (Source/Core/Core/Config/GraphicsSettings.cpp, MainSettings.cpp).
//!
//! Settings reach Dolphin as `-C System.Section.Key=Value` launch arguments,
//! Dolphin's CommandLine config layer: they apply to that run only, are never
//! saved into GFX.ini/Dolphin.ini, and rank *below* per-game settings, so the
//! game-specific overrides Dolphin ships (and any the user made) still win.
//! `effective` reports exactly which requested values those overrides replace.
//!
//! Nothing here touches emulation speed, timing, or controller settings.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Preset {
    Performance,
    Balanced,
    Ultra,
    /// 6× native, about 4K. Full speed for one player on an M5 Air with ~2%
    /// headroom, so it is not meant for split screen.
    FourK,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Aspect {
    Auto,
    Wide,
    Standard,
    Stretch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Shaders {
    /// Compile before drawing: no glitches, can stutter on first sight.
    Synchronous,
    /// Ubershaders while specialised shaders compile: low stutter.
    Hybrid,
    /// Skip drawing objects until their shader is ready: lowest cost.
    SkipDrawing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Backend {
    /// Leave whatever backend the user chose in Dolphin.
    DolphinDefault,
    Metal,
    Vulkan,
    OpenGl,
    D3d11,
    D3d12,
}

impl Backend {
    fn config_name(self) -> Option<&'static str> {
        match self {
            Backend::DolphinDefault => None,
            Backend::Metal => Some("Metal"),
            Backend::Vulkan => Some("Vulkan"),
            Backend::OpenGl => Some("OGL"),
            Backend::D3d11 => Some("D3D"),
            Backend::D3d12 => Some("D3D12"),
        }
    }

    /// Backends Dolphin builds for this OS (VideoBackendBase::GetAvailableBackends).
    pub fn available() -> &'static [Backend] {
        if cfg!(target_os = "macos") {
            &[Backend::DolphinDefault, Backend::Metal, Backend::Vulkan, Backend::OpenGl]
        } else if cfg!(windows) {
            &[Backend::DolphinDefault, Backend::D3d11, Backend::D3d12, Backend::Vulkan, Backend::OpenGl]
        } else {
            &[Backend::DolphinDefault, Backend::Vulkan, Backend::OpenGl]
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsSettings {
    /// Multiple of native resolution, 1–8.
    pub internal_resolution: u32,
    /// 1, 2, 4, 8 or 16.
    pub anisotropy: u32,
    pub aspect: Aspect,
    /// MSAA samples: 1 (off), 2, 4 or 8.
    pub msaa: u32,
    pub shaders: Shaders,
    pub vsync: bool,
    /// Load every custom texture into memory at start (CacheHiresTextures).
    pub prefetch_textures: bool,
    pub backend: Backend,
    pub fullscreen: bool,
    /// Dolphin's bundled FXAA post-processing shader. MSAA is forced off for
    /// Mario Kart Wii, so this is the edge smoothing that actually applies.
    #[serde(default)]
    pub fxaa: bool,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum GraphicsError {
    #[error("{0} isn't a supported value for {1}")]
    Invalid(u32, &'static str),
    #[error("that graphics backend isn't available in Dolphin on this computer")]
    Backend,
}

impl Preset {
    pub fn settings(self) -> GraphicsSettings {
        // Metal is Dolphin's native macOS backend. On Windows the right one
        // depends on the GPU and driver, so Dolphin's own choice is kept.
        let backend = if cfg!(target_os = "macos") { Backend::Metal } else { Backend::DolphinDefault };
        let base = GraphicsSettings { internal_resolution: 3, anisotropy: 16, aspect: Aspect::Wide, msaa: 1, shaders: Shaders::Hybrid, vsync: true, prefetch_textures: false, backend, fullscreen: true, fxaa: true };
        match self {
            // Four-player split screen draws the scene four times.
            Preset::Performance => GraphicsSettings { internal_resolution: 2, anisotropy: 4, fxaa: false, ..base },
            Preset::Balanced | Preset::Custom => GraphicsSettings { msaa: 2, ..base },
            Preset::Ultra => GraphicsSettings { internal_resolution: 4, msaa: 4, ..base },
            Preset::FourK => GraphicsSettings { internal_resolution: 6, msaa: 4, ..base },
        }
    }
}

impl GraphicsSettings {
    /// Rejects anything the UI shouldn't be able to send.
    pub fn validate(&self) -> Result<(), GraphicsError> {
        if !(1..=8).contains(&self.internal_resolution) {
            return Err(GraphicsError::Invalid(self.internal_resolution, "internal resolution"));
        }
        if ![1, 2, 4, 8, 16].contains(&self.anisotropy) {
            return Err(GraphicsError::Invalid(self.anisotropy, "anisotropic filtering"));
        }
        if ![1, 2, 4, 8].contains(&self.msaa) {
            return Err(GraphicsError::Invalid(self.msaa, "anti-aliasing"));
        }
        if !Backend::available().contains(&self.backend) {
            return Err(GraphicsError::Backend);
        }
        Ok(())
    }
}

/// One Dolphin config value: where it lives and what we'd set it to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Requested {
    pub label: &'static str,
    pub system: &'static str,
    pub section: &'static str,
    pub key: &'static str,
    pub value: String,
}

fn b(v: bool) -> String {
    if v { "True" } else { "False" }.into()
}

/// Name of Dolphin's bundled FXAA shader (Sys/Shaders/FXAA.glsl).
pub const FXAA_SHADER: &str = "FXAA";

/// Whether this Dolphin ships the FXAA shader.
pub fn fxaa_available(sys_dir: &Path) -> bool {
    sys_dir.join("Shaders").join(format!("{FXAA_SHADER}.glsl")).is_file()
}

/// The config values a launch requests. `hd_textures` is whether the
/// MonitorOS-managed texture pack is installed and switched on; `fxaa` is
/// whether Dolphin ships the FXAA shader.
pub fn requested(s: &GraphicsSettings, hd_textures: bool, fxaa: bool) -> Vec<Requested> {
    let r = |label, system, section, key, value: String| Requested { label, system, section, key, value };
    // AnisotropicFilteringMode: Force1x=0 … Force16x=4.
    let af = s.anisotropy.trailing_zeros().to_string();
    // AspectMode: Auto=0, ForceWide=1, ForceStandard=2, Stretch=3.
    let aspect = (s.aspect as u8).to_string();
    // ShaderCompilationMode: Synchronous=0, AsynchronousUberShaders=2, AsynchronousSkipRendering=3.
    let shaders = match s.shaders {
        Shaders::Synchronous => "0",
        Shaders::Hybrid => "2",
        Shaders::SkipDrawing => "3",
    };
    let mut out = vec![
        r("Internal resolution", "Graphics", "Settings", "InternalResolution", s.internal_resolution.to_string()),
        r("Anisotropic filtering", "Graphics", "Enhancements", "MaxAnisotropy", af),
        r("Aspect ratio", "Graphics", "Settings", "AspectRatio", aspect),
        r("Anti-aliasing", "Graphics", "Settings", "MSAA", s.msaa.to_string()),
        r("Shader compilation", "Graphics", "Settings", "ShaderCompilationMode", shaders.into()),
        // Compiling what it can before the game starts avoids early stutter.
        r("Compile shaders before starting", "Graphics", "Settings", "WaitForShadersBeforeStarting", b(s.shaders != Shaders::Synchronous)),
        r("V-Sync", "Graphics", "Hardware", "VSync", b(s.vsync)),
        r("Full screen", "Dolphin", "Display", "Fullscreen", b(s.fullscreen)),
    ];
    // Off leaves whatever shader the user picked in Dolphin.
    if s.fxaa && fxaa {
        out.push(r("Edge smoothing (FXAA)", "Graphics", "Enhancements", "PostProcessingShader", FXAA_SHADER.into()));
    }
    if let Some(name) = s.backend.config_name() {
        out.push(r("Graphics backend", "Dolphin", "Core", "GFXBackend", name.into()));
    }
    if hd_textures {
        out.push(r("HD textures", "Graphics", "Settings", "HiresTextures", b(true)));
        out.push(r("Prefetch HD textures", "Graphics", "Settings", "CacheHiresTextures", b(s.prefetch_textures)));
    }
    out
}

/// A value forced by a per-game settings file (Dolphin's GlobalGame or
/// LocalGame layer), which outranks our launch arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Override {
    pub system: &'static str,
    pub section: String,
    pub key: String,
    pub value: String,
    pub file: String,
}

/// Game INI sections → config locations (ConfigLoaders/GameConfigLoader.cpp).
fn ini_section(name: &str) -> Option<(&'static str, &'static str)> {
    // Newer game INIs may also name the location directly: [Graphics.Enhancements].
    if let Some((system, section)) = name.split_once('.') {
        let system = match system {
            "Graphics" => "Graphics",
            "Dolphin" => "Dolphin",
            _ => return None,
        };
        let section: &'static str = ["Settings", "Enhancements", "Hardware", "Hacks", "Core", "Display", "Interface"].into_iter().find(|s| *s == section)?;
        return Some((system, section));
    }
    Some(match name {
        "Video_Settings" => ("Graphics", "Settings"),
        "Video_Enhancements" => ("Graphics", "Enhancements"),
        "Video_Hardware" => ("Graphics", "Hardware"),
        "Video_Hacks" => ("Graphics", "Hacks"),
        "Core" => ("Dolphin", "Core"),
        "Display" => ("Dolphin", "Display"),
        _ => return None,
    })
}

pub fn parse_game_ini(text: &str, file: &str) -> Vec<Override> {
    let mut out = vec![];
    let mut section: Option<(&'static str, &'static str)> = None;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') && line.ends_with(']') {
            section = ini_section(&line[1..line.len() - 1]);
        } else if let (Some((system, sec)), Some((k, v))) = (section, line.split_once('=')) {
            if !line.starts_with('#') && !line.starts_with(';') {
                out.push(Override { system, section: sec.into(), key: k.trim().into(), value: v.trim().into(), file: file.into() });
            }
        }
    }
    out
}

/// Every per-game override for `game_id`, lowest priority first: Dolphin's
/// shipped `Sys/GameSettings`, then the user's `GameSettings`; within each,
/// the 3-character file then the full-ID file.
pub fn game_overrides(sys_dir: &Path, user_dir: &Path, game_id: &str) -> Vec<Override> {
    let names = [format!("{}.ini", &game_id[..game_id.len().min(3)]), format!("{game_id}.ini")];
    let mut out = vec![];
    for (dir, origin) in [(sys_dir.join("GameSettings"), "Dolphin's built-in settings"), (user_dir.join("GameSettings"), "your Dolphin game settings")] {
        for n in &names {
            if let Ok(text) = std::fs::read_to_string(dir.join(n)) {
                out.extend(parse_game_ini(&text, &format!("{origin} ({n})")));
            }
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effective {
    pub label: &'static str,
    pub requested: String,
    pub effective: String,
    /// Which game settings file replaced the requested value, if any.
    pub overridden_by: Option<String>,
}

fn winning<'a>(r: &Requested, overrides: &'a [Override]) -> Option<&'a Override> {
    overrides.iter().rev().find(|o| o.system == r.system && o.section == r.section && o.key == r.key)
}

/// What Dolphin will actually use for each requested value.
pub fn effective(requested: &[Requested], overrides: &[Override]) -> Vec<Effective> {
    requested
        .iter()
        .map(|r| match winning(r, overrides) {
            Some(o) if o.value != r.value => Effective { label: r.label, requested: r.value.clone(), effective: o.value.clone(), overridden_by: Some(o.file.clone()) },
            _ => Effective { label: r.label, requested: r.value.clone(), effective: r.value.clone(), overridden_by: None },
        })
        .collect()
}

/// `-C` values for a launch. Values a game file overrides are left out:
/// Dolphin would ignore them anyway, and leaving them out keeps the launch
/// honest about what it changes.
pub fn dolphin_args(requested: &[Requested], overrides: &[Override]) -> Vec<String> {
    requested.iter().filter(|r| winning(r, overrides).is_none()).map(|r| format!("{}.{}.{}={}", r.system, r.section, r.key, r.value)).collect()
}

/// Per-run logging so MonitorOS can see Dolphin load custom textures
/// (CustomAssetLoader logs each one at Info level). Not saved to Logger.ini.
pub const TEXTURE_LOG_ARGS: &[&str] = &["Logger.Options.WriteToFile=True", "Logger.Options.Verbosity=4", "Logger.Logs.Video=True"];

#[cfg(test)]
mod tests {
    use super::*;

    const MKW_SYS: &str = "# RMCE01 - Mario Kart Wii\n[Core]\n# Values set here will override the main Dolphin settings.\n[Video_Hacks]\nEFBEmulateFormatChanges = True\n[Video_Stereoscopy]\nStereoConvergence = 613\n[Video_Settings]\nMSAA = 0\n";

    fn value(req: &[Requested], key: &str) -> Option<String> {
        req.iter().find(|r| r.key == key).map(|r| r.value.clone())
    }

    #[test]
    fn presets_map_to_real_dolphin_values() {
        let p = requested(&Preset::Performance.settings(), true, true);
        assert_eq!(value(&p, "InternalResolution").as_deref(), Some("2"));
        assert_eq!(value(&p, "MaxAnisotropy").as_deref(), Some("2")); // Force4x
        let bal = requested(&Preset::Balanced.settings(), true, true);
        assert_eq!(value(&bal, "InternalResolution").as_deref(), Some("3"));
        assert_eq!(value(&bal, "MaxAnisotropy").as_deref(), Some("4")); // Force16x
        assert_eq!(value(&bal, "AspectRatio").as_deref(), Some("1")); // ForceWide
        assert_eq!(value(&bal, "ShaderCompilationMode").as_deref(), Some("2")); // async ubershaders
        assert_eq!(value(&bal, "HiresTextures").as_deref(), Some("True"));
        assert_eq!(value(&bal, "CacheHiresTextures").as_deref(), Some("False"));
        let ultra = requested(&Preset::Ultra.settings(), true, true);
        assert_eq!(value(&ultra, "InternalResolution").as_deref(), Some("4"));
        let four_k = requested(&Preset::FourK.settings(), true, true);
        assert_eq!(value(&four_k, "InternalResolution").as_deref(), Some("6"));
        assert_eq!(value(&four_k, "PostProcessingShader").as_deref(), Some("FXAA"));
        assert_eq!(value(&bal, "PostProcessingShader").as_deref(), Some("FXAA"));
        // Performance skips FXAA, and a Dolphin without the shader never gets asked for it.
        assert_eq!(value(&p, "PostProcessingShader"), None);
        assert_eq!(value(&requested(&Preset::Ultra.settings(), true, false), "PostProcessingShader"), None);
        if cfg!(target_os = "macos") {
            assert_eq!(value(&bal, "GFXBackend").as_deref(), Some("Metal"));
        } else {
            assert_eq!(value(&bal, "GFXBackend"), None);
        }
        // No pack: textures aren't touched at all.
        assert_eq!(value(&requested(&Preset::Balanced.settings(), false, true), "HiresTextures"), None);
        // Nothing about speed, timing or input.
        for r in &ultra {
            assert!(!["EmulationSpeed", "CPUThread", "SyncGPU", "Overclock", "OverclockEnable"].contains(&r.key));
            assert!(r.system == "Graphics" || (r.system == "Dolphin" && ["Core", "Display"].contains(&r.section)));
        }
    }

    #[test]
    fn validation_rejects_unsupported_values() {
        let ok = Preset::Balanced.settings();
        assert!(ok.validate().is_ok());
        assert!(GraphicsSettings { internal_resolution: 9, ..ok.clone() }.validate().is_err());
        assert!(GraphicsSettings { internal_resolution: 0, ..ok.clone() }.validate().is_err());
        assert!(GraphicsSettings { anisotropy: 3, ..ok.clone() }.validate().is_err());
        assert!(GraphicsSettings { msaa: 16, ..ok.clone() }.validate().is_err());
        let foreign = if cfg!(windows) { Backend::Metal } else { Backend::D3d12 };
        assert_eq!(GraphicsSettings { backend: foreign, ..ok }.validate(), Err(GraphicsError::Backend));
    }

    #[test]
    fn game_overrides_win_and_are_reported() {
        let ov = parse_game_ini(MKW_SYS, "Dolphin's built-in settings (RMC.ini)");
        assert!(ov.iter().any(|o| o.key == "MSAA" && o.value == "0" && o.section == "Settings"));
        assert!(!ov.iter().any(|o| o.key == "StereoConvergence")); // section we don't map
        let req = requested(&Preset::Ultra.settings(), true, true);
        let eff = effective(&req, &ov);
        let aa = eff.iter().find(|e| e.label == "Anti-aliasing").unwrap();
        assert_eq!((aa.requested.as_str(), aa.effective.as_str()), ("4", "0"));
        assert!(aa.overridden_by.as_deref().unwrap().contains("RMC.ini"));
        let args = dolphin_args(&req, &ov);
        assert!(!args.iter().any(|a| a.contains("MSAA")));
        assert!(args.contains(&"Graphics.Settings.InternalResolution=4".to_string()));
        assert!(args.contains(&"Graphics.Settings.HiresTextures=True".to_string()));
    }

    #[test]
    fn dotted_sections_and_unmapped_ones() {
        // Dolphin ignores a bare [Enhancements] section (RMCP01.ini has one), so FXAA isn't blocked.
        let ov = parse_game_ini("[Enhancements]\nPostProcessingShader = \n[Graphics.Enhancements]\nMaxAnisotropy = 0\n", "x");
        assert_eq!(ov.len(), 1);
        assert_eq!((ov[0].section.as_str(), ov[0].key.as_str()), ("Enhancements", "MaxAnisotropy"));
        // Settings saved before FXAA existed still load.
        let old = r#"{"internalResolution":3,"anisotropy":16,"aspect":"wide","msaa":2,"shaders":"hybrid","vsync":true,"prefetchTextures":false,"backend":"dolphinDefault","fullscreen":true}"#;
        assert!(!serde_json::from_str::<GraphicsSettings>(old).unwrap().fxaa);
    }

    #[test]
    fn later_files_beat_earlier_ones() {
        let dir = std::env::temp_dir().join(format!("monitoros-gfx-{}", std::process::id()));
        let (sys, user) = (dir.join("Sys"), dir.join("User"));
        std::fs::create_dir_all(sys.join("GameSettings")).unwrap();
        std::fs::create_dir_all(user.join("GameSettings")).unwrap();
        std::fs::write(sys.join("GameSettings/RMC.ini"), MKW_SYS).unwrap();
        std::fs::write(user.join("GameSettings/RMCP01.ini"), "[Video_Settings]\nMSAA = 4\nInternalResolution = 5\n").unwrap();
        let ov = game_overrides(&sys, &user, "RMCP01");
        let eff = effective(&requested(&Preset::Ultra.settings(), false, true), &ov);
        let get = |l: &str| eff.iter().find(|e| e.label == l).unwrap().clone();
        assert_eq!(get("Anti-aliasing").overridden_by, None); // user file sets 4, same as requested
        assert_eq!(get("Internal resolution").effective, "5");
        assert!(get("Internal resolution").overridden_by.unwrap().contains("your Dolphin game settings"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
