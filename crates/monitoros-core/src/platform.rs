//! Platform adapter interface. `platform-macos` and `platform-windows`
//! implement it; the Tauri app picks one at compile time.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub refresh_hz: Option<f64>,
    pub primary: bool,
    pub external: bool,
    pub connection: Option<String>, // "HDMI", "DisplayPort", "Built-in"...
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub transport: Option<String>, // "HDMI", "Bluetooth", "Built-in", "USB"
    pub default_output: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    pub os: String,
    pub arch: String,
    pub can_switch_audio_output: bool,
    pub can_set_volume: bool,
    pub needs_accessibility_permission: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error("not supported on this platform: {0}")]
    Unsupported(&'static str),
    #[error("system command failed: {0}")]
    Command(String),
    #[error("could not parse system output: {0}")]
    Parse(String),
    #[error("invalid argument")]
    InvalidArgument,
}

pub trait Platform: Send + Sync {
    fn capabilities(&self) -> PlatformCapabilities;
    fn displays(&self) -> Result<Vec<DisplayInfo>, PlatformError>;
    fn audio_outputs(&self) -> Result<Vec<AudioDevice>, PlatformError>;
    fn set_audio_output(&self, device_id: &str) -> Result<(), PlatformError>;
    /// 0..=100
    fn volume(&self) -> Result<u8, PlatformError>;
    fn set_volume(&self, percent: u8) -> Result<(), PlatformError>;
    fn set_muted(&self, muted: bool) -> Result<(), PlatformError>;
    fn is_muted(&self) -> Result<bool, PlatformError>;
}

/// Fallback for unsupported targets (e.g. Linux today).
pub struct NullPlatform;

impl Platform for NullPlatform {
    fn capabilities(&self) -> PlatformCapabilities {
        PlatformCapabilities { os: std::env::consts::OS.into(), arch: std::env::consts::ARCH.into(), notes: vec!["No platform adapter for this OS yet.".into()], ..Default::default() }
    }
    fn displays(&self) -> Result<Vec<DisplayInfo>, PlatformError> {
        Ok(vec![])
    }
    fn audio_outputs(&self) -> Result<Vec<AudioDevice>, PlatformError> {
        Ok(vec![])
    }
    fn set_audio_output(&self, _: &str) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported("audio output switching"))
    }
    fn volume(&self) -> Result<u8, PlatformError> {
        Err(PlatformError::Unsupported("volume"))
    }
    fn set_volume(&self, _: u8) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported("volume"))
    }
    fn set_muted(&self, _: bool) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported("mute"))
    }
    fn is_muted(&self) -> Result<bool, PlatformError> {
        Err(PlatformError::Unsupported("mute"))
    }
}
