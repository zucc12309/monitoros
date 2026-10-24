//! macOS adapter. Uses only user-level tools that ship with macOS
//! (`system_profiler`, `osascript`) with fixed argument lists — never a
//! shell, never interpolated user input. System-default output switching
//! uses the optional `SwitchAudioSource` (brew install switchaudio-osx);
//! without it MonitorOS routes playback audio per-session through mpv.

use monitoros_core::platform::{AudioDevice, DisplayInfo, Platform, PlatformCapabilities, PlatformError};
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;

pub struct MacPlatform;

fn run(cmd: &str, args: &[&str]) -> Result<String, PlatformError> {
    let out = Command::new(cmd).args(args).output().map_err(|e| PlatformError::Command(format!("{cmd}: {e}")))?;
    if !out.status.success() {
        return Err(PlatformError::Command(format!("{cmd} exited with {}", out.status)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn switch_audio_source() -> Option<PathBuf> {
    ["/opt/homebrew/bin/SwitchAudioSource", "/usr/local/bin/SwitchAudioSource"].iter().map(PathBuf::from).find(|p| p.is_file())
}

/// Parses `system_profiler SPDisplaysDataType -json`.
pub fn parse_displays(json: &str) -> Result<Vec<DisplayInfo>, PlatformError> {
    let v: Value = serde_json::from_str(json).map_err(|e| PlatformError::Parse(e.to_string()))?;
    let mut out = Vec::new();
    for gpu in v["SPDisplaysDataType"].as_array().into_iter().flatten() {
        for d in gpu["spdisplays_ndrvs"].as_array().into_iter().flatten() {
            if d["spdisplays_online"].as_str() == Some("spdisplays_no") {
                continue;
            }
            // "1470 x 956 @ 60.00Hz" (UI points) — prefer physical pixels when present.
            let res = d["_spdisplays_resolution"].as_str().unwrap_or("");
            let px = d["_spdisplays_pixels"].as_str().unwrap_or(res);
            let dims: Vec<u32> = px.split(['x', '@']).take(2).filter_map(|s| s.trim().parse().ok()).collect();
            let hz = res.split('@').nth(1).and_then(|s| s.trim().trim_end_matches("Hz").parse::<f64>().ok());
            let conn = d["spdisplays_connection_type"].as_str().unwrap_or("");
            let internal = conn == "spdisplays_internal";
            out.push(DisplayInfo {
                id: d["_spdisplays_displayID"].as_str().unwrap_or("0").to_string(),
                name: d["_name"].as_str().unwrap_or("Display").to_string(),
                width: dims.first().copied().unwrap_or(0),
                height: dims.get(1).copied().unwrap_or(0),
                refresh_hz: hz,
                primary: d["spdisplays_main"].as_str() == Some("spdisplays_yes"),
                external: !internal,
                connection: Some(
                    match conn {
                        "spdisplays_internal" => "Built-in",
                        c if c.contains("hdmi") => "HDMI",
                        c if c.contains("displayport") || c.contains("thunderbolt") => "DisplayPort",
                        "" => "External",
                        _ => "External",
                    }
                    .into(),
                ),
            });
        }
    }
    Ok(out)
}

/// Parses `system_profiler SPAudioDataType -json` into output devices.
pub fn parse_audio_outputs(json: &str) -> Result<Vec<AudioDevice>, PlatformError> {
    let v: Value = serde_json::from_str(json).map_err(|e| PlatformError::Parse(e.to_string()))?;
    let mut out = Vec::new();
    for group in v["SPAudioDataType"].as_array().into_iter().flatten() {
        for d in group["_items"].as_array().into_iter().flatten() {
            if d.get("coreaudio_device_output").is_none() {
                continue;
            }
            let name = d["_name"].as_str().unwrap_or("Output").to_string();
            let transport = match d["coreaudio_device_transport"].as_str().unwrap_or("") {
                "coreaudio_device_type_builtin" => "Built-in",
                "coreaudio_device_type_hdmi" => "HDMI",
                "coreaudio_device_type_displayport" => "DisplayPort",
                "coreaudio_device_type_bluetooth" | "coreaudio_device_type_bluetooth_le" => "Bluetooth",
                "coreaudio_device_type_usb" => "USB",
                "coreaudio_device_type_airplay" => "AirPlay",
                "coreaudio_device_type_virtual" => "Virtual",
                _ => "Other",
            };
            out.push(AudioDevice { id: name.clone(), name, transport: Some(transport.into()), default_output: d["coreaudio_default_audio_output_device"].as_str() == Some("spaudio_yes") });
        }
    }
    Ok(out)
}

impl Platform for MacPlatform {
    fn capabilities(&self) -> PlatformCapabilities {
        let sas = switch_audio_source().is_some();
        let mut notes = vec!["Remote keyboard/pointer injection into other apps needs Accessibility permission; MonitorOS only drives its own window.".to_string()];
        if !sas {
            notes.push("Install SwitchAudioSource (brew install switchaudio-osx) to change the system output; otherwise output is chosen per playback in mpv.".into());
        }
        PlatformCapabilities { os: "macos".into(), arch: std::env::consts::ARCH.into(), can_switch_audio_output: sas, can_set_volume: true, needs_accessibility_permission: false, notes }
    }

    fn displays(&self) -> Result<Vec<DisplayInfo>, PlatformError> {
        parse_displays(&run("/usr/sbin/system_profiler", &["SPDisplaysDataType", "-json"])?)
    }

    fn audio_outputs(&self) -> Result<Vec<AudioDevice>, PlatformError> {
        parse_audio_outputs(&run("/usr/sbin/system_profiler", &["SPAudioDataType", "-json"])?)
    }

    fn set_audio_output(&self, device_id: &str) -> Result<(), PlatformError> {
        let tool = switch_audio_source().ok_or(PlatformError::Unsupported("system output switching (install switchaudio-osx)"))?;
        // Only accept a name that is currently listed: no free-form input reaches the tool.
        let known = self.audio_outputs()?;
        let dev = known.iter().find(|d| d.id == device_id).ok_or(PlatformError::InvalidArgument)?;
        run(tool.to_str().unwrap_or_default(), &["-t", "output", "-s", &dev.name]).map(|_| ())
    }

    fn volume(&self) -> Result<u8, PlatformError> {
        let s = run("/usr/bin/osascript", &["-e", "output volume of (get volume settings)"])?;
        s.trim().parse().map_err(|_| PlatformError::Parse(s))
    }

    fn set_volume(&self, percent: u8) -> Result<(), PlatformError> {
        // percent is a u8 clamped to 100; formatting a number cannot inject script.
        run("/usr/bin/osascript", &["-e", &format!("set volume output volume {}", percent.min(100))]).map(|_| ())
    }

    fn set_muted(&self, muted: bool) -> Result<(), PlatformError> {
        run("/usr/bin/osascript", &["-e", if muted { "set volume with output muted" } else { "set volume without output muted" }]).map(|_| ())
    }

    fn is_muted(&self) -> Result<bool, PlatformError> {
        Ok(run("/usr/bin/osascript", &["-e", "output muted of (get volume settings)"])?.trim() == "true")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from a MacBook Air (Apple Silicon), macOS 26.5, 2026-10-24.
    const DISPLAYS: &str = r#"{"SPDisplaysDataType":[{"spdisplays_ndrvs":[
      {"_name":"Color LCD","_spdisplays_displayID":"1","_spdisplays_pixels":"2940 x 1912","_spdisplays_resolution":"1470 x 956 @ 60.00Hz","spdisplays_connection_type":"spdisplays_internal","spdisplays_main":"spdisplays_yes","spdisplays_online":"spdisplays_yes"},
      {"_name":"LG TV","_spdisplays_displayID":"2","_spdisplays_pixels":"3840 x 2160","_spdisplays_resolution":"3840 x 2160 @ 60.00Hz","spdisplays_connection_type":"spdisplays_hdmi","spdisplays_online":"spdisplays_yes"}
    ]}]}"#;

    const AUDIO: &str = r#"{"SPAudioDataType":[{"_items":[
      {"_name":"MacBook Air Microphone","coreaudio_device_input":1,"coreaudio_device_transport":"coreaudio_device_type_builtin"},
      {"_name":"MacBook Air Speakers","coreaudio_default_audio_output_device":"spaudio_yes","coreaudio_device_output":2,"coreaudio_device_transport":"coreaudio_device_type_builtin"},
      {"_name":"WH-1000XM5","coreaudio_device_output":2,"coreaudio_device_transport":"coreaudio_device_type_bluetooth"}
    ]}]}"#;

    #[test]
    fn parses_displays() {
        let d = parse_displays(DISPLAYS).unwrap();
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].width, d[0].height, d[0].refresh_hz, d[0].primary, d[0].external), (2940, 1912, Some(60.0), true, false));
        assert_eq!(d[1].connection.as_deref(), Some("HDMI"));
        assert!(d[1].external);
    }

    #[test]
    fn parses_audio_outputs_only() {
        let a = parse_audio_outputs(AUDIO).unwrap();
        assert_eq!(a.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["MacBook Air Speakers", "WH-1000XM5"]);
        assert!(a[0].default_output);
        assert_eq!(a[1].transport.as_deref(), Some("Bluetooth"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn live_system_queries_work() {
        // Read-only queries against the real machine.
        let p = MacPlatform;
        assert!(!p.displays().unwrap().is_empty());
        assert!(!p.audio_outputs().unwrap().is_empty());
        assert!(p.volume().unwrap() <= 100);
    }
}
