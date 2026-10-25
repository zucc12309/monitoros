//! The user's installed Dolphin: find it, check it's new enough, point its
//! controllers at MonitorOS, and launch a game file the user picked.
//!
//! Dolphin is GPL and stays a separate program (never bundled or linked).
//! Versions before 2609 have published code-execution bugs reachable from
//! game files, so they are refused (docs/gaming/SECURITY_REVIEW.md).

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// 2609 release, or a development build from 2606-387 on.
const MIN_RELEASE: u32 = 2609;
const MIN_DEV: (u32, u32) = (2606, 387);

/// Disc formats Dolphin opens. Anything else is refused before launch.
pub const GAME_EXTENSIONS: &[&str] = &["rvz", "iso", "wbfs", "gcz", "wia", "ciso", "gcm"];

/// Config files MonitorOS writes; each is backed up once before the first change.
pub const MANAGED_FILES: &[&str] = &["DSUClient.ini", "WiimoteNew.ini"];
pub const BACKUP_SUFFIX: &str = ".monitoros-backup";

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum DolphinError {
    #[error("Dolphin isn't installed")]
    NotInstalled,
    #[error("Dolphin {0} has known security bugs: update to 2609 or newer")]
    TooOld(String),
    #[error("couldn't read Dolphin's version")]
    UnknownVersion,
    #[error("that file isn't a Wii or GameCube game")]
    NotAGame,
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for DolphinError {
    fn from(e: std::io::Error) -> Self {
        DolphinError::Io(e.to_string())
    }
}

/// "2609a" → release 2609; "2606-387" → dev build; old "5.0-21460" → too old.
pub fn version_supported(v: &str) -> bool {
    let v = v.trim();
    if let Some((major, build)) = v.split_once('-') {
        return match (major.parse::<u32>(), build.parse::<u32>()) {
            (Ok(m), Ok(b)) => (m, b) >= MIN_DEV,
            _ => false,
        };
    }
    let digits: String = v.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.len() == 4 && digits.parse::<u32>().is_ok_and(|n| n >= MIN_RELEASE)
}

#[derive(Debug, Clone)]
pub struct Install {
    pub executable: PathBuf,
    pub version: String,
    /// Dolphin's User folder, resolved the same way Dolphin resolves it and
    /// passed back with `-u` so both always agree.
    pub user_dir: PathBuf,
    pub config_dir: PathBuf,
    /// Dolphin's bundled `Sys` folder (shipped per-game settings live here).
    pub sys_dir: PathBuf,
}

/// Finds an installed, supported Dolphin. `custom` is a Dolphin the user
/// located themselves (a portable copy, or anywhere on Windows).
pub fn detect(custom: Option<&Path>) -> Result<Install, DolphinError> {
    // A picked macOS app bundle means the executable inside it.
    let custom = custom.map(|p| if p.extension().is_some_and(|e| e == "app") { p.join("Contents/MacOS/Dolphin") } else { p.to_path_buf() });
    let exe = custom.filter(|p| p.is_file()).or_else(default_executable).ok_or(DolphinError::NotInstalled)?;
    let version = read_version(&exe).ok_or(DolphinError::UnknownVersion)?;
    if !version_supported(&version) {
        return Err(DolphinError::TooOld(version));
    }
    let exe_dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let user_dir = platform_user_dir(&exe_dir);
    let sys_dir = match exe_dir.parent() {
        Some(contents) if cfg!(target_os = "macos") => contents.join("Resources/Sys"),
        _ => exe_dir.join("Sys"),
    };
    Ok(Install { config_dir: user_dir.join("Config"), executable: exe, version, user_dir, sys_dir })
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

fn default_executable() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
        vec![PathBuf::from("/Applications/Dolphin.app/Contents/MacOS/Dolphin"), home().join("Applications/Dolphin.app/Contents/MacOS/Dolphin")]
    } else if cfg!(windows) {
        [env("ProgramFiles").map(|p| p.join("Dolphin")), env("ProgramFiles").map(|p| p.join("Dolphin-x64")), env("LOCALAPPDATA").map(|p| p.join("Programs/Dolphin")), Some(home().join("Dolphin-x64"))]
            .into_iter()
            .flatten()
            .map(|d| d.join("Dolphin.exe"))
            .collect()
    } else {
        vec![]
    };
    candidates.into_iter().find(|p| p.is_file())
}

