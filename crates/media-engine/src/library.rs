//! Local media library scanner (spec §15). Scans only folders the user
//! explicitly added; never follows symlinks out of a root.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "m4v", "mov", "avi", "webm", "ts", "m2ts", "wmv", "flv", "mpg", "mpeg"];
pub const SUB_EXTS: &[&str] = &["srt", "vtt", "ass", "ssa"];
const MAX_DEPTH: usize = 8;
const MAX_FILES: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub path: String,
    pub root: String,
    pub title: String,
    pub year: Option<u16>,
    pub season: Option<u16>,
    pub episode: Option<u16>,
    pub size_bytes: u64,
    pub subtitles: Vec<String>,
    pub modified_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    #[error("folder does not exist or is not accessible")]
    NotFound,
    #[error("refusing to index a system or home-root folder")]
    TooBroad,
    #[error("path is outside your library folders")]
    OutsideRoots,
}

pub fn item_id(path: &Path) -> String {
    hex::encode(&Sha256::digest(path.to_string_lossy().as_bytes())[..12])
}

/// Reject roots that would amount to "scan the entire computer".
pub fn validate_root(root: &Path) -> Result<PathBuf, LibraryError> {
    let canon = root.canonicalize().map_err(|_| LibraryError::NotFound)?;
    if !canon.is_dir() {
        return Err(LibraryError::NotFound);
    }
    let too_broad = canon.parent().is_none() // "/" or "C:\"
        || dirs_home().is_some_and(|h| canon == h)
        || ["/System", "/Library", "/usr", "/bin", "/etc", "/private", "/Applications"].iter().any(|p| canon == Path::new(p))
        || canon.to_string_lossy().to_ascii_lowercase().ends_with(r":\windows");
    if too_broad {
        return Err(LibraryError::TooBroad);
    }
    Ok(canon)
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).and_then(|p| p.canonicalize().ok())
}

/// Path-traversal guard: the file must resolve inside one of the roots.
pub fn resolve_in_roots(path: &str, roots: &[String]) -> Result<PathBuf, LibraryError> {
    let canon = Path::new(path).canonicalize().map_err(|_| LibraryError::NotFound)?;
    let ok = roots.iter().filter_map(|r| Path::new(r).canonicalize().ok()).any(|r| canon.starts_with(&r));
    if ok && canon.is_file() {
        Ok(canon)
    } else {
        Err(LibraryError::OutsideRoots)
    }
}

/// "Kalki.2898.AD.2024.1080p.WEB-DL.mkv" → ("Kalki 2898 AD", 2024, None, None)
/// "The.Boys.S04E05.720p.mkv"           → ("The Boys", None, 4, 5)
pub fn parse_filename(stem: &str) -> (String, Option<u16>, Option<u16>, Option<u16>) {
    let cleaned: String = stem.chars().map(|c| if matches!(c, '.' | '_') { ' ' } else { c }).collect();
    let tokens: Vec<&str> = cleaned.split_whitespace().collect();
    let mut title_end = tokens.len();
    let (mut year, mut season, mut episode) = (None, None, None);
    for (i, t) in tokens.iter().enumerate() {
        let lower = t.to_ascii_lowercase();
        let trimmed = lower.trim_matches(|c| c == '(' || c == ')' || c == '[' || c == ']');
        if let Some((s, e)) = parse_sxxexx(trimmed) {
            season = Some(s);
            episode = Some(e);
            title_end = title_end.min(i);
            break;
        }
        if trimmed.len() == 4 && i > 0 {
            if let Ok(y) = trimmed.parse::<u16>() {
                if (1900..=2100).contains(&y) {
                    year = Some(y);
                    title_end = title_end.min(i);
                    // keep scanning for SxxEyy after the year
                    continue;
                }
            }
        }
        if ["1080p", "720p", "2160p", "480p", "4k", "web-dl", "webrip", "bluray", "hdrip", "x264", "x265", "hevc", "h264"].contains(&trimmed) {
            title_end = title_end.min(i);
            break;
        }
    }
    let title = tokens[..title_end].join(" ").trim_matches(['-', ' ']).to_string();
    (if title.is_empty() { stem.to_string() } else { title }, year, season, episode)
}

