//! Opening streaming services (Netflix, Prime Video, ...): spec section 6.
//!
//! Three ways, chosen in Settings > Playback:
//!
//! * `InApp` (default): a full-screen MonitorOS window using the system
//!   WebView, with a "<- MonitorOS" button to come back. The user never leaves
//!   MonitorOS. DRM support in system WebViews is narrower than in browsers,
//!   so a service may refuse to play protected video here.
//! * `AppWindow`: the user's installed Chrome/Edge/Brave in `--app` mode, full
//!   screen without tabs or address bar. Keeps existing sign-ins and the
//!   browser's full DRM (Widevine/PlayReady).
//! * `Browser`: the default browser, as a normal tab.
//!
//! The external page never gets MonitorOS IPC: capabilities are bound to the
//! "main" window only. MonitorOS never decrypts or captures DRM content.

use serde::Deserialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const SERVICE_WINDOW: &str = "service";

/// The back button navigates here; MonitorOS intercepts it and closes the
/// window. `.invalid` is reserved (RFC 2606) so it can never resolve.
const CLOSE_URL_HOST: &str = "monitoros.invalid";

/// WKWebView's default UA has no "Version/… Safari" token, so streaming sites
/// treat it as an unsupported browser. Present as the system Safari instead.
#[cfg(target_os = "macos")]
const SERVICE_USER_AGENT: Option<&str> = Some("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15");
/// WebView2 already identifies as Edge.
#[cfg(not(target_os = "macos"))]
const SERVICE_USER_AGENT: Option<&str> = None;

/// Injected into the service page: a small "Back to MonitorOS" pill that
/// fades out while watching. It has no IPC access — it only navigates to
/// CLOSE_URL_HOST, which the native side intercepts.
const BACK_BUTTON_SCRIPT: &str = r#"
(() => {
  if (window.top !== window || window.__monitorosBack) return;
  window.__monitorosBack = true;
  const add = () => {
    if (!document.body || document.getElementById('__monitoros_back')) return;
    const b = document.createElement('button');
    b.id = '__monitoros_back';
    b.textContent = '← MonitorOS';
    b.setAttribute('aria-label', 'Back to MonitorOS');
    b.style.cssText = 'position:fixed;top:18px;left:18px;z-index:2147483647;padding:10px 18px;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:rgba(10,10,20,.72);color:#fff;font:600 15px -apple-system,system-ui,sans-serif;cursor:pointer;backdrop-filter:blur(8px);transition:opacity .4s;opacity:1';
    b.onclick = () => { location.href = 'https://monitoros.invalid/close'; };
    document.body.appendChild(b);
    let t;
    const show = () => { b.style.opacity = '1'; clearTimeout(t); t = setTimeout(() => { b.style.opacity = '0'; }, 3500); };
    ['mousemove', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, show, { passive: true }));
    show();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
  new MutationObserver(add).observe(document.documentElement, { childList: true, subtree: true });
})();
"#;

/// Lets the iPhone remote drive the service page (spatial focus over the
/// site's own links, player keys, cursor). See service_remote.js.
const SERVICE_REMOTE_SCRIPT: &str = include_str!("service_remote.js");

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OpenMode {
    AppWindow,
    InApp,
    Browser,
}

pub fn find_chromium() -> Option<PathBuf> {
    let mut c: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        for app in ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"] {
            c.push(PathBuf::from(format!("/Applications/{app}.app/Contents/MacOS/{app}")));
            if let Ok(home) = std::env::var("HOME") {
                c.push(PathBuf::from(format!("{home}/Applications/{app}.app/Contents/MacOS/{app}")));
            }
        }
    }
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(var) {
                let b = PathBuf::from(base);
                c.push(b.join(r"Google\Chrome\Application\chrome.exe"));
                c.push(b.join(r"Microsoft\Edge\Application\msedge.exe"));
                c.push(b.join(r"BraveSoftware\Brave-Browser\Application\brave.exe"));
            }
        }
    }
    c.into_iter().find(|p| p.is_file())
}

/// Arguments for a Chromium app window. The URL is a single argv entry
/// (no shell), and was validated as https before reaching here.
pub fn app_window_args(url: &str, profile_dir: &std::path::Path) -> Vec<String> {
    vec![
        format!("--app={url}"),
        // A MonitorOS-only profile runs as its own Chrome instance, so
        // --start-fullscreen is honoured even if the user's Chrome is open,
        // and it never adds tabs to their normal windows. (Sign in once.)
        format!("--user-data-dir={}", profile_dir.display()),
        "--start-fullscreen".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
    ]
}

/// The one Chrome/Edge instance MonitorOS manages. Opening another app
/// replaces it, so there is never more than one window for services.
static APP_WINDOW: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

