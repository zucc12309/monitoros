//! mpv process controller over the JSON IPC protocol.
//! https://mpv.io/manual/stable/#json-ipc
//!
//! mpv runs as a separate process (crash isolation; a bad file can't take the
//! launcher down). The URL is passed after `--` so it can never be parsed as
//! an option, and no shell is involved.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

#[derive(Debug, thiserror::Error)]
pub enum MpvError {
    #[error("mpv is not installed")]
    NotInstalled,
    #[error("refusing to open this location")]
    UnsafeTarget,
    #[error("failed to start mpv: {0}")]
    Spawn(String),
    #[error("could not connect to mpv IPC")]
    Ipc,
    #[error("mpv command failed: {0}")]
    Command(String),
    #[error("player is not running")]
    NotRunning,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum MpvEvent {
    Started,
    Time { position: f64 },
    Duration { duration: f64 },
    Pause { paused: bool },
    Buffering { buffering: bool },
    Ended { reason: String },
    Exited { code: Option<i32> },
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PlayOptions {
    pub title: Option<String>,
    pub start_sec: Option<f64>,
    pub fullscreen: bool,
    pub subtitle_urls: Vec<String>,
    /// e.g. "auto-safe" (default) or "no" on machines with broken drivers.
    pub hwdec: Option<String>,
    pub audio_device: Option<String>,
    /// Bounded demuxer cache for HDD/8 GB machines (MiB).
    pub cache_mib: Option<u32>,
    /// No window or audio output (automated tests, diagnostics).
    #[serde(default)]
    pub headless: bool,
}

pub fn find_mpv() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(if cfg!(windows) { "mpv.exe" } else { "mpv" }));
        }
    }
    if cfg!(target_os = "macos") {
        candidates.extend(["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv", "/Applications/mpv.app/Contents/MacOS/mpv"].map(PathBuf::from));
    }
    if cfg!(windows) {
        for var in ["ProgramFiles", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(var) {
                candidates.push(Path::new(&base).join("mpv").join("mpv.exe"));
            }
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            candidates.push(Path::new(&home).join("scoop").join("shims").join("mpv.exe"));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(if cfg!(windows) { "mpv.exe" } else { "mpv" }));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Accepts http(s) URLs or absolute local paths; anything else is refused.
pub fn validate_target(target: &str) -> Result<(), MpvError> {
    if target.starts_with('-') || target.contains('\0') || target.contains('\n') {
        return Err(MpvError::UnsafeTarget);
    }
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return Ok(());
    }
    if lower.contains("://") || lower.starts_with("av:") || lower.starts_with("lavfi") || lower.starts_with("memory:") {
        return Err(MpvError::UnsafeTarget); // edl://, file://, av://, etc.
    }
    if Path::new(target).is_absolute() {
        return Ok(());
    }
    Err(MpvError::UnsafeTarget)
}

pub fn build_args(ipc: &str, target: &str, o: &PlayOptions) -> Vec<String> {
    let mut a = vec![
        format!("--input-ipc-server={ipc}"),
        "--no-terminal".into(),
        "--keep-open=no".into(),
        "--idle=no".into(),
        "--osc=yes".into(),
        "--ytdl=no".into(), // never shell out to youtube-dl on provider URLs
        "--load-scripts=no".into(), // user/global scripts must not run under MonitorOS
        "--config=no".into(),
        format!("--hwdec={}", o.hwdec.as_deref().filter(|h| h.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).unwrap_or("auto-safe")),
        format!("--demuxer-max-bytes={}MiB", o.cache_mib.unwrap_or(150).clamp(32, 1024)),
        "--demuxer-max-back-bytes=50MiB".into(),
        "--network-timeout=30".into(),
        "--sub-auto=fuzzy".into(),
    ];
    if o.headless {
        a.extend(["--vo=null".into(), "--ao=null".into()]);
    } else {
        a.push("--force-window=immediate".into());
    }
    if o.fullscreen {
        a.push("--fs".into());
    }
    if let Some(s) = o.start_sec.filter(|s| s.is_finite() && *s > 0.0) {
        a.push(format!("--start={s:.1}"));
    }
    if let Some(t) = &o.title {
        let clean: String = t.chars().filter(|c| !c.is_control()).take(120).collect();
        a.push(format!("--force-media-title={clean}"));
    }
    if let Some(dev) = &o.audio_device {
        if !dev.contains('\n') && !dev.starts_with('-') {
            a.push(format!("--audio-device={dev}"));
        }
    }
    for s in o.subtitle_urls.iter().filter(|s| validate_target(s).is_ok()).take(10) {
        a.push(format!("--sub-file={s}"));
    }
    a.push("--".into());
    a.push(target.into());
    a
}

