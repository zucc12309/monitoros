//! Reads a game's 6-character ID (e.g. `RMCP01`) from the disc image header,
//! the same ID Dolphin uses for game settings and custom texture folders.
//! Only a few header bytes are read; the image is never modified.

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Where the disc header starts in each container format.
fn header_offset(ext: &str, magic: &[u8; 4]) -> Option<u64> {
    match ext {
        "iso" | "gcm" => Some(0),
        // WIA/RVZ: 0x48-byte header 1, then header 2 whose disc header copy is at +0x10.
        "rvz" | "wia" if magic == b"RVZ\x01" || magic == b"WIA\x01" => Some(0x58),
        // WBFS: one 512-byte HD sector of table, then the first disc's header.
        "wbfs" if magic == b"WBFS" => Some(0x200),
        // CISO: 0x8000-byte block map, then raw disc data.
        "ciso" if magic == b"CISO" => Some(0x8000),
        _ => None, // GCZ is compressed from byte 0x20; its ID needs decompression.
    }
}

/// A valid ID is 6 ASCII uppercase letters/digits.
pub fn valid_game_id(id: &str) -> bool {
    id.len() == 6 && id.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

pub fn read_game_id(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let mut f = std::fs::File::open(path).ok()?;
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).ok()?;
    let offset = header_offset(&ext, &magic)?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut id = [0u8; 6];
    f.read_exact(&mut id).ok()?;
    let id = std::str::from_utf8(&id).ok()?.to_string();
    valid_game_id(&id).then_some(id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Region {
    Pal,
    NtscU,
    NtscJ,
    NtscK,
    Unknown,
}

impl Region {
    /// The 4th character of the ID is the region code.
    pub fn of(game_id: &str) -> Region {
        match game_id.as_bytes().get(3) {
            Some(b'P' | b'D' | b'F' | b'S' | b'I' | b'U' | b'X' | b'Y' | b'H' | b'V') => Region::Pal,
            Some(b'E') => Region::NtscU,
            Some(b'J') => Region::NtscJ,
            Some(b'K' | b'Q' | b'T') => Region::NtscK,
            _ => Region::Unknown,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Region::Pal => "PAL / Europe",
            Region::NtscU => "NTSC-U / North America",
            Region::NtscJ => "NTSC-J / Japan",
            Region::NtscK => "Korea",
            Region::Unknown => "Unknown region",
        }
    }
}

/// Mario Kart Wii in any region (RMCP01, RMCE01, RMCJ01, RMCK01).
pub fn is_mario_kart_wii(game_id: &str) -> bool {
    game_id.starts_with("RMC")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("monitoros-disc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn reads_ids_from_each_format() {
        let mut iso = b"RMCE01".to_vec();
        iso.resize(0x100, 0);
        assert_eq!(read_game_id(&temp("a.iso", &iso)).as_deref(), Some("RMCE01"));

        let mut rvz = b"RVZ\x01".to_vec();
        rvz.resize(0x58, 0);
        rvz.extend_from_slice(b"RMCP01MarioKart");
        assert_eq!(read_game_id(&temp("b.rvz", &rvz)).as_deref(), Some("RMCP01"));

        let mut wbfs = b"WBFS".to_vec();
        wbfs.resize(0x200, 0);
        wbfs.extend_from_slice(b"RMCJ01");
        assert_eq!(read_game_id(&temp("c.wbfs", &wbfs)).as_deref(), Some("RMCJ01"));

        // Wrong magic for the extension, garbage IDs, and GCZ are not guessed.
        assert_eq!(read_game_id(&temp("d.rvz", &iso)), None);
        let mut junk = b"rm\0P01".to_vec();
        junk.resize(0x100, 0);
        assert_eq!(read_game_id(&temp("e.iso", &junk)), None);
        assert_eq!(read_game_id(&temp("f.gcz", &iso)), None);
        assert_eq!(read_game_id(Path::new("/nonexistent.iso")), None);
    }

    #[test]
    fn regions() {
        assert_eq!(Region::of("RMCP01"), Region::Pal);
        assert_eq!(Region::of("RMCE01"), Region::NtscU);
        assert_eq!(Region::of("RMCJ01"), Region::NtscJ);
        assert_eq!(Region::of("RMCK01"), Region::NtscK);
        assert_eq!(Region::of("RM"), Region::Unknown);
        assert!(is_mario_kart_wii("RMCK01") && !is_mario_kart_wii("SMNE01"));
    }
}
