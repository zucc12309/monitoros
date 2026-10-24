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
    pub config_dir: PathBuf,
}

/// Finds an installed, supported Dolphin.
pub fn detect() -> Result<Install, DolphinError> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let app = [PathBuf::from("/Applications/Dolphin.app"), home.join("Applications/Dolphin.app")]
            .into_iter()
            .find(|p| p.join("Contents/MacOS/Dolphin").is_file())
            .ok_or(DolphinError::NotInstalled)?;
        let plist = std::fs::read_to_string(app.join("Contents/Info.plist"))?;
        let version = plist_string(&plist, "CFBundleShortVersionString").ok_or(DolphinError::UnknownVersion)?;
        if !version_supported(&version) {
            return Err(DolphinError::TooOld(version));
        }
        Ok(Install {
            executable: app.join("Contents/MacOS/Dolphin"),
            version,
            config_dir: home.join("Library/Application Support/Dolphin/Config"),
        })
    }
    #[cfg(not(target_os = "macos"))]
    Err(DolphinError::NotInstalled)
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
/// A/B on the phone → A/B, Item → Z.
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
         Nunchuk/Stick/Right = `Left X+`\n",
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

/// Starts the game full screen without Dolphin's own menus. Arguments are
/// passed as a list (no shell), and the path is validated first.
pub fn launch(install: &Install, game: &Path) -> Result<Child, DolphinError> {
    let game = validate_game(game)?;
    Ok(Command::new(&install.executable)
        .arg("--batch")
        .arg("--exec")
        .arg(&game)
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
}