fn ipc_path() -> String {
    let id = format!("monitoros-mpv-{}-{}", std::process::id(), rand_suffix());
    if cfg!(windows) {
        format!(r"\\.\pipe\{id}")
    } else {
        std::env::temp_dir().join(format!("{id}.sock")).to_string_lossy().into_owned()
    }
}

fn rand_suffix() -> u64 {
    static N: AtomicU64 = AtomicU64::new(0);
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0) ^ N.fetch_add(1, Ordering::Relaxed)
}

type Pending = Arc<Mutex<std::collections::HashMap<u64, oneshot::Sender<Value>>>>;

pub struct MpvSession {
    child: Child,
    writer: mpsc::Sender<String>,
    pending: Pending,
    next_id: AtomicU64,
    pub events: broadcast::Sender<MpvEvent>,
    ipc: String,
}

impl MpvSession {
    /// Starts mpv and returns the session plus an event receiver that was
    /// subscribed *before* property observation began, so one-shot events
    /// (the initial `duration`) can't be missed.
    pub async fn spawn(mpv: &Path, target: &str, opts: &PlayOptions) -> Result<(Self, broadcast::Receiver<MpvEvent>), MpvError> {
        validate_target(target)?;
        let ipc = ipc_path();
        let child = Command::new(mpv)
            .args(build_args(&ipc, target, opts))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| MpvError::Spawn(e.to_string()))?;

        let (events, _) = broadcast::channel(256);
        let pending: Pending = Arc::default();
        let (writer, mut rx) = mpsc::channel::<String>(64);

        // Connect with retries while mpv creates the socket/pipe.
        let mut connected = None;
        for _ in 0..50 {
            if let Ok(conn) = connect(&ipc).await {
                connected = Some(conn);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let (read_half, mut write_half) = connected.ok_or(MpvError::Ipc)?;

        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if write_half.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        let ev = events.clone();
        let pend = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(read_half).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(id) = v.get("request_id").and_then(Value::as_u64) {
                    if let Some(tx) = pend.lock().await.remove(&id) {
                        let _ = tx.send(v);
                    }
                    continue;
                }
                if let Some(e) = translate_event(&v) {
                    let _ = ev.send(e);
                }
            }
        });

        let rx = events.subscribe();
        let s = Self { child, writer, pending, next_id: AtomicU64::new(1), events, ipc };
        for (i, prop) in ["time-pos", "duration", "pause", "paused-for-cache"].iter().enumerate() {
            s.send_raw(json!({ "command": ["observe_property", i + 1, prop] })).await?;
        }
        let _ = s.events.send(MpvEvent::Started);
        Ok((s, rx))
    }

    async fn send_raw(&self, mut cmd: Value) -> Result<Value, MpvError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        cmd["request_id"] = id.into();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        self.writer.send(format!("{cmd}\n")).await.map_err(|_| MpvError::NotRunning)?;
        let reply = tokio::time::timeout(Duration::from_secs(5), rx).await.map_err(|_| MpvError::Command("timeout".into()))?.map_err(|_| MpvError::NotRunning)?;
        match reply.get("error").and_then(Value::as_str) {
            Some("success") | None => Ok(reply.get("data").cloned().unwrap_or(Value::Null)),
            Some(e) => Err(MpvError::Command(e.into())),
        }
    }

    pub async fn command(&self, cmd: PlayerCommand) -> Result<Value, MpvError> {
        self.send_raw(cmd.to_ipc()).await
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub async fn wait(&mut self) -> Option<i32> {
        let code = self.child.wait().await.ok().and_then(|s| s.code());
        let _ = self.events.send(MpvEvent::Exited { code });
        code
    }

    pub async fn stop(&mut self) {
        let _ = self.send_raw(json!({ "command": ["quit"] })).await;
        if tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await.is_err() {
            let _ = self.child.kill().await;
        }
        if !cfg!(windows) {
            let _ = std::fs::remove_file(&self.ipc);
        }
    }
}

/// Whitelisted player commands. No raw mpv command strings cross this boundary.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PlayerCommand {
    TogglePause,
    SetPause { paused: bool },
    SeekRelative { seconds: f64 },
    SeekAbsolute { seconds: f64 },
    SetVolume { percent: f64 },
    ToggleMute,
    CycleSubtitles,
    CycleAudio,
    SetSpeed { speed: f64 },
    ToggleFullscreen,
    GetProperty { name: String },
}

const READABLE_PROPS: &[&str] = &["time-pos", "duration", "pause", "volume", "mute", "track-list", "media-title", "hwdec-current", "video-codec", "speed"];

