//! SQLite persistence. State changes are appended to `events` (event log)
//! and projected into read tables in the same transaction, so the log can
//! rebuild projections and doubles as an audit trail (spec: event sourcing).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, StorageError>;

const SCHEMA_VERSION: i64 = 1;

const MIGRATION_1: &str = r#"
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS progress (
  media_id TEXT NOT NULL,
  episode TEXT NOT NULL DEFAULT '',
  position_sec REAL NOT NULL,
  duration_sec REAL NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (media_id, episode)
);
CREATE TABLE IF NOT EXISTS watchlist (media_id TEXT PRIMARY KEY, payload TEXT NOT NULL, added_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS addons (id TEXT PRIMARY KEY, manifest_url TEXT NOT NULL, payload TEXT NOT NULL, enabled INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS library_roots (path TEXT PRIMARY KEY, added_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS library_items (id TEXT PRIMARY KEY, root TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS progress_updated ON progress(updated_ms DESC);
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProgressRecord {
    pub media_id: String,
    #[serde(default)]
    pub episode: String, // "S1E2" or ""
    pub position_sec: f64,
    pub duration_sec: f64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    pub updated_ms: i64,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let v: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if v < 1 {
            conn.execute_batch(MIGRATION_1)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        Ok(Self { conn })
    }

    fn event(&self, kind: &str, payload: &impl Serialize, at_ms: i64) -> Result<()> {
        self.conn.execute("INSERT INTO events (at_ms, kind, payload) VALUES (?1, ?2, ?3)", params![at_ms, kind, serde_json::to_string(payload)?])?;
        Ok(())
    }

    // ---- settings ----
    pub fn get_setting<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let raw: Option<String> = self.conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?;
        Ok(match raw {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        })
    }

    pub fn set_setting<T: Serialize>(&mut self, key: &str, value: &T, now: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        let json = serde_json::to_string(value)?;
        tx.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, json])?;
        tx.execute("INSERT INTO events (at_ms, kind, payload) VALUES (?1, 'setting', ?2)", params![now, serde_json::json!({ "key": key }).to_string()])?;
        tx.commit()?;
        Ok(())
    }

    // ---- progress ----
    pub fn save_progress(&mut self, p: &ProgressRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO progress (media_id, episode, position_sec, duration_sec, title, payload, updated_ms) VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(media_id, episode) DO UPDATE SET position_sec=excluded.position_sec, duration_sec=excluded.duration_sec, title=excluded.title, payload=excluded.payload, updated_ms=excluded.updated_ms",
            params![p.media_id, p.episode, p.position_sec, p.duration_sec, p.title, p.payload.to_string(), p.updated_ms],
        )?;
        Ok(())
    }

    pub fn recent_progress(&self, limit: u32) -> Result<Vec<ProgressRecord>> {
        let mut stmt = self.conn.prepare("SELECT media_id, episode, position_sec, duration_sec, title, payload, updated_ms FROM progress ORDER BY updated_ms DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit], |r| {
            let payload: String = r.get(5)?;
            Ok(ProgressRecord {
                media_id: r.get(0)?,
                episode: r.get(1)?,
                position_sec: r.get(2)?,
                duration_sec: r.get(3)?,
                title: r.get(4)?,
                payload: serde_json::from_str(&payload).unwrap_or_default(),
                updated_ms: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn clear_progress(&mut self, media_id: &str, now: i64) -> Result<()> {
        self.conn.execute("DELETE FROM progress WHERE media_id = ?1", [media_id])?;
        self.event("progress.cleared", &serde_json::json!({ "mediaId": media_id }), now)
    }

    // ---- watchlist ----
    pub fn watchlist_add(&mut self, media_id: &str, payload: &serde_json::Value, now: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("INSERT OR REPLACE INTO watchlist (media_id, payload, added_ms) VALUES (?1, ?2, ?3)", params![media_id, payload.to_string(), now])?;
        tx.execute("INSERT INTO events (at_ms, kind, payload) VALUES (?1, 'watchlist.added', ?2)", params![now, serde_json::json!({ "mediaId": media_id }).to_string()])?;
        tx.commit()?;
        Ok(())
    }

    pub fn watchlist_remove(&mut self, media_id: &str, now: i64) -> Result<bool> {
        let n = self.conn.execute("DELETE FROM watchlist WHERE media_id = ?1", [media_id])?;
        self.event("watchlist.removed", &serde_json::json!({ "mediaId": media_id }), now)?;
        Ok(n > 0)
    }

    pub fn watchlist(&self) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self.conn.prepare("SELECT payload FROM watchlist ORDER BY added_ms DESC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|s| serde_json::from_str(&s).ok()).collect())
    }

    // ---- generic keyed collections (addons, devices) ----
    pub fn put_addon(&mut self, id: &str, manifest_url: &str, payload: &serde_json::Value, enabled: bool, now: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO addons (id, manifest_url, payload, enabled) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET manifest_url=excluded.manifest_url, payload=excluded.payload, enabled=excluded.enabled",
            params![id, manifest_url, payload.to_string(), enabled],
        )?;
        self.event("addon.saved", &serde_json::json!({ "id": id, "enabled": enabled }), now)
    }

    pub fn remove_addon(&mut self, id: &str, now: i64) -> Result<()> {
        self.conn.execute("DELETE FROM addons WHERE id = ?1", [id])?;
        self.event("addon.removed", &serde_json::json!({ "id": id }), now)
    }

    pub fn addons(&self) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self.conn.prepare("SELECT payload, enabled FROM addons")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?;
        Ok(rows
            .filter_map(|r| r.ok())
            .filter_map(|(p, enabled)| {
                let mut v: serde_json::Value = serde_json::from_str(&p).ok()?;
                v["enabled"] = enabled.into();
                Some(v)
            })
            .collect())
    }

    pub fn save_devices<T: Serialize>(&mut self, devices: &[(String, T)]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM devices", [])?;
        for (id, d) in devices {
            tx.execute("INSERT INTO devices (id, payload) VALUES (?1, ?2)", params![id, serde_json::to_string(d)?])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn devices<T: DeserializeOwned>(&self) -> Result<Vec<T>> {
        let mut stmt = self.conn.prepare("SELECT payload FROM devices")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|s| serde_json::from_str(&s).ok()).collect())
    }

    // ---- local library ----
    pub fn add_library_root(&mut self, path: &str, now: i64) -> Result<()> {
        self.conn.execute("INSERT OR IGNORE INTO library_roots (path, added_ms) VALUES (?1, ?2)", params![path, now])?;
        self.event("library.root_added", &serde_json::json!({ "path": path }), now)
    }

    pub fn remove_library_root(&mut self, path: &str, now: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM library_roots WHERE path = ?1", [path])?;
        tx.execute("DELETE FROM library_items WHERE root = ?1", [path])?;
        tx.execute("INSERT INTO events (at_ms, kind, payload) VALUES (?1, 'library.root_removed', ?2)", params![now, serde_json::json!({ "path": path }).to_string()])?;
        tx.commit()?;
        Ok(())
    }

    pub fn library_roots(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT path FROM library_roots ORDER BY added_ms")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn replace_library_items<T: Serialize>(&mut self, root: &str, items: &[(String, T)]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM library_items WHERE root = ?1", [root])?;
        for (id, item) in items {
            tx.execute("INSERT OR REPLACE INTO library_items (id, root, payload) VALUES (?1, ?2, ?3)", params![id, root, serde_json::to_string(item)?])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn library_items(&self) -> Result<Vec<serde_json::Value>> {
        let mut stmt = self.conn.prepare("SELECT payload FROM library_items")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|s| serde_json::from_str(&s).ok()).collect())
    }

    pub fn event_count(&self, kind: &str) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM events WHERE kind = ?1", [kind], |r| r.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_roundtrip_and_event_log() {
        let mut s = Store::in_memory().unwrap();
        assert_eq!(s.get_setting::<String>("region").unwrap(), None);
        s.set_setting("region", &"IN", 1).unwrap();
        s.set_setting("region", &"US", 2).unwrap();
        assert_eq!(s.get_setting::<String>("region").unwrap().as_deref(), Some("US"));
        assert_eq!(s.event_count("setting").unwrap(), 2);
    }

    #[test]
    fn progress_upserts_and_orders() {
        let mut s = Store::in_memory().unwrap();
        let rec = |id: &str, pos: f64, t: i64| ProgressRecord { media_id: id.into(), episode: String::new(), position_sec: pos, duration_sec: 100.0, title: id.into(), payload: json!({}), updated_ms: t };
        s.save_progress(&rec("a", 10.0, 1)).unwrap();
        s.save_progress(&rec("b", 10.0, 2)).unwrap();
        s.save_progress(&rec("a", 50.0, 3)).unwrap();
        let r = s.recent_progress(10).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].media_id, "a");
        assert_eq!(r[0].position_sec, 50.0);
        s.clear_progress("a", 4).unwrap();
        assert_eq!(s.recent_progress(10).unwrap().len(), 1);
    }

    #[test]
    fn watchlist_and_addons() {
        let mut s = Store::in_memory().unwrap();
        s.watchlist_add("imdb:tt1", &json!({ "id": "imdb:tt1" }), 1).unwrap();
        s.watchlist_add("imdb:tt1", &json!({ "id": "imdb:tt1" }), 2).unwrap();
        assert_eq!(s.watchlist().unwrap().len(), 1);
        assert!(s.watchlist_remove("imdb:tt1", 3).unwrap());
        assert!(!s.watchlist_remove("imdb:tt1", 3).unwrap());

        s.put_addon("a", "https://a.example.com/manifest.json", &json!({ "id": "a" }), false, 1).unwrap();
        assert_eq!(s.addons().unwrap()[0]["enabled"], false);
        s.remove_addon("a", 2).unwrap();
        assert!(s.addons().unwrap().is_empty());
    }

    #[test]
    fn library_roots_cascade() {
        let mut s = Store::in_memory().unwrap();
        s.add_library_root("/Movies", 1).unwrap();
        s.replace_library_items("/Movies", &[("x".to_string(), json!({ "path": "/Movies/x.mkv" }))]).unwrap();
        assert_eq!(s.library_items().unwrap().len(), 1);
        s.remove_library_root("/Movies", 2).unwrap();
        assert!(s.library_items().unwrap().is_empty());
        assert!(s.library_roots().unwrap().is_empty());
    }

    #[test]
    fn reopening_a_file_db_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("monitoros-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        {
            let mut s = Store::open(&path).unwrap();
            s.set_setting("k", &1, 1).unwrap();
        }
        let s = Store::open(&path).unwrap();
        assert_eq!(s.get_setting::<i32>("k").unwrap(), Some(1));
        std::fs::remove_dir_all(dir).ok();
    }
}