fn parse_sxxexx(t: &str) -> Option<(u16, u16)> {
    let rest = t.strip_prefix('s')?;
    let (s, e) = rest.split_once('e')?;
    let e: String = e.chars().take_while(|c| c.is_ascii_digit()).collect();
    Some((s.parse().ok()?, e.parse().ok()?))
}

pub fn scan(root: &Path) -> Result<Vec<LibraryItem>, LibraryError> {
    let root = validate_root(root)?;
    let root_str = root.to_string_lossy().into_owned();
    let mut out = Vec::new();
    for entry in WalkDir::new(&root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(Result::ok)
    {
        if out.len() >= MAX_FILES {
            break;
        }
        let p = entry.path();
        let Some(ext) = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase) else { continue };
        if !entry.file_type().is_file() || !VIDEO_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let meta = entry.metadata().ok();
        let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if stem.to_ascii_lowercase().contains("sample") && meta.as_ref().is_some_and(|m| m.len() < 200 * 1024 * 1024) {
            continue;
        }
        let (title, year, season, episode) = parse_filename(&stem);
        let subtitles = p
            .parent()
            .and_then(|dir| std::fs::read_dir(dir).ok())
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|sp| {
                sp.extension().and_then(|e| e.to_str()).is_some_and(|e| SUB_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                    && sp.file_stem().is_some_and(|s| s.to_string_lossy().starts_with(stem.as_str()))
            })
            .map(|sp| sp.to_string_lossy().into_owned())
            .take(20)
            .collect();
        out.push(LibraryItem {
            id: item_id(p),
            path: p.to_string_lossy().into_owned(),
            root: root_str.clone(),
            title,
            year,
            season,
            episode,
            size_bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            subtitles,
            modified_ms: meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_filenames() {
        assert_eq!(parse_filename("Kalki.2898.AD.2024.1080p.WEB-DL"), ("Kalki 2898 AD".into(), Some(2024), None, None));
        assert_eq!(parse_filename("The.Boys.S04E05.720p"), ("The Boys".into(), None, Some(4), Some(5)));
        assert_eq!(parse_filename("Mirzapur (2018) S03E02"), ("Mirzapur".into(), Some(2018), Some(3), Some(2)));
        assert_eq!(parse_filename("1917.2019.2160p"), ("1917".into(), Some(2019), None, None));
        assert_eq!(parse_filename("home_video"), ("home video".into(), None, None, None));
    }

    #[test]
    fn scans_only_videos_and_finds_subtitles() {
        let dir = std::env::temp_dir().join(format!("monitoros-lib-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Show/.hidden")).unwrap();
        fs::write(dir.join("Dune.Part.Two.2024.1080p.mkv"), b"x").unwrap();
        fs::write(dir.join("Dune.Part.Two.2024.1080p.en.srt"), b"1").unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        fs::write(dir.join("Show/The.Boys.S01E01.mp4"), b"x").unwrap();
        fs::write(dir.join("Show/.hidden/secret.mp4"), b"x").unwrap();
        let mut items = scan(&dir).unwrap();
        items.sort_by(|a, b| a.title.cmp(&b.title));
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Dune Part Two");
        assert_eq!(items[0].subtitles.len(), 1);
        assert_eq!(items[1].season, Some(1));

        let roots = vec![dir.to_string_lossy().into_owned()];
        assert!(resolve_in_roots(&items[0].path, &roots).is_ok());
        let traversal = format!("{}/Show/../../../etc/hosts", dir.display());
        assert!(matches!(resolve_in_roots(&traversal, &roots), Err(LibraryError::OutsideRoots) | Err(LibraryError::NotFound)));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_broad_roots() {
        assert!(matches!(validate_root(Path::new("/")), Err(LibraryError::TooBroad)));
        if let Some(h) = dirs_home() {
            assert!(matches!(validate_root(&h), Err(LibraryError::TooBroad)));
        }
    }
}