impl PlayerCommand {
    pub fn to_ipc(&self) -> Value {
        let clamp = |v: f64, lo: f64, hi: f64| if v.is_finite() { v.clamp(lo, hi) } else { lo };
        match self {
            Self::TogglePause => json!({ "command": ["cycle", "pause"] }),
            Self::SetPause { paused } => json!({ "command": ["set_property", "pause", paused] }),
            Self::SeekRelative { seconds } => json!({ "command": ["seek", clamp(*seconds, -3600.0, 3600.0), "relative"] }),
            Self::SeekAbsolute { seconds } => json!({ "command": ["seek", clamp(*seconds, 0.0, 86400.0), "absolute"] }),
            Self::SetVolume { percent } => json!({ "command": ["set_property", "volume", clamp(*percent, 0.0, 130.0)] }),
            Self::ToggleMute => json!({ "command": ["cycle", "mute"] }),
            Self::CycleSubtitles => json!({ "command": ["cycle", "sub"] }),
            Self::CycleAudio => json!({ "command": ["cycle", "audio"] }),
            Self::SetSpeed { speed } => json!({ "command": ["set_property", "speed", clamp(*speed, 0.25, 4.0)] }),
            Self::ToggleFullscreen => json!({ "command": ["cycle", "fullscreen"] }),
            Self::GetProperty { name } => {
                let n = if READABLE_PROPS.contains(&name.as_str()) { name.as_str() } else { "time-pos" };
                json!({ "command": ["get_property", n] })
            }
        }
    }
}

fn translate_event(v: &Value) -> Option<MpvEvent> {
    match v.get("event")?.as_str()? {
        "property-change" => {
            let data = v.get("data");
            match v.get("name")?.as_str()? {
                "time-pos" => Some(MpvEvent::Time { position: data?.as_f64()? }),
                "duration" => Some(MpvEvent::Duration { duration: data?.as_f64()? }),
                "pause" => Some(MpvEvent::Pause { paused: data?.as_bool()? }),
                "paused-for-cache" => Some(MpvEvent::Buffering { buffering: data?.as_bool()? }),
                _ => None,
            }
        }
        "end-file" => Some(MpvEvent::Ended { reason: v.get("reason").and_then(Value::as_str).unwrap_or("unknown").into() }),
        _ => None,
    }
}

#[cfg(unix)]
async fn connect(path: &str) -> std::io::Result<(tokio::net::unix::OwnedReadHalf, tokio::net::unix::OwnedWriteHalf)> {
    Ok(tokio::net::UnixStream::connect(path).await?.into_split())
}

#[cfg(windows)]
async fn connect(path: &str) -> std::io::Result<(tokio::io::ReadHalf<tokio::net::windows::named_pipe::NamedPipeClient>, tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>)> {
    let client = tokio::net::windows::named_pipe::ClientOptions::new().open(path)?;
    Ok(tokio::io::split(client))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_are_validated() {
        assert!(validate_target("https://archive.org/download/x/x.mp4").is_ok());
        assert!(validate_target(if cfg!(windows) { r"C:\Movies\a.mkv" } else { "/Movies/a.mkv" }).is_ok());
        for bad in ["--script=/tmp/evil.lua", "file:///etc/passwd", "edl://x", "av://lavfi:x", "lavfi-complex", "relative/path.mkv", "https://x\n--y"] {
            assert!(validate_target(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn args_end_with_separator_and_target() {
        let a = build_args("/tmp/s", "https://x.example.com/v.mp4", &PlayOptions { title: Some("Dune\n--fs".into()), start_sec: Some(42.0), hwdec: Some("auto;rm".into()), ..Default::default() });
        assert_eq!(a[a.len() - 2], "--");
        assert_eq!(a.last().unwrap(), "https://x.example.com/v.mp4");
        assert!(a.contains(&"--start=42.0".to_string()));
        assert!(a.contains(&"--force-media-title=Dune--fs".to_string()));
        assert!(a.contains(&"--hwdec=auto-safe".to_string()));
        assert!(a.contains(&"--load-scripts=no".to_string()));
    }

    #[test]
    fn commands_are_clamped() {
        assert_eq!(PlayerCommand::SetVolume { percent: 9999.0 }.to_ipc(), json!({ "command": ["set_property", "volume", 130.0] }));
        assert_eq!(PlayerCommand::SeekRelative { seconds: f64::NAN }.to_ipc(), json!({ "command": ["seek", -3600.0, "relative"] }));
        assert_eq!(PlayerCommand::GetProperty { name: "stream-open-filename".into() }.to_ipc(), json!({ "command": ["get_property", "time-pos"] }));
    }

    #[test]
    fn events_translate() {
        assert_eq!(translate_event(&json!({ "event": "property-change", "name": "time-pos", "data": 12.5 })), Some(MpvEvent::Time { position: 12.5 }));
        assert_eq!(translate_event(&json!({ "event": "end-file", "reason": "eof" })), Some(MpvEvent::Ended { reason: "eof".into() }));
        assert_eq!(translate_event(&json!({ "event": "property-change", "name": "time-pos", "data": null })), None);
    }
}