/// macOS: the app bundle's Info.plist. Windows: the exe's ProductVersion.
fn read_version(exe: &Path) -> Option<String> {
    if cfg!(target_os = "macos") {
        let plist = std::fs::read_to_string(exe.parent()?.parent()?.join("Info.plist")).ok()?;
        plist_string(&plist, "CFBundleShortVersionString")
    } else {
        pe_product_version(&std::fs::read(exe).ok()?)
    }
}

/// Reads `ProductVersion` from a Windows executable's version resource
/// (a UTF-16 key followed by a 4-byte-aligned UTF-16 value).
pub fn pe_product_version(bytes: &[u8]) -> Option<String> {
    let key: Vec<u8> = "ProductVersion\0".encode_utf16().flat_map(u16::to_le_bytes).collect();
    let at = bytes.windows(key.len()).position(|w| w == key.as_slice())?;
    let mut i = (at + key.len()).next_multiple_of(4);
    let mut out = String::new();
    while i + 1 < bytes.len() && out.len() < 32 {
        let c = u16::from_le_bytes([bytes[i], bytes[i + 1]]);
        if c == 0 {
            break;
        }
        out.push(char::from_u32(c.into())?);
        i += 2;
    }
    let v = out.trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// Dolphin's macOS/Linux rule (UICommon::SetUserDirectory): `portable.txt`
/// next to the executable, then `$DOLPHIN_EMU_USERPATH`, then the default.
pub fn unix_user_dir(exe_dir: &Path, env_path: Option<PathBuf>, home: &Path) -> PathBuf {
    if exe_dir.join("portable.txt").exists() {
        exe_dir.join("User")
    } else if let Some(p) = env_path.filter(|p| !p.as_os_str().is_empty()) {
        p
    } else {
        home.join("Library/Application Support/Dolphin")
    }
}

/// Dolphin's Windows rule: portable.txt or the LocalUserConfig registry
/// flag → `<exe>\User`; else the UserConfigPath registry value; else an
/// existing `Documents\Dolphin Emulator`; else `%APPDATA%\Dolphin Emulator`.
pub fn windows_user_dir(exe_dir: &Path, local_user_config: bool, user_config_path: Option<PathBuf>, documents: Option<PathBuf>, appdata: Option<PathBuf>) -> PathBuf {
    let old = documents.map(|d| d.join("Dolphin Emulator")).filter(|d| d.exists());
    if local_user_config || exe_dir.join("portable.txt").exists() {
        exe_dir.join("User")
    } else if let Some(p) = user_config_path {
        p
    } else if let Some(p) = old {
        p
    } else if let Some(a) = appdata {
        a.join("Dolphin Emulator")
    } else {
        exe_dir.join("User")
    }
}

fn platform_user_dir(exe_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        let key = r"HKCU\Software\Dolphin Emulator";
        let local = reg_value(key, "LocalUserConfig").is_some_and(|v| v.trim_start_matches("0x").trim() != "0");
        let docs = reg_value(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders", "Personal")
            .map(|v| PathBuf::from(v.replace("%USERPROFILE%", &home().to_string_lossy())))
            .or_else(|| Some(home().join("Documents")));
        windows_user_dir(exe_dir, local, reg_value(key, "UserConfigPath").map(PathBuf::from), docs, std::env::var_os("APPDATA").map(PathBuf::from))
    } else {
        unix_user_dir(exe_dir, std::env::var_os("DOLPHIN_EMU_USERPATH").map(PathBuf::from), &home())
    }
}

/// One registry value via `reg query` (argument list, no shell).
fn reg_value(key: &str, name: &str) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let out = Command::new("reg").args(["query", key, "/v", name]).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let line = text.lines().find(|l| l.trim_start().starts_with(name))?;
    let mut parts = line.trim().splitn(3, "    ").map(str::trim);
    let (_, _, value) = (parts.next()?, parts.next()?, parts.next()?);
    Some(value.to_string())
}

