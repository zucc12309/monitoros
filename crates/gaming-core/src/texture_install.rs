//! Custom texture packs, part 2: installing into Dolphin's `Load/Textures`.
//!
//! Each pack goes into its own folder, `Load/Textures/MonitorOS-<ID>/`, with
//! the pack's directory structure kept as-is. Dolphin finds it through a
//! `<ID>.txt` marker (HiresTextures: any `<GameID>.txt` below the textures
//! folder adds its top folder), so MonitorOS never takes the plain `RMC`
//! folder name a user may already use for a manual install. Switching the
//! pack off renames the marker; the files stay put.
//!
//! Installs are staged in a sibling folder and swapped in with renames, so a
//! failed or interrupted install leaves the previous state untouched. Only
//! folders carrying MonitorOS's manifest are ever replaced or removed.

use crate::textures::{id_matches, is_texture_name, Entry, PackError, PackRoot, Preview, Source, MAX_FILE_BYTES};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MANIFEST: &str = "monitoros-pack.json";
const STAGING_MARK: &str = ".monitoros-staging";
const DISABLED_SUFFIX: &str = ".disabled";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub name: String,
    pub version: Option<String>,
    pub authors: Option<String>,
    pub pack_id: String,
    /// Where it was imported from. The original is never moved or changed.
    pub source: String,
    pub textures: usize,
    pub bytes: u64,
    pub installed_ms: u64,
    /// Texture names (without extension), to recognise them in Dolphin's log.
    pub names: Vec<String>,
}

pub fn textures_root(user_dir: &Path) -> PathBuf {
    user_dir.join("Load").join("Textures")
}

pub fn managed_dir(user_dir: &Path, pack_id: &str) -> PathBuf {
    textures_root(user_dir).join(format!("MonitorOS-{pack_id}"))
}

fn marker(dir: &Path, pack_id: &str) -> PathBuf {
    dir.join(format!("{pack_id}.txt"))
}

pub fn read_manifest(dir: &Path) -> Option<Manifest> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(MANIFEST)).ok()?).ok()
}

fn is_ours(dir: &Path) -> bool {
    read_manifest(dir).is_some()
}

fn image_magic_ok(head: &[u8], name: &str) -> bool {
    if name.to_ascii_lowercase().ends_with(".dds") {
        head.starts_with(b"DDS ")
    } else {
        head.starts_with(b"\x89PNG\r\n\x1a\n")
    }
}

/// Copies one texture byte-for-byte, refusing anything that isn't really a
/// PNG/DDS or doesn't match its declared size.
fn copy_texture(source: &Source, e: &Entry, dest: &Path) -> Result<(), PackError> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(dest)?;
    let mut written = 0u64;
    let mut magic_ok = false;
    source.read_entry(e, e.size.min(MAX_FILE_BYTES) + 1, &mut |r| {
        let mut buf = vec![0u8; 256 << 10];
        loop {
            let n = r.read(&mut buf)?;
            if n == 0 {
                return Ok(());
            }
            if written == 0 {
                magic_ok = image_magic_ok(&buf[..n], e.name());
                if !magic_ok {
                    return Ok(());
                }
            }
            out.write_all(&buf[..n])?;
            written += n as u64;
        }
    })?;
    if !magic_ok || written != e.size {
        drop(out);
        let _ = std::fs::remove_file(dest);
        return Err(PackError::Io(format!("{} isn't a valid image or doesn't match the archive listing", e.display())));
    }
    out.sync_all()?;
    Ok(())
}

pub struct Progress<'a> {
    pub report: &'a (dyn Fn(usize, usize) + Sync),
}

