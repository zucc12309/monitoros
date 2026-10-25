//! Custom texture packs, part 1: reading a downloaded pack without trusting it.
//!
//! A pack is a ZIP or an extracted folder. Before anything is extracted the
//! whole listing is checked: no absolute or `..` paths, no links, no
//! programs, no oversized or bomb-like entries. Then the folder Dolphin will
//! match on is found (a game-ID directory like `RMC`, possibly nested, or a
//! `<GameID>.txt` marker) and the textures in it are counted. Nothing in the
//! pack is ever executed, renamed or altered.

use crate::disc::{valid_game_id, Region};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const MAX_ENTRIES: usize = 100_000;
pub const MAX_FILE_BYTES: u64 = 512 << 20;
pub const MAX_TOTAL_BYTES: u64 = 32 << 30;
/// Uncompressed/compressed ratio above which a large entry is treated as a
/// compression bomb. Textures are PNG/DDS and barely compress.
const MAX_RATIO: u64 = 100;
const PROGRAM_EXTS: &[&str] = &["exe", "dll", "com", "bat", "cmd", "msi", "scr", "ps1", "vbs", "vbe", "js", "jse", "wsf", "jar", "sh", "command", "app", "dylib", "so", "py", "rb", "pl", "lnk", "reg", "pkg", "dmg", "apk"];

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PackError {
    #[error("{0} archives can't be opened safely here. Extract it yourself first, then choose the extracted folder.")]
    UnsupportedArchive(String),
    #[error("that isn't a texture pack: choose a .zip file or a folder")]
    NotAPack,
    #[error("refused: the pack contains an unsafe path ({0})")]
    UnsafePath(String),
    #[error("refused: the pack contains a link ({0}); texture packs never need links")]
    Link(String),
    #[error("refused: the pack contains a program ({0}); texture packs never need programs")]
    Program(String),
    #[error("refused: {0} is larger than {1} MB")]
    TooLarge(String, u64),
    #[error("refused: the pack is larger than {} GB", MAX_TOTAL_BYTES >> 30)]
    TooLargeTotal,
    #[error("refused: the pack has more than {MAX_ENTRIES} files")]
    TooManyFiles,
    #[error("refused: {0} expands far more than any texture would (possible compression bomb)")]
    Bomb(String),
    #[error("no Dolphin textures found: the pack needs PNG or DDS files named like tex1_64x64_…_14.png inside a game-ID folder such as RMC")]
    NoTextures,
    #[error("couldn't read the archive: {0}")]
    Archive(String),
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for PackError {
    fn from(e: std::io::Error) -> Self {
        PackError::Io(e.to_string())
    }
}

/// One file or folder in the pack. `path` always starts with the pack's own
/// top-level name (the picked folder's name, or the ZIP's first component).
#[derive(Debug, Clone)]
pub struct Entry {
    pub path: Vec<String>,
    pub size: u64,
    pub compressed: u64,
    pub is_dir: bool,
    /// Index inside the ZIP (unused for folders).
    pub index: usize,
}

impl Entry {
    pub fn name(&self) -> &str {
        self.path.last().map(String::as_str).unwrap_or("")
    }
    pub fn display(&self) -> String {
        self.path.join("/")
    }
    fn ext(&self) -> String {
        self.name().rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
    }
}

#[derive(Debug, Clone)]
pub enum Source {
    Folder(PathBuf),
    Zip(PathBuf),
}

impl Source {
    pub fn open(path: &Path) -> Result<Source, PackError> {
        let path = path.canonicalize().map_err(|_| PackError::NotAPack)?;
        if path.is_dir() {
            return Ok(Source::Folder(path));
        }
        let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
        match ext.as_str() {
            "zip" if path.is_file() => Ok(Source::Zip(path)),
            "7z" | "rar" | "tar" | "gz" | "tgz" | "xz" | "bz2" | "zst" => Err(PackError::UnsupportedArchive(ext.to_uppercase())),
            _ => Err(PackError::NotAPack),
        }
    }

    pub fn path(&self) -> &Path {
        match self {
            Source::Folder(p) | Source::Zip(p) => p,
        }
    }

    /// Lists every entry, refusing links and unsafe paths outright.
    pub fn entries(&self) -> Result<Vec<Entry>, PackError> {
        match self {
            Source::Folder(root) => {
                let top = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "pack".into());
                let mut out = vec![];
                let mut stack = vec![(root.clone(), vec![top])];
                while let Some((dir, prefix)) = stack.pop() {
                    for item in std::fs::read_dir(&dir)? {
                        let item = item?;
                        let name = item.file_name().into_string().map_err(|n| PackError::UnsafePath(n.to_string_lossy().into_owned()))?;
                        let mut path = prefix.clone();
                        path.push(name);
                        let meta = std::fs::symlink_metadata(item.path())?;
                        if meta.file_type().is_symlink() {
                            return Err(PackError::Link(path.join("/")));
                        }
                        if out.len() >= MAX_ENTRIES {
                            return Err(PackError::TooManyFiles);
                        }
                        if meta.is_dir() {
                            stack.push((item.path(), path.clone()));
                        }
                        out.push(Entry { path, size: if meta.is_dir() { 0 } else { meta.len() }, compressed: meta.len(), is_dir: meta.is_dir(), index: 0 });
                    }
                }
                Ok(out)
            }
            Source::Zip(file) => {
                let mut zip = open_zip(file)?;
                if zip.len() > MAX_ENTRIES {
                    return Err(PackError::TooManyFiles);
                }
                let mut out = vec![];
                for index in 0..zip.len() {
                    let f = zip.by_index_raw(index).map_err(|e| PackError::Archive(e.to_string()))?;
                    let raw = f.name().to_string();
                    let path = safe_components(&raw)?;
                    if f.enclosed_name().is_none() {
                        return Err(PackError::UnsafePath(raw));
                    }
                    if f.is_symlink() {
                        return Err(PackError::Link(raw));
                    }
                    if !path.is_empty() {
                        out.push(Entry { path, size: f.size(), compressed: f.compressed_size(), is_dir: f.is_dir(), index });
                    }
                }
                Ok(out)
            }
        }
    }

    /// Opens one file for reading, capped at its declared size.
    pub fn read_entry(&self, entry: &Entry, limit: u64, sink: &mut dyn FnMut(&mut dyn Read) -> std::io::Result<()>) -> Result<(), PackError> {
        match self {
            Source::Folder(root) => {
                let mut p = root.clone();
                p.extend(&entry.path[1..]);
                let f = std::fs::File::open(p)?;
                sink(&mut f.take(limit))?;
            }
            Source::Zip(file) => {
                let mut zip = open_zip(file)?;
                let f = zip.by_index(entry.index).map_err(|e| PackError::Archive(e.to_string()))?;
                sink(&mut f.take(limit))?;
            }
        }
        Ok(())
    }

    fn read_small(&self, entry: &Entry, limit: u64) -> Option<String> {
        let mut buf = vec![];
        self.read_entry(entry, limit, &mut |r| r.read_to_end(&mut buf).map(|_| ())).ok()?;
        Some(String::from_utf8_lossy(&buf).chars().filter(|c| !c.is_control() || *c == '\n').collect())
    }
}