fn plist_string(plist: &str, key: &str) -> Option<String> {
    let after = &plist[plist.find(&format!("<key>{key}</key>"))?..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")?;
    Some(after[start..start + end].trim().to_string())
}

/// The game file must be a regular file with a disc-image extension.
pub fn validate_game(path: &Path) -> Result<PathBuf, DolphinError> {
    let path = path.canonicalize().map_err(|_| DolphinError::NotAGame)?;
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !path.is_file() || !GAME_EXTENSIONS.contains(&ext.as_str()) {
        return Err(DolphinError::NotAGame);
    }
    Ok(path)
}

/// Mapping for player `n` (0-based): Wii Remote + Nunchuk, which is how
/// Mario Kart Wii and most party games play. Phone stick → Nunchuk stick,
/// A/B on the phone → A/B, Item → Z, Look back → C, and Trick (R2) →
/// shaking the Wii Remote, which is how tricks and wheelies are done.
pub fn wiimote_section(n: usize) -> String {
    format!(
        "[Wiimote{}]\n\
         Device = DSUClient/{n}/MonitorOS\n\
         Source = 1\n\
         Buttons/A = Cross\n\
         Buttons/B = Circle\n\
         Buttons/1 = Square\n\
         Buttons/2 = Triangle\n\
         Buttons/- = Share\n\
         Buttons/+ = Options\n\
         Buttons/Home = PS\n\
         D-Pad/Up = `Pad N`\n\
         D-Pad/Down = `Pad S`\n\
         D-Pad/Left = `Pad W`\n\
         D-Pad/Right = `Pad E`\n\
         Extension = Nunchuk\n\
         Nunchuk/Buttons/C = L1\n\
         Nunchuk/Buttons/Z = R1\n\
         Nunchuk/Stick/Up = `Left Y+`\n\
         Nunchuk/Stick/Down = `Left Y-`\n\
         Nunchuk/Stick/Left = `Left X-`\n\
         Nunchuk/Stick/Right = `Left X+`\n\
         Shake/X = R2\n\
         Shake/Y = R2\n\
         Shake/Z = R2\n",
        n + 1
    )
}

pub const DSU_SECTION: &str = "[Server]\nEnabled = True\nEntries = MonitorOS:127.0.0.1:26760;\n";

/// Replaces whole `[sections]` in an INI file, keeping every other section
/// (and anything before the first section) exactly as it was.
pub fn replace_sections(original: &str, sections: &[String]) -> String {
    let name = |s: &str| s.lines().next().unwrap_or("").trim().to_string();
    let ours: Vec<String> = sections.iter().map(|s| name(s)).collect();
    let mut out = String::new();
    let mut skipping = false;
    for line in original.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            skipping = ours.iter().any(|o| o == t);
        }
        if !skipping {
            out.push_str(line);
            out.push('\n');
        }
    }
    for s in sections {
        out.push_str(s);
    }
    out
}

/// Points Dolphin's four Wii Remotes at the MonitorOS pads. Backs each file
/// up once first, and leaves every other section and file untouched.
pub fn configure(config_dir: &Path) -> Result<(), DolphinError> {
    std::fs::create_dir_all(config_dir)?;
    let wiimotes: Vec<String> = (0..crate::MAX_PLAYERS).map(wiimote_section).collect();
    for (file, sections) in [("DSUClient.ini", vec![DSU_SECTION.to_string()]), ("WiimoteNew.ini", wiimotes)] {
        let path = config_dir.join(file);
        let current = std::fs::read_to_string(&path).unwrap_or_default();
        let backup = config_dir.join(format!("{file}{BACKUP_SUFFIX}"));
        // Back up the user's own settings, never a file MonitorOS already wrote.
        if path.exists() && !backup.exists() && !current.contains("MonitorOS") {
            std::fs::copy(&path, &backup)?;
        }
        let updated = replace_sections(&current, &sections);
        if updated != current {
            std::fs::write(&path, updated)?;
        }
    }
    Ok(())
}