/// Installs the pack the user previewed. Returns the manifest written.
pub fn install(source: &Source, preview: &Preview, root: &PackRoot, entries: &[Entry], user_dir: &Path, now_ms: u64, progress: Progress<'_>) -> Result<Manifest, PackError> {
    let base = textures_root(user_dir);
    std::fs::create_dir_all(&base)?;
    let final_dir = managed_dir(user_dir, &root.pack_id);
    if final_dir.exists() && !is_ours(&final_dir) {
        return Err(PackError::Io(format!("{} already exists and wasn't made by MonitorOS; move it away first", final_dir.display())));
    }
    let staging = base.join(format!(".MonitorOS-{}.staging", root.pack_id));
    if staging.exists() {
        // Left over from an interrupted install: only ever our own folder.
        if !staging.join(STAGING_MARK).exists() {
            return Err(PackError::Io(format!("{} exists and wasn't made by MonitorOS", staging.display())));
        }
        std::fs::remove_dir_all(&staging)?;
    }
    std::fs::create_dir_all(&staging)?;
    std::fs::write(staging.join(STAGING_MARK), "")?;

    let result = (|| {
        let keep = root.prefix.len() - 1; // keep the pack's own ID folder name
        let textures: Vec<&Entry> = entries.iter().filter(|e| !e.is_dir && e.path.starts_with(&root.prefix) && is_texture_name(e.name())).collect();
        let mut names = Vec::with_capacity(textures.len());
        for (i, e) in textures.iter().enumerate() {
            let mut dest = staging.clone();
            dest.extend(&e.path[keep..]);
            copy_texture(source, e, &dest)?;
            names.push(e.name().rsplit_once('.').map(|(s, _)| s).unwrap_or(e.name()).to_string());
            (progress.report)(i + 1, textures.len());
        }
        let manifest = Manifest {
            name: preview.name.clone(),
            version: preview.version.clone(),
            authors: preview.authors.clone(),
            pack_id: root.pack_id.clone(),
            source: preview.source.clone(),
            textures: textures.len(),
            bytes: textures.iter().map(|e| e.size).sum(),
            installed_ms: now_ms,
            names,
        };
        std::fs::write(staging.join(MANIFEST), serde_json::to_vec_pretty(&manifest).map_err(|e| PackError::Io(e.to_string()))?)?;
        // Keep the user's on/off choice across a replace; new installs start on.
        let was_disabled = final_dir.exists() && !marker(&final_dir, &root.pack_id).exists();
        let mark = marker(&staging, &root.pack_id);
        let mark = if was_disabled { mark.with_extension(format!("txt{DISABLED_SUFFIX}")) } else { mark };
        std::fs::write(mark, format!("Managed by MonitorOS: {}. Dolphin loads this folder for {} games. Remove or rename this file to stop it.\n", manifest.name, root.pack_id))?;
        std::fs::remove_file(staging.join(STAGING_MARK))?;
        Ok(manifest)
    })();

    let manifest = match result {
        Ok(m) => m,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    // Swap in: old → .old, staging → final, then drop old. Roll back on failure.
    let old = base.join(format!(".MonitorOS-{}.old", root.pack_id));
    if old.exists() && is_ours(&old) {
        std::fs::remove_dir_all(&old)?;
    }
    let had_old = final_dir.exists();
    if had_old {
        std::fs::rename(&final_dir, &old)?;
    }
    if let Err(e) = std::fs::rename(&staging, &final_dir) {
        if had_old {
            let _ = std::fs::rename(&old, &final_dir);
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e.into());
    }
    if had_old {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(manifest)
}

/// Turns the pack on or off for Dolphin by renaming its marker.
pub fn set_enabled(user_dir: &Path, pack_id: &str, on: bool) -> Result<(), PackError> {
    let dir = managed_dir(user_dir, pack_id);
    if !is_ours(&dir) {
        return Err(PackError::Io("no MonitorOS texture pack is installed for this game".into()));
    }
    let enabled = marker(&dir, pack_id);
    let disabled = enabled.with_extension(format!("txt{DISABLED_SUFFIX}"));
    match (on, enabled.exists(), disabled.exists()) {
        (true, false, true) => std::fs::rename(&disabled, &enabled)?,
        (false, true, _) => std::fs::rename(&enabled, &disabled)?,
        (true, false, false) => std::fs::write(&enabled, "Managed by MonitorOS.\n")?,
        _ => {}
    }
    Ok(())
}

/// Deletes MonitorOS's installed copy only (never the original download).
pub fn remove(user_dir: &Path, pack_id: &str) -> Result<(), PackError> {
    let dir = managed_dir(user_dir, pack_id);
    if !is_ours(&dir) {
        return Err(PackError::Io("no MonitorOS texture pack is installed for this game".into()));
    }
    Ok(std::fs::remove_dir_all(dir)?)
}

/// The folders Dolphin will load textures from for `game_id`, worked out
/// exactly as HiresTextures does (GetTextureDirectoriesWithGameId).
pub fn dolphin_texture_dirs(user_dir: &Path, game_id: &str) -> Vec<PathBuf> {
    let root = textures_root(user_dir);
    let short = &game_id[..game_id.len().min(3)];
    let mut out = vec![];
    if root.join(game_id).is_dir() {
        out.push(root.join(game_id));
    } else if root.join(short).is_dir() {
        out.push(root.join(short));
    }
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(items) = std::fs::read_dir(&dir) else { continue };
        for item in items.flatten() {
            let p = item.path();
            let Ok(ft) = item.file_type() else { continue };
            if ft.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("txt")) {
                let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                if stem == game_id || stem == short || stem == "all" {
                    if let Some(top) = p.strip_prefix(&root).ok().and_then(|r| r.components().next()) {
                        let top = root.join(top.as_os_str());
                        if top.is_dir() && !out.contains(&top) {
                            out.push(top);
                        }
                    }
                }
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStatus {
    pub manifest: Option<Manifest>,
    pub folder: String,
    /// The marker is in place (the pack isn't switched off).
    pub enabled: bool,
    /// Dolphin's own lookup rule finds the folder for this game.
    pub discoverable: bool,
    /// Texture files actually present in the installed folder.
    pub files_present: usize,
    /// Other folders Dolphin also loads for this game (e.g. a manual install).
    pub other_folders: Vec<String>,
}

pub fn status(user_dir: &Path, pack_id: &str, game_id: &str) -> PackStatus {
    let dir = managed_dir(user_dir, pack_id);
    let manifest = read_manifest(&dir);
    let dirs = dolphin_texture_dirs(user_dir, game_id);
    let mut files_present = 0;
    let mut stack = vec![dir.clone()];
    while let Some(d) = stack.pop() {
        for item in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            match item.file_type() {
                Ok(t) if t.is_dir() => stack.push(item.path()),
                Ok(t) if t.is_file() && is_texture_name(&item.file_name().to_string_lossy()) => files_present += 1,
                _ => {}
            }
        }
    }
    PackStatus {
        enabled: manifest.is_some() && marker(&dir, pack_id).exists(),
        discoverable: manifest.is_some() && id_matches(pack_id, game_id) && dirs.contains(&dir),
        other_folders: dirs.iter().filter(|d| **d != dir).map(|d| d.display().to_string()).collect(),
        folder: dir.display().to_string(),
        files_present,
        manifest,
    }
}

/// Textures from `names` that Dolphin's log says it loaded
/// (`CustomAssetLoader thread N loaded: <name> (...)`, VideoCommon).
pub fn loaded_from_log(log: &str, names: &std::collections::HashSet<&str>) -> usize {
    let mut seen = std::collections::HashSet::new();
    for line in log.lines().filter(|l| l.contains("CustomAssetLoader")) {
        if let Some(rest) = line.split_once("loaded: ").map(|(_, r)| r) {
            let id = rest.split(' ').next().unwrap_or("");
            if names.contains(id) {
                seen.insert(id.to_string());
            }
        }
    }
    seen.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::textures::inspect;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest-of-image";

    struct Fixture {
        dir: PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture(tag: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!("monitoros-tex-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let pack = dir.join("Downloads/Mario-Kart-Wii-HD-Remaster-0.3.1");
        let w = |p: &str, b: &[u8]| {
            let p = pack.join(p);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b).unwrap();
        };
        w("Readme.txt", b"Move RMC folder to Load/Textures\n");
        w("info.txt", b"Mario Kart Wii HD Remaster\nBy: Moukrea, Walamo15\n");
        w("RMC/UI/tex1_8x8_0123456789abcdef_14.png", PNG);
        w("RMC/Stages/Rainbow Road/tex1_8x8_1123456789abcdef_14_mip1.png", PNG);
        w("RMC/UI/Menu/tex1_64x4_1c54b81fe194d574_1.png.bak", b"x");
        w("RMC/Stages/x/tex1_1024x1024_2be909aa20f40b15_14.jpg", b"x");
        w("RMC/Kart/desktop.ini", b"x");
        w("RMC/Optional/BloomShaderOff/tex1_8x8_0123456789abcdef_14.png", PNG);
        // The user's controller settings must never be touched.
        let cfg = dir.join("User/Config");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join("WiimoteNew.ini"), "[Wiimote1]\nDevice = DSUClient/0/MonitorOS\n").unwrap();
        std::fs::write(cfg.join("GFX.ini"), "[Settings]\nInternalResolution = 1\n").unwrap();
        Fixture { dir }
    }

    fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
        let mut v: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), std::fs::read(e.path()).unwrap())).collect();
        v.sort();
        v
    }

    fn do_install(f: &Fixture) -> Result<Manifest, PackError> {
        let src = Source::open(&f.dir.join("Downloads/Mario-Kart-Wii-HD-Remaster-0.3.1")).unwrap();
        let (preview, root, entries) = inspect(&src, Some("RMCP01"))?;
        install(&src, &preview, &root, &entries, &f.dir.join("User"), 1, Progress { report: &|_, _| {} })
    }

    #[test]
    fn preview_reports_pack_details() {
        let f = fixture("preview");
        let src = Source::open(&f.dir.join("Downloads/Mario-Kart-Wii-HD-Remaster-0.3.1")).unwrap();
        let (p, root, _) = inspect(&src, Some("RMCP01")).unwrap();
        assert_eq!((p.name.as_str(), p.version.as_deref(), p.authors.as_deref()), ("Mario Kart Wii HD Remaster", Some("0.3.1"), Some("Moukrea, Walamo15")));
        assert_eq!((p.pack_id.as_str(), p.textures, p.compatible), ("RMC", 3, Some(true)));
        assert!(p.warnings.iter().any(|w| w.starts_with("1 texture name(s) appear more than once")));
        assert_eq!(root.prefix.last().unwrap(), "RMC");
        assert!(p.warnings.iter().any(|w| w.contains("JPG")));
        assert!(p.warnings.iter().any(|w| w.contains(".bak")));
        assert!(p.instructions.iter().any(|i| i.text.contains("Load/Textures")));
        let (wrong, _, _) = inspect(&src, Some("SMNE01")).unwrap();
        assert_eq!(wrong.compatible, Some(false));
    }

    #[test]
    fn installs_discoverably_and_toggles() {
        let f = fixture("install");
        let user = f.dir.join("User");
        let before = snapshot(&user.join("Config"));
        let m = do_install(&f).unwrap();
        assert_eq!(m.textures, 3);
        let dir = managed_dir(&user, "RMC");
        // Structure and bytes preserved; junk not copied.
        assert_eq!(std::fs::read(dir.join("RMC/Stages/Rainbow Road/tex1_8x8_1123456789abcdef_14_mip1.png")).unwrap(), PNG);
        assert!(!dir.join("RMC/UI/Menu/tex1_64x4_1c54b81fe194d574_1.png.bak").exists());
        assert!(!dir.join("RMC/Kart/desktop.ini").exists());
        let s = status(&user, "RMC", "RMCP01");
        assert!(s.enabled && s.discoverable && s.other_folders.is_empty());
        assert_eq!(s.files_present, 3);
        assert_eq!(dolphin_texture_dirs(&user, "RMCE01"), vec![dir.clone()]); // every region
        assert!(dolphin_texture_dirs(&user, "SMNE01").is_empty());

        set_enabled(&user, "RMC", false).unwrap();
        let off = status(&user, "RMC", "RMCP01");
        assert!(!off.enabled && !off.discoverable && off.files_present == 3);
        // Replacing keeps the user's off switch.
        do_install(&f).unwrap();
        assert!(!status(&user, "RMC", "RMCP01").enabled);
        set_enabled(&user, "RMC", true).unwrap();
        assert!(status(&user, "RMC", "RMCP01").discoverable);

        // The original download is untouched, and controller/graphics files too.
        assert!(f.dir.join("Downloads/Mario-Kart-Wii-HD-Remaster-0.3.1/RMC/UI/tex1_8x8_0123456789abcdef_14.png").exists());
        assert_eq!(snapshot(&user.join("Config")), before);
        remove(&user, "RMC").unwrap();
        assert!(!dir.exists());
        assert_eq!(snapshot(&user.join("Config")), before);
    }

    #[test]
    fn never_replaces_folders_it_did_not_make() {
        let f = fixture("foreign");
        let user = f.dir.join("User");
        let foreign = managed_dir(&user, "RMC");
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join("mine.png"), b"user's").unwrap();
        assert!(do_install(&f).is_err());
        assert_eq!(std::fs::read(foreign.join("mine.png")).unwrap(), b"user's");
        assert!(remove(&user, "RMC").is_err() && set_enabled(&user, "RMC", false).is_err());
        // A manual RMC install is reported, never moved.
        std::fs::remove_dir_all(&foreign).unwrap();
        std::fs::create_dir_all(textures_root(&user).join("RMC")).unwrap();
        do_install(&f).unwrap();
        assert_eq!(status(&user, "RMC", "RMCP01").other_folders.len(), 1);
    }

    #[test]
    fn failed_install_rolls_back() {
        let f = fixture("rollback");
        let user = f.dir.join("User");
        do_install(&f).unwrap();
        let good = std::fs::read_to_string(managed_dir(&user, "RMC").join(MANIFEST)).unwrap();
        // A "PNG" that isn't one makes the second install fail midway.
        std::fs::write(f.dir.join("Downloads/Mario-Kart-Wii-HD-Remaster-0.3.1/RMC/UI/tex1_8x8_2123456789abcdef_14.png"), b"MZ\x90\x00 not an image").unwrap();
        assert!(do_install(&f).is_err());
        assert_eq!(std::fs::read_to_string(managed_dir(&user, "RMC").join(MANIFEST)).unwrap(), good);
        assert!(!textures_root(&user).join(".MonitorOS-RMC.staging").exists());
    }

    #[test]
    fn zip_packs_install_and_unsafe_zips_are_refused() {
        let f = fixture("zip");
        let zip_path = f.dir.join("pack.zip");
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let mut z = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
        z.start_file("Pack-1.0/RMC/tex1_8x8_0123456789abcdef_14.png", opts).unwrap();
        z.write_all(PNG).unwrap();
        z.finish().unwrap();
        let src = Source::open(&zip_path).unwrap();
        let (p, root, entries) = inspect(&src, Some("RMCE01")).unwrap();
        assert!(p.archive && p.textures == 1);
        let user = f.dir.join("User");
        install(&src, &p, &root, &entries, &user, 1, Progress { report: &|_, _| {} }).unwrap();
        assert_eq!(std::fs::read(managed_dir(&user, "RMC").join("RMC/tex1_8x8_0123456789abcdef_14.png")).unwrap(), PNG);

        for (name, bad) in [("evil1.zip", "../../escape.png"), ("evil2.zip", "Pack/RMC/setup.exe")] {
            let p = f.dir.join(name);
            let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
            z.start_file("Pack/RMC/tex1_8x8_0123456789abcdef_14.png", opts).unwrap();
            z.write_all(PNG).unwrap();
            z.start_file(bad, opts).unwrap();
            z.write_all(b"x").unwrap();
            z.finish().unwrap();
            assert!(inspect(&Source::open(&p).unwrap(), None).is_err(), "{bad}");
        }
        let p = f.dir.join("link.zip");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&p).unwrap());
        z.add_symlink("Pack/RMC/link", "/etc", opts).unwrap();
        z.finish().unwrap();
        assert!(matches!(inspect(&Source::open(&p).unwrap(), None), Err(PackError::Link(_))));
        assert!(matches!(Source::open(&f.dir.join("Readme.7z")), Err(PackError::NotAPack)));
        std::fs::write(f.dir.join("pack.7z"), b"7z").unwrap();
        assert!(matches!(Source::open(&f.dir.join("pack.7z")), Err(PackError::UnsupportedArchive(_))));
    }

    #[test]
    fn folder_links_are_refused() {
        #[cfg(unix)]
        {
            let f = fixture("link");
            let pack = f.dir.join("Downloads/Mario-Kart-Wii-HD-Remaster-0.3.1/RMC");
            std::os::unix::fs::symlink("/etc", pack.join("escape")).unwrap();
            let src = Source::open(&f.dir.join("Downloads/Mario-Kart-Wii-HD-Remaster-0.3.1")).unwrap();
            assert!(matches!(inspect(&src, None), Err(PackError::Link(_))));
        }
    }

    #[test]
    fn reads_load_evidence_from_dolphin_log() {
        let log = "12:00:01:123 VideoCommon/Assets/CustomAssetLoader.cpp:107 I[Video]: CustomAssetLoader thread 0 loaded: tex1_8x8_0123456789abcdef_14 (12 KiB)\n\
                   12:00:01:124 VideoCommon/Assets/CustomAssetLoader.cpp:107 I[Video]: CustomAssetLoader thread 1 loaded: tex1_8x8_0123456789abcdef_14 (12 KiB)\n\
                   12:00:01:125 VideoCommon/Assets/CustomAssetLoader.cpp:107 I[Video]: CustomAssetLoader thread 1 loaded: tex1_9x9_ffffffffffffffff_14 (1 KiB)\n";
        let names: std::collections::HashSet<&str> = ["tex1_8x8_0123456789abcdef_14"].into();
        assert_eq!(loaded_from_log(log, &names), 1);
        assert_eq!(loaded_from_log("nothing here", &names), 0);
    }
}