fn open_zip(file: &Path) -> Result<zip::ZipArchive<std::fs::File>, PackError> {
    zip::ZipArchive::new(std::fs::File::open(file)?).map_err(|e| PackError::Archive(e.to_string()))
}

/// Splits an archive path into plain components, refusing absolute paths,
/// drive letters, `..` and NUL. Backslashes (Windows zippers) count as `/`.
pub fn safe_components(raw: &str) -> Result<Vec<String>, PackError> {
    let unsafe_path = || PackError::UnsafePath(raw.to_string());
    let norm = raw.replace('\\', "/");
    if norm.starts_with('/') || norm.contains('\0') {
        return Err(unsafe_path());
    }
    let mut out = vec![];
    for (i, c) in norm.split('/').enumerate() {
        match c {
            "" | "." => {}
            ".." => return Err(unsafe_path()),
            c if i == 0 && c.len() == 2 && c.ends_with(':') => return Err(unsafe_path()),
            c => out.push(c.to_string()),
        }
    }
    Ok(out)
}

/// Whole-pack limits and the no-programs rule.
pub fn check_entries(entries: &[Entry]) -> Result<(), PackError> {
    if entries.len() > MAX_ENTRIES {
        return Err(PackError::TooManyFiles);
    }
    let mut total = 0u64;
    for e in entries {
        if e.path.iter().any(|c| c.to_ascii_lowercase().ends_with(".app")) || (!e.is_dir && PROGRAM_EXTS.contains(&e.ext().as_str())) {
            return Err(PackError::Program(e.display()));
        }
        if e.size > MAX_FILE_BYTES {
            return Err(PackError::TooLarge(e.display(), MAX_FILE_BYTES >> 20));
        }
        if e.size > (1 << 20) && e.size / e.compressed.max(1) > MAX_RATIO {
            return Err(PackError::Bomb(e.display()));
        }
        total += e.size;
    }
    if total > MAX_TOTAL_BYTES {
        return Err(PackError::TooLargeTotal);
    }
    Ok(())
}