/// Without this Dolphin answers SIGTERM with a "stop emulation?" dialog
/// (MainWindow::RequestStop) and keeps running, so Stop game could only end
/// it with SIGKILL. Applies to that run only; the user's setting is kept.
pub const NO_STOP_CONFIRM: &str = "Dolphin.Interface.ConfirmStop=False";

/// Dolphin's arguments: our resolved User folder, batch mode, one `-C`
/// per setting (each `System.Section.Key=Value`, built from fixed keys,
/// never from user text), then the validated game.
pub fn launch_args(install: &Install, game: &Path, config: &[String]) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec!["-u".into(), install.user_dir.clone().into_os_string(), "--batch".into(), "-C".into(), NO_STOP_CONFIRM.into()];
    for c in config {
        args.push("-C".into());
        args.push(c.into());
    }
    args.push("--exec".into());
    args.push(game.as_os_str().to_owned());
    args
}

/// Starts the game without Dolphin's own menus. Arguments are passed as a
/// list (no shell), and the path is validated first.
pub fn launch(install: &Install, game: &Path, config: &[String]) -> Result<Child, DolphinError> {
    let game = validate_game(game)?;
    Ok(Command::new(&install.executable)
        .args(launch_args(install, &game, config))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_policy() {
        assert!(version_supported("2609a"));
        assert!(version_supported("2609"));
        assert!(version_supported("2612"));
        assert!(version_supported("2606-387"));
        assert!(version_supported("2609-12"));
        assert!(!version_supported("2606a"));
        assert!(!version_supported("2606-386"));
        assert!(!version_supported("5.0-21460"));
        assert!(!version_supported("2603"));
        assert!(!version_supported(""));
    }

    #[test]
    fn reads_plist_version() {
        let p = "<dict>\n<key>CFBundleShortVersionString</key>\n\t<string>2609a</string>\n</dict>";
        assert_eq!(plist_string(p, "CFBundleShortVersionString").as_deref(), Some("2609a"));
        assert_eq!(plist_string(p, "Missing"), None);
    }

    #[test]
    fn replaces_only_our_sections() {
        let ini = "[Wiimote1]\nDevice = Quartz/0/Keyboard & Mouse\nButtons/A = `Left Click`\n[BalanceBoard]\nDevice = X\n";
        let out = replace_sections(ini, &[wiimote_section(0)]);
        assert!(out.contains("[BalanceBoard]\nDevice = X\n"));
        assert!(out.contains("Device = DSUClient/0/MonitorOS"));
        assert!(!out.contains("Left Click"));
        assert_eq!(out.matches("[Wiimote1]").count(), 1);
        // Every Mario Kart Wii control has a phone input: Item, Look back, Trick (shake).
        for line in ["Nunchuk/Buttons/Z = R1", "Nunchuk/Buttons/C = L1", "Shake/X = R2", "Shake/Y = R2", "Shake/Z = R2"] {
            assert!(out.contains(line), "{line}");
        }
        // Idempotent.
        assert_eq!(replace_sections(&out, &[wiimote_section(0)]), out);
    }

    #[test]
    fn configure_backs_up_once_and_keeps_other_settings() {
        let dir = std::env::temp_dir().join(format!("monitoros-dolphin-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("WiimoteNew.ini"), "[Wiimote1]\nDevice = Old\n[BalanceBoard]\nDevice = Keep\n").unwrap();
        std::fs::write(dir.join("Dolphin.ini"), "[General]\nX = 1\n").unwrap();
        configure(&dir).unwrap();
        configure(&dir).unwrap();
        let w = std::fs::read_to_string(dir.join("WiimoteNew.ini")).unwrap();
        assert!(w.contains("DSUClient/3/MonitorOS") && w.contains("Device = Keep"));
        assert!(std::fs::read_to_string(dir.join("WiimoteNew.ini.monitoros-backup")).unwrap().contains("Device = Old"));
        assert!(std::fs::read_to_string(dir.join("DSUClient.ini")).unwrap().contains("127.0.0.1:26760"));
        assert!(!dir.join("DSUClient.ini.monitoros-backup").exists()); // didn't exist before
        assert_eq!(std::fs::read_to_string(dir.join("Dolphin.ini")).unwrap(), "[General]\nX = 1\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_game_files_launch() {
        let dir = std::env::temp_dir().join(format!("monitoros-game-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let game = dir.join("Game.RVZ");
        let script = dir.join("run.sh");
        std::fs::write(&game, b"x").unwrap();
        std::fs::write(&script, b"x").unwrap();
        assert!(validate_game(&game).is_ok());
        assert_eq!(validate_game(&script), Err(DolphinError::NotAGame));
        assert_eq!(validate_game(&dir), Err(DolphinError::NotAGame));
        assert_eq!(validate_game(Path::new("/nonexistent/x.iso")), Err(DolphinError::NotAGame));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn user_dir_follows_dolphins_rules() {
        let dir = std::env::temp_dir().join(format!("monitoros-userdir-{}", std::process::id()));
        let exe = dir.join("exe");
        let home = dir.join("home");
        std::fs::create_dir_all(&exe).unwrap();
        assert_eq!(unix_user_dir(&exe, None, &home), home.join("Library/Application Support/Dolphin"));
        assert_eq!(unix_user_dir(&exe, Some(dir.join("custom")), &home), dir.join("custom"));
        assert_eq!(unix_user_dir(&exe, Some(PathBuf::new()), &home), home.join("Library/Application Support/Dolphin"));

        let docs = dir.join("Documents");
        let appdata = dir.join("AppData");
        assert_eq!(windows_user_dir(&exe, false, None, Some(docs.clone()), Some(appdata.clone())), appdata.join("Dolphin Emulator"));
        std::fs::create_dir_all(docs.join("Dolphin Emulator")).unwrap();
        assert_eq!(windows_user_dir(&exe, false, None, Some(docs.clone()), Some(appdata.clone())), docs.join("Dolphin Emulator"));
        assert_eq!(windows_user_dir(&exe, false, Some(dir.join("reg")), Some(docs.clone()), None), dir.join("reg"));
        assert_eq!(windows_user_dir(&exe, true, Some(dir.join("reg")), None, None), exe.join("User"));

        // portable.txt wins on every platform.
        std::fs::write(exe.join("portable.txt"), "").unwrap();
        assert_eq!(unix_user_dir(&exe, Some(dir.join("custom")), &home), exe.join("User"));
        assert_eq!(windows_user_dir(&exe, false, Some(dir.join("reg")), None, None), exe.join("User"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_windows_product_version() {
        let mut exe = b"MZ....".to_vec();
        exe.extend("ProductVersion\0".encode_utf16().flat_map(u16::to_le_bytes));
        while !exe.len().is_multiple_of(4) {
            exe.push(0);
        }
        exe.extend("2609a\0".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(pe_product_version(&exe).as_deref(), Some("2609a"));
        assert_eq!(pe_product_version(b"MZ no version here"), None);
    }

    #[test]
    fn launch_args_are_a_fixed_list() {
        let install = Install { executable: "/d".into(), version: "2609a".into(), user_dir: "/u dir".into(), config_dir: "/u dir/Config".into(), sys_dir: "/s".into() };
        let args = launch_args(&install, Path::new("/g/Mario Kart; rm -rf.rvz"), &["Graphics.Settings.InternalResolution=3".into()]);
        let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["-u", "/u dir", "--batch", "-C", NO_STOP_CONFIRM, "-C", "Graphics.Settings.InternalResolution=3", "--exec", "/g/Mario Kart; rm -rf.rvz"]);
    }
}
