//! Windows 10/11 adapter.
//!
//! Volume/mute/endpoint listing use the documented Core Audio COM APIs
//! (IMMDeviceEnumerator, IAudioEndpointVolume). Changing the *system default*
//! output requires the undocumented IPolicyConfig interface, so MonitorOS
//! instead routes playback audio per-session through mpv (`--audio-device=
//! wasapi/{id}`) and offers a shortcut to Settings › Sound.
//!
//! STATUS: compile-checked for x86_64-pc-windows-msvc from macOS; NOT yet run
//! on Windows hardware. See docs/TEST_REPORT.md.

use monitoros_core::platform::{DisplayInfo, PlatformError};

pub struct WindowsPlatform;

/// Parses the JSON emitted by DISPLAY_QUERY (System.Windows.Forms.Screen).
pub fn parse_screens(json: &str) -> Result<Vec<DisplayInfo>, PlatformError> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| PlatformError::Parse(e.to_string()))?;
    let arr = match v {
        serde_json::Value::Array(a) => a,
        obj @ serde_json::Value::Object(_) => vec![obj], // ConvertTo-Json unwraps single-element arrays
        _ => return Err(PlatformError::Parse("unexpected JSON".into())),
    };
    Ok(arr
        .iter()
        .enumerate()
        .map(|(i, s)| DisplayInfo {
            id: s["DeviceName"].as_str().unwrap_or(&i.to_string()).to_string(),
            name: s["DeviceName"].as_str().unwrap_or("Display").trim_start_matches(r"\\.\").to_string(),
            width: s["Bounds"]["Width"].as_u64().unwrap_or(0) as u32,
            height: s["Bounds"]["Height"].as_u64().unwrap_or(0) as u32,
            refresh_hz: s["RefreshHz"].as_f64(),
            primary: s["Primary"].as_bool().unwrap_or(false),
            external: !s["Primary"].as_bool().unwrap_or(false),
            connection: None,
        })
        .collect())
}

/// Fixed PowerShell script: no interpolation of any external input.
pub const DISPLAY_QUERY: &str = "Add-Type -AssemblyName System.Windows.Forms; \
[System.Windows.Forms.Screen]::AllScreens | Select-Object DeviceName,Primary,@{n='Bounds';e={@{Width=$_.Bounds.Width;Height=$_.Bounds.Height}}} | ConvertTo-Json -Compress";

#[cfg(windows)]
mod imp {
    use super::*;
    use monitoros_core::platform::{AudioDevice, Platform, PlatformCapabilities};
    use std::os::windows::process::CommandExt;
    use windows::core::PWSTR;
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn com_err(e: windows::core::Error) -> PlatformError {
        PlatformError::Command(e.message().to_string())
    }

    fn enumerator() -> Result<IMMDeviceEnumerator, PlatformError> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(com_err)
        }
    }

    fn endpoint_volume() -> Result<IAudioEndpointVolume, PlatformError> {
        unsafe {
            let dev = enumerator()?.GetDefaultAudioEndpoint(eRender, eConsole).map_err(com_err)?;
            dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).map_err(com_err)
        }
    }

    fn pwstr_to_string(p: PWSTR) -> String {
        unsafe { p.to_string().unwrap_or_default() }
    }

    impl Platform for WindowsPlatform {
        fn capabilities(&self) -> PlatformCapabilities {
            PlatformCapabilities {
                os: "windows".into(),
                arch: std::env::consts::ARCH.into(),
                can_switch_audio_output: false,
                can_set_volume: true,
                needs_accessibility_permission: false,
                notes: vec!["System default output can't be changed through a documented API; MonitorOS selects the output per playback. Use Settings › Sound for the system default.".into()],
            }
        }

        fn displays(&self) -> Result<Vec<DisplayInfo>, PlatformError> {
            let out = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", DISPLAY_QUERY])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| PlatformError::Command(e.to_string()))?;
            parse_screens(&String::from_utf8_lossy(&out.stdout))
        }

        fn audio_outputs(&self) -> Result<Vec<AudioDevice>, PlatformError> {
            unsafe {
                let en = enumerator()?;
                let default_id = en.GetDefaultAudioEndpoint(eRender, eConsole).ok().and_then(|d| d.GetId().ok()).map(pwstr_to_string);
                let col = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(com_err)?;
                let n = col.GetCount().map_err(com_err)?;
                let mut out = Vec::new();
                for i in 0..n {
                    let dev = col.Item(i).map_err(com_err)?;
                    let id = pwstr_to_string(dev.GetId().map_err(com_err)?);
                    let name = dev
                        .OpenPropertyStore(STGM_READ)
                        .and_then(|ps| ps.GetValue(&PKEY_Device_FriendlyName))
                        .map(|v| v.to_string())
                        .unwrap_or_else(|_| "Audio device".into());
                    let lower = name.to_lowercase();
                    let transport = if lower.contains("hdmi") || lower.contains("nvidia high definition") {
                        "HDMI"
                    } else if lower.contains("bluetooth") || lower.contains("headphones (") || lower.contains("hands-free") {
                        "Bluetooth"
                    } else if lower.contains("usb") {
                        "USB"
                    } else {
                        "Built-in"
                    };
                    out.push(AudioDevice { default_output: default_id.as_deref() == Some(id.as_str()), id, name, transport: Some(transport.into()) });
                }
                Ok(out)
            }
        }

        fn set_audio_output(&self, _device_id: &str) -> Result<(), PlatformError> {
            Err(PlatformError::Unsupported("changing the Windows default output (choose it per playback instead)"))
        }

        fn volume(&self) -> Result<u8, PlatformError> {
            unsafe { Ok((endpoint_volume()?.GetMasterVolumeLevelScalar().map_err(com_err)? * 100.0).round() as u8) }
        }

        fn set_volume(&self, percent: u8) -> Result<(), PlatformError> {
            unsafe { endpoint_volume()?.SetMasterVolumeLevelScalar(percent.min(100) as f32 / 100.0, std::ptr::null()).map_err(com_err) }
        }

        fn set_muted(&self, muted: bool) -> Result<(), PlatformError> {
            unsafe { endpoint_volume()?.SetMute(muted, std::ptr::null()).map_err(com_err) }
        }

        fn is_muted(&self) -> Result<bool, PlatformError> {
            unsafe { Ok(endpoint_volume()?.GetMute().map_err(com_err)?.as_bool()) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_powershell_screens() {
        let one = r#"{"DeviceName":"\\\\.\\DISPLAY1","Primary":true,"Bounds":{"Width":1920,"Height":1080}}"#;
        let d = parse_screens(one).unwrap();
        assert_eq!((d[0].name.as_str(), d[0].width, d[0].primary), ("DISPLAY1", 1920, true));
        let two = format!("[{one},{}]", r#"{"DeviceName":"\\\\.\\DISPLAY2","Primary":false,"Bounds":{"Width":3840,"Height":2160}}"#);
        let d = parse_screens(&two).unwrap();
        assert!(d[1].external);
    }
}