/// Dolphin's custom texture names: `tex1_<W>x<H>[_m]_<hash>[_<tlut>|_$]_<fmt>[_mip<N>|_arb]`
/// with a .png or .dds extension.
pub fn is_texture_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some(stem) = lower.strip_suffix(".png").or_else(|| lower.strip_suffix(".dds")) else { return false };
    let hex16 = |s: &str| s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit());
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mut parts: Vec<&str> = stem.split('_').collect();
    if parts.last().is_some_and(|p| *p == "arb" || p.strip_prefix("mip").is_some_and(digits)) {
        parts.pop();
    }
    let mut it = parts.into_iter().peekable();
    if it.next() != Some("tex1") {
        return false;
    }
    let Some((w, h)) = it.next().and_then(|s| s.split_once('x')) else { return false };
    if !digits(w) || !digits(h) {
        return false;
    }
    if it.peek() == Some(&"m") {
        it.next();
    }
    if !it.next().is_some_and(hex16) {
        return false;
    }
    let rest: Vec<&str> = it.collect();
    match rest.as_slice() {
        [fmt] => digits(fmt),
        [tlut, fmt] => (hex16(tlut) || *tlut == "$") && digits(fmt),
        _ => false,
    }
}

fn is_id_dir(c: &str) -> bool {
    (c.len() == 3 && c.as_bytes()[0].is_ascii_uppercase() && c.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())) || valid_game_id(c)
}

/// Dolphin uses a pack folder named `RMCP01` only for that exact game, and
/// one named `RMC` for every region of it.
pub fn id_matches(pack_id: &str, game_id: &str) -> bool {
    pack_id == game_id || (pack_id.len() == 3 && game_id.get(..3) == Some(pack_id))
}