fn close_app_window() {
    if let Some(mut child) = APP_WINDOW.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

pub fn open(app: &AppHandle, url: &str, mode: OpenMode) -> Result<&'static str, String> {
    match mode {
        OpenMode::AppWindow => match find_chromium() {
            Some(browser) => {
                close(app);
                close_app_window();
                let profile = app.path().app_data_dir().map_err(|e| e.to_string())?.join("browser-profile");
                let child = Command::new(browser)
                    .args(app_window_args(url, &profile))
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| e.to_string())?;
                *APP_WINDOW.lock().unwrap() = Some(child);
                Ok("app-window")
            }
            // No Chromium browser installed: fall back rather than fail.
            None => open(app, url, OpenMode::Browser).map(|_| "browser"),
        },
        OpenMode::InApp => {
            close_app_window();
            let parsed: url::Url = url.parse().map_err(|_| "invalid URL".to_string())?;
            // One service window, ever. Same app → just bring it back (keeps
            // your place); different app → navigate the same window.
            if let Some(w) = app.get_webview_window(SERVICE_WINDOW) {
                let same_app = w.url().ok().and_then(|u| u.host_str().map(str::to_owned)) == parsed.host_str().map(str::to_owned);
                if !same_app {
                    w.navigate(parsed).map_err(|e| e.to_string())?;
                }
                let _ = w.show();
                let _ = w.set_fullscreen(true);
                let _ = w.set_focus();
                return Ok("in-app");
            }
            let handle = app.clone();
            let mut builder = WebviewWindowBuilder::new(app, SERVICE_WINDOW, WebviewUrl::External(parsed))
                .title("MonitorOS")
                .fullscreen(true)
                .focused(true)
                .initialization_script(BACK_BUTTON_SCRIPT)
                .initialization_script(SERVICE_REMOTE_SCRIPT)
                .on_navigation(move |u| {
                    if is_close_url(u) {
                        let h = handle.clone();
                        // Close outside the navigation callback.
                        tauri::async_runtime::spawn(async move {
                            close(&h);
                        });
                        return false;
                    }
                    // Keep the window on the web: no file:, javascript:, custom schemes.
                    matches!(u.scheme(), "https" | "about" | "blob" | "data")
                });
            if let Some(ua) = SERVICE_USER_AGENT {
                builder = builder.user_agent(ua);
            }
            builder.build().map_err(|e| e.to_string())?;
            Ok("in-app")
        }
        OpenMode::Browser => {
            tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())?;
            Ok("browser")
        }
    }
}

/// Forwards a remote command into the open in-app service page.
/// Returns false when no service window is open.
pub fn forward(app: &AppHandle, cmd: &monitoros_core::remote::RemoteCommand) -> bool {
    let Some(w) = app.get_webview_window(SERVICE_WINDOW) else { return false };
    // The command is a validated enum serialised to a JSON literal: no string
    // from the phone is ever spliced into script source unescaped.
    match serde_json::to_string(cmd) {
        Ok(json) => w.eval(format!("window.__monitorosRemote && window.__monitorosRemote({json})")).is_ok(),
        Err(_) => false,
    }
}

pub fn toggle_fullscreen(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SERVICE_WINDOW) {
        let on = w.is_fullscreen().unwrap_or(true);
        let _ = w.set_fullscreen(!on);
    }
}

pub fn is_close_url(u: &url::Url) -> bool {
    u.host_str() == Some(CLOSE_URL_HOST)
}

/// Closes the in-app service window (remote Home/Back, or Ctrl/Cmd+Shift+M).
pub fn close(app: &AppHandle) -> bool {
    close_app_window();
    if let Some(w) = app.get_webview_window(SERVICE_WINDOW) {
        let _ = w.close();
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.set_focus();
        }
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_window_args_keep_url_as_one_argument() {
        let a = app_window_args("https://www.netflix.com/browse", std::path::Path::new("/tmp/mo-profile"));
        assert_eq!(a[0], "--app=https://www.netflix.com/browse");
        assert!(a.contains(&"--start-fullscreen".to_string()));
        assert!(a.contains(&"--user-data-dir=/tmp/mo-profile".to_string()), "separate instance so full screen applies");
    }

    #[test]
    fn back_button_url_is_recognised() {
        assert!(is_close_url(&"https://monitoros.invalid/close".parse().unwrap()));
        assert!(!is_close_url(&"https://www.netflix.com/browse".parse().unwrap()));
        assert!(BACK_BUTTON_SCRIPT.contains(CLOSE_URL_HOST));
    }

    #[test]
    fn remote_script_exposes_handler_and_close_url() {
        assert!(SERVICE_REMOTE_SCRIPT.contains("window.__monitorosRemote ="));
        assert!(SERVICE_REMOTE_SCRIPT.contains(CLOSE_URL_HOST));
    }

    #[test]
    fn forwarded_text_is_json_escaped() {
        let cmd = monitoros_core::remote::RemoteCommand::Text { value: "\"); alert(1); (\"".into() };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains(r#"\"); alert(1); (\""#), "{json}");
    }

    #[test]
    fn global_freeze_prototype_stays_off() {
        // Tauri injects freezePrototype into every webview, including the
        // streaming window, where it blanks YouTube and breaks Netflix.
        // MonitorOS's own UI freezes itself in src/hardening.ts instead.
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["app"]["security"]["freezePrototype"], serde_json::Value::Bool(false));
        assert!(include_str!("../../src/main.tsx").starts_with("import \"./hardening\";"));
    }

    #[test]
    fn open_mode_parses() {
        assert_eq!(serde_json::from_str::<OpenMode>("\"app-window\"").unwrap(), OpenMode::AppWindow);
        assert_eq!(serde_json::from_str::<OpenMode>("\"in-app\"").unwrap(), OpenMode::InApp);
        assert!(serde_json::from_str::<OpenMode>("\"shell\"").is_err());
    }
}
