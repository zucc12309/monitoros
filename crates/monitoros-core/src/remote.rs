//! Remote-control protocol. Authoritative mirror of packages/contracts/src/remote.ts.
//!
//! Commands are a closed enum: there is deliberately no variant that can carry
//! a path, URL or shell string, so a compromised remote can only do what a
//! physical remote could.

use serde::{Deserialize, Serialize};

pub const MAX_TEXT_LEN: usize = 256;
pub const MAX_SEEK_SEC: f64 = 3600.0;
pub const MAX_POINTER_DELTA: f64 = 500.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NavKey {
    Up,
    Down,
    Left,
    Right,
    Ok,
    Back,
    Home,
    Search,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MediaAction {
    PlayPause,
    Stop,
    Next,
    Previous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VolumeAction {
    Up,
    Down,
    Mute,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModeTarget {
    Tv,
    Desktop,
    Toggle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RemoteCommand {
    Nav { key: NavKey },
    Media { action: MediaAction },
    Seek {
        #[serde(rename = "deltaSec")]
        delta_sec: f64,
    },
    Volume { action: VolumeAction },
    Text { value: String },
    Pointer {
        dx: f64,
        dy: f64,
        #[serde(default)]
        click: bool,
    },
    /// Two-finger touchpad scroll, in phone pixels (natural direction).
    Scroll { dx: f64, dy: f64 },
    Mode { target: ModeTarget },
    /// Toggle full screen on whatever app is in front.
    Fullscreen,
    Ping,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteEnvelope {
    pub seq: u64,
    pub sent_at: f64,
    pub command: RemoteCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RemoteAck {
    pub seq: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CommandError {
    #[error("malformed command: {0}")]
    Malformed(String),
    #[error("value out of range")]
    OutOfRange,
    #[error("replayed or out-of-order sequence number")]
    Replay,
    #[error("message too large")]
    TooLarge,
}

pub const MAX_MESSAGE_BYTES: usize = 2048;

impl RemoteCommand {
    /// Range checks serde cannot express. Returns a sanitised copy.
    pub fn validate(self) -> Result<Self, CommandError> {
        match self {
            RemoteCommand::Seek { delta_sec } if !delta_sec.is_finite() || delta_sec.abs() > MAX_SEEK_SEC => {
                Err(CommandError::OutOfRange)
            }
            RemoteCommand::Pointer { dx, dy, .. }
                if !dx.is_finite() || !dy.is_finite() || dx.abs() > MAX_POINTER_DELTA || dy.abs() > MAX_POINTER_DELTA =>
            {
                Err(CommandError::OutOfRange)
            }
            RemoteCommand::Scroll { dx, dy }
                if !dx.is_finite() || !dy.is_finite() || dx.abs() > MAX_POINTER_DELTA || dy.abs() > MAX_POINTER_DELTA =>
            {
                Err(CommandError::OutOfRange)
            }
            RemoteCommand::Text { value } => {
                if value.chars().count() > MAX_TEXT_LEN {
                    return Err(CommandError::OutOfRange);
                }
                Ok(RemoteCommand::Text { value: value.chars().filter(|c| !c.is_control()).collect() })
            }
            other => Ok(other),
        }
    }
}

pub fn parse_envelope(raw: &str) -> Result<RemoteEnvelope, CommandError> {
    if raw.len() > MAX_MESSAGE_BYTES {
        return Err(CommandError::TooLarge);
    }
    let env: RemoteEnvelope = serde_json::from_str(raw).map_err(|e| CommandError::Malformed(e.to_string()))?;
    if !env.sent_at.is_finite() {
        return Err(CommandError::OutOfRange);
    }
    Ok(RemoteEnvelope { command: env.command.validate()?, ..env })
}

/// Per-session replay guard: sequence numbers must strictly increase.
#[derive(Debug, Default)]
pub struct ReplayGuard {
    last: Option<u64>,
}

impl ReplayGuard {
    pub fn check(&mut self, seq: u64) -> Result<(), CommandError> {
        if let Some(last) = self.last {
            if seq <= last {
                return Err(CommandError::Replay);
            }
        }
        self.last = Some(seq);
        Ok(())
    }
}

/// Token-bucket rate limiter (no external clock: caller supplies `now_ms`).
#[derive(Debug)]
pub struct RateLimiter {
    capacity: f64,
    tokens: f64,
    refill_per_ms: f64,
    last_ms: u64,
}

impl RateLimiter {
    pub fn new(capacity: u32, per_second: u32, now_ms: u64) -> Self {
        Self { capacity: capacity as f64, tokens: capacity as f64, refill_per_ms: per_second as f64 / 1000.0, last_ms: now_ms }
    }

    pub fn allow(&mut self, now_ms: u64) -> bool {
        let elapsed = now_ms.saturating_sub(self.last_ms) as f64;
        self.last_ms = now_ms;
        self.tokens = (self.tokens + elapsed * self.refill_per_ms).min(self.capacity);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_commands() {
        let e = parse_envelope(r#"{"seq":1,"sentAt":1.0,"command":{"type":"nav","key":"up"}}"#).unwrap();
        assert_eq!(e.command, RemoteCommand::Nav { key: NavKey::Up });
        let e = parse_envelope(r#"{"seq":2,"sentAt":1,"command":{"type":"seek","deltaSec":-10}}"#).unwrap();
        assert_eq!(e.command, RemoteCommand::Seek { delta_sec: -10.0 });
        let e = parse_envelope(r#"{"seq":3,"sentAt":1,"command":{"type":"media","action":"play-pause"}}"#).unwrap();
        assert_eq!(e.command, RemoteCommand::Media { action: MediaAction::PlayPause });
    }

    #[test]
    fn rejects_unknown_and_extra_fields() {
        assert!(parse_envelope(r#"{"seq":1,"sentAt":1,"command":{"type":"exec","cmd":"rm -rf /"}}"#).is_err());
        assert!(parse_envelope(r#"{"seq":1,"sentAt":1,"command":{"type":"nav","key":"up","path":"/etc"}}"#).is_err());
        assert!(parse_envelope(r#"{"seq":-1,"sentAt":1,"command":{"type":"ping"}}"#).is_err());
        assert!(parse_envelope("not json").is_err());
    }

    #[test]
    fn range_checks() {
        assert_eq!(parse_envelope(r#"{"seq":1,"sentAt":1,"command":{"type":"seek","deltaSec":99999}}"#), Err(CommandError::OutOfRange));
        assert_eq!(parse_envelope(r#"{"seq":1,"sentAt":1,"command":{"type":"pointer","dx":1e9,"dy":0}}"#), Err(CommandError::OutOfRange));
        let long = format!(r#"{{"seq":1,"sentAt":1,"command":{{"type":"text","value":"{}"}}}}"#, "a".repeat(300));
        assert_eq!(parse_envelope(&long), Err(CommandError::OutOfRange));
        assert_eq!(parse_envelope(&"x".repeat(5000)), Err(CommandError::TooLarge));
    }

    #[test]
    fn scroll_is_range_checked() {
        let e = parse_envelope(r#"{"seq":1,"sentAt":1,"command":{"type":"scroll","dx":0,"dy":-40}}"#).unwrap();
        assert_eq!(e.command, RemoteCommand::Scroll { dx: 0.0, dy: -40.0 });
        assert_eq!(parse_envelope(r#"{"seq":1,"sentAt":1,"command":{"type":"scroll","dx":0,"dy":1e9}}"#), Err(CommandError::OutOfRange));
    }

    #[test]
    fn fullscreen_parses() {
        let e = parse_envelope(r#"{"seq":1,"sentAt":1,"command":{"type":"fullscreen"}}"#).unwrap();
        assert_eq!(e.command, RemoteCommand::Fullscreen);
    }

    #[test]
    fn strips_control_chars() {
        let e = parse_envelope(r#"{"seq":1,"sentAt":1,"command":{"type":"text","value":"dune\u0000\n"}}"#).unwrap();
        assert_eq!(e.command, RemoteCommand::Text { value: "dune".into() });
    }

    #[test]
    fn replay_guard() {
        let mut g = ReplayGuard::default();
        assert!(g.check(1).is_ok());
        assert!(g.check(5).is_ok());
        assert_eq!(g.check(5), Err(CommandError::Replay));
        assert_eq!(g.check(3), Err(CommandError::Replay));
    }

    #[test]
    fn rate_limiter() {
        let mut r = RateLimiter::new(3, 10, 0);
        assert!(r.allow(0) && r.allow(0) && r.allow(0));
        assert!(!r.allow(0));
        assert!(r.allow(100)); // 100ms * 10/s = 1 token
    }
}