pub fn regions_label(pack_id: &str) -> String {
    if pack_id.len() == 3 {
        format!("All regions ({pack_id}xxx)")
    } else {
        format!("{} only ({pack_id})", Region::of(pack_id).label())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instructions {
    pub file: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub source: String,
    pub archive: bool,
    pub name: String,
    pub version: Option<String>,
    pub authors: Option<String>,
    /// The game ID Dolphin will match the pack on (`RMC`, `RMCP01`, …).
    pub pack_id: String,
    /// The pack folder that will be installed, e.g. `Mario-Kart-…/RMC`.
    pub root: String,
    pub textures: usize,
    pub texture_bytes: u64,
    pub regions: String,
    /// `None` when no game has been chosen yet.
    pub compatible: Option<bool>,
    pub game_id: Option<String>,
    pub instructions: Vec<Instructions>,
    pub warnings: Vec<String>,
}

/// Where the textures live and what Dolphin will match them on.
#[derive(Debug, Clone, PartialEq)]
pub struct PackRoot {
    pub prefix: Vec<String>,
    pub pack_id: String,
}

/// Finds the folder that should go into Dolphin's `Load/Textures`.
/// Prefers one matching the user's game, then the shallowest, then the one
/// with the most textures.
pub fn find_root(entries: &[Entry], game_id: Option<&str>) -> Option<PackRoot> {
    let mut candidates: Vec<(PackRoot, usize)> = vec![];
    let mut add = |prefix: &[String], pack_id: &str| {
        let count = entries.iter().filter(|e| !e.is_dir && e.path.starts_with(prefix) && is_texture_name(e.name())).count();
        let root = PackRoot { prefix: prefix.to_vec(), pack_id: pack_id.to_string() };
        if count > 0 && !candidates.iter().any(|(c, _)| *c == root) {
            candidates.push((root, count));
        }
    };
    for e in entries.iter().filter(|e| !e.is_dir) {
        let n = e.path.len();
        if is_texture_name(e.name()) {
            for i in 0..n - 1 {
                if is_id_dir(&e.path[i]) {
                    add(&e.path[..=i], &e.path[i]);
                }
            }
        } else if let Some(id) = e.name().strip_suffix(".txt").filter(|s| is_id_dir(s)) {
            // Marker-style pack: <pack>/<GameID>.txt or <pack>/gameids/<GameID>.txt.
            let parent = if n >= 3 && e.path[n - 2].eq_ignore_ascii_case("gameids") { n - 2 } else { n - 1 };
            add(&e.path[..parent], id);
        }
    }
    candidates.sort_by_key(|(r, count)| (!game_id.is_some_and(|g| id_matches(&r.pack_id, g)), r.prefix.len(), usize::MAX - count));
    candidates.into_iter().next().map(|(r, _)| r)
}

fn pretty_name(stem: &str) -> (String, Option<String>) {
    let s = stem.replace(['-', '_'], " ");
    let words: Vec<&str> = s.split_whitespace().collect();
    match words.split_last() {
        Some((last, rest)) if !rest.is_empty() && last.trim_start_matches('v').split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) => (rest.join(" "), Some(last.trim_start_matches('v').to_string())),
        _ => (words.join(" "), None),
    }
}

/// Reads the pack and builds the import preview. Fails on anything unsafe.
pub fn inspect(source: &Source, game_id: Option<&str>) -> Result<(Preview, PackRoot, Vec<Entry>), PackError> {
    let entries = source.entries()?;
    check_entries(&entries)?;
    let root = find_root(&entries, game_id).ok_or(PackError::NoTextures)?;
    let under = |e: &&Entry| !e.is_dir && e.path.starts_with(&root.prefix);
    let textures: Vec<&Entry> = entries.iter().filter(under).filter(|e| is_texture_name(e.name())).collect();

    let mut warnings = vec![];
    let mut note = |n: usize, what: &str| {
        if n > 0 {
            warnings.push(format!("{n} {what}"));
        }
    };
    let ext_count = |exts: &[&str]| entries.iter().filter(under).filter(|e| exts.contains(&e.ext().as_str())).count();
    note(entries.iter().filter(|e| !e.is_dir && !e.path.starts_with(&root.prefix) && is_texture_name(e.name())).count(), "texture(s) sit outside the pack folder and won't be installed");
    note(entries.iter().filter(under).filter(|e| matches!(e.ext().as_str(), "png" | "dds") && !is_texture_name(e.name())).count(), "image(s) aren't named like Dolphin textures and won't be installed (Dolphin would ignore them)");
    note(ext_count(&["jpg", "jpeg", "tga", "bmp", "webp"]), "texture(s) are JPG/TGA/BMP/WebP, which Dolphin doesn't load (PNG and DDS only); skipped");
    note(ext_count(&["bak", "psd", "xcf", "kra"]), "backup or editor file(s) (.bak/.psd) skipped");
    note(entries.iter().filter(under).filter(|e| matches!(e.name(), "desktop.ini" | ".DS_Store" | "Thumbs.db")).count(), "system file(s) (desktop.ini, .DS_Store) skipped");
    // Dolphin keys textures by file name: when a name repeats (e.g. an
    // "Optional" variant folder), it keeps whichever copy it finds first.
    let mut seen = std::collections::HashSet::new();
    note(textures.iter().filter(|e| !seen.insert(e.name().to_ascii_lowercase())).count(), "texture name(s) appear more than once (e.g. in an Optional folder); Dolphin uses the first copy it finds, as with a manual install");
    if game_id.is_some_and(|g| !id_matches(&root.pack_id, g)) {
        warnings.push(format!("This pack is for {} but your game is {}: Dolphin won't load it for your game", root.pack_id, game_id.unwrap_or_default()));
    }

    // Readmes near the top: shown to the user, never acted on.
    let mut instructions = vec![];
    for e in entries.iter().filter(|e| !e.is_dir && e.ext() == "txt" && e.path.len() <= root.prefix.len() + 1 && e.size <= 64 << 10).take(4) {
        if let Some(text) = source.read_small(e, 8 << 10) {
            instructions.push(Instructions { file: e.display(), text: text.trim().to_string() });
        }
    }
    let info_line = |prefix: &str| instructions.iter().flat_map(|i| i.text.lines()).find_map(|l| l.trim().strip_prefix(prefix).map(|v| v.trim().to_string()));
    // A folder like `Pack-0.3.1` has no extension; only a ZIP's is dropped.
    let stem = match source {
        Source::Folder(p) => p.file_name(),
        Source::Zip(p) => p.file_stem(),
    };
    let stem = stem.map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let (name, version) = pretty_name(&stem);
    let preview = Preview {
        source: source.path().to_string_lossy().into_owned(),
        archive: matches!(source, Source::Zip(_)),
        name,
        version,
        authors: info_line("By:"),
        pack_id: root.pack_id.clone(),
        root: root.prefix.join("/"),
        textures: textures.len(),
        texture_bytes: textures.iter().map(|e| e.size).sum(),
        regions: regions_label(&root.pack_id),
        compatible: game_id.map(|g| id_matches(&root.pack_id, g)),
        game_id: game_id.map(str::to_string),
        instructions,
        warnings,
    };
    Ok((preview, root, entries))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(p: &str, size: u64) -> Entry {
        Entry { path: p.split('/').map(String::from).collect(), size, compressed: size, is_dir: false, index: 0 }
    }

    #[test]
    fn texture_names() {
        for ok in ["tex1_64x64_25baaf4d2500f22f_14.png", "tex1_1024x128_m_bd75015fc27cc0ab_14_mip1.png", "tex1_32x16_9ced590fe880c83b_1.png", "TEX1_8x8_0123456789abcdef_fedcba9876543210_9.DDS", "tex1_8x8_0123456789abcdef_$_9_arb.png"] {
            assert!(is_texture_name(ok), "{ok}");
        }
        for bad in ["tex1_64x4_1c54b81fe194d574_1.png.bak", "tex1_1024x1024_2be909aa20f40b15_14.jpg", "cover.png", "tex1_64x64_zz_14.png", "tex1_64x64_25baaf4d2500f22f.png", "tex1_axb_25baaf4d2500f22f_14.png"] {
            assert!(!is_texture_name(bad), "{bad}");
        }
    }

    #[test]
    fn unsafe_paths_are_refused() {
        assert_eq!(safe_components("Pack/RMC/a.png").unwrap(), ["Pack", "RMC", "a.png"]);
        assert_eq!(safe_components("Pack\\RMC\\.\\a.png").unwrap(), ["Pack", "RMC", "a.png"]);
        for bad in ["../evil.png", "Pack/../../evil", "/etc/passwd", "C:/Windows/x.dll", "C:\\x", "a/\0/b"] {
            assert!(matches!(safe_components(bad), Err(PackError::UnsafePath(_))), "{bad}");
        }
    }

    #[test]
    fn programs_bombs_and_size_limits() {
        let ok = vec![file("P/RMC/tex1_8x8_0123456789abcdef_14.png", 100)];
        assert!(check_entries(&ok).is_ok());
        for prog in ["P/RMC/install.exe", "P/run.sh", "P/Helper.app/Contents/x", "P/RMC/lib.dylib", "P/a.command"] {
            assert!(matches!(check_entries(&[file(prog, 1)]), Err(PackError::Program(_))), "{prog}");
        }
        assert!(matches!(check_entries(&[file("P/big.png", MAX_FILE_BYTES + 1)]), Err(PackError::TooLarge(..))));
        let bomb = Entry { compressed: 1000, ..file("P/x.png", 400 << 20) };
        assert!(matches!(check_entries(&[bomb]), Err(PackError::Bomb(_))));
    }

    #[test]
    fn finds_nested_game_folder_and_markers() {
        let entries = vec![
            file("Mario-Kart-Wii-HD-Remaster-0.3.1/Readme.txt", 10),
            file("Mario-Kart-Wii-HD-Remaster-0.3.1/RMC/UI/tex1_8x8_0123456789abcdef_14.png", 10),
            file("Mario-Kart-Wii-HD-Remaster-0.3.1/RMC/Optional/BloomShaderOff/tex1_8x8_1123456789abcdef_6.png", 10),
        ];
        let r = find_root(&entries, Some("RMCP01")).unwrap();
        assert_eq!((r.prefix.join("/").as_str(), r.pack_id.as_str()), ("Mario-Kart-Wii-HD-Remaster-0.3.1/RMC", "RMC"));
        // Picking the RMC folder itself works too.
        assert_eq!(find_root(&[file("RMC/tex1_8x8_0123456789abcdef_14.png", 1)], None).unwrap().pack_id, "RMC");
        let marker = vec![file("Pack/gameids/RMCE01.txt", 0), file("Pack/tracks/tex1_8x8_0123456789abcdef_14.png", 1)];
        assert_eq!(find_root(&marker, None).unwrap(), PackRoot { prefix: vec!["Pack".into()], pack_id: "RMCE01".into() });
        assert_eq!(find_root(&[file("Pack/readme.txt", 1)], None), None);
    }

    #[test]
    fn region_matching() {
        assert!(id_matches("RMC", "RMCP01") && id_matches("RMC", "RMCE01") && id_matches("RMC", "RMCK01"));
        assert!(id_matches("RMCP01", "RMCP01") && !id_matches("RMCP01", "RMCE01"));
        assert!(!id_matches("SMN", "RMCP01"));
        assert_eq!(regions_label("RMCJ01"), "NTSC-J / Japan only (RMCJ01)");
        assert!(regions_label("RMC").starts_with("All regions"));
        assert_eq!(pretty_name("Mario-Kart-Wii-HD-Remaster-0.3.1"), ("Mario Kart Wii HD Remaster".into(), Some("0.3.1".into())));
        assert_eq!(pretty_name("RMC"), ("RMC".into(), None));
    }
}
