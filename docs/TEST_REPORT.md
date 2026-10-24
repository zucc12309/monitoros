# Test report (2026-10-24)

Machine: MacBook Air (Apple Silicon, arm64), macOS 26.5, Node 20.20, Rust 1.99.1, mpv 0.41.0, Chrome (for E2E). Every number below comes from an actual run. Nothing has been run on Windows or on the Dell G7 yet.

## Automated: all passing

| Suite | Command | Result |
|---|---|---|
| TS unit + security (Vitest) | `npm test` | **96 / 96** across 7 files |
| Rust unit + integration | `cargo test --workspace` | **56 / 56** |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| TS typecheck | `tsc --noEmit -p apps/desktop` and root | clean |
| E2E (Playwright, Chrome) | `npm run test:e2e` | **14 / 14** |
| Windows cross-check | `cargo check --target x86_64-pc-windows-msvc -p platform-windows -p media-engine -p monitoros-core` | compiles |
| macOS release bundle | `scripts/macos/build.sh` | `MonitorOS.app` (19 MB), DMG (7 MB) |

### What the integration/E2E tests actually exercise

- **mpv (`media-engine/tests/mpv_integration.rs`):** ffmpeg generates a 3 s H.264/AAC MKV; real mpv plays it headless over JSON IPC. The test checks duration ≈ 3 s, then exercises time-pos events, pause → `get_property pause == true`, seek, and quit.
- **Remote server (`remote-server/tests/remote_e2e.rs`, a real axum server on 127.0.0.1):**
  - full pairing flow: 202 before approval, 401 on a wrong code
  - authenticated WebSocket command delivered
  - replay rejected
  - injected `exec` command rejected
  - forged token rejected
  - revoked device disconnected
  - cross-origin WebSocket refused
  - DNS-rebinding Host refused (403)
  - cross-site POST and missing Origin refused
  - 10 KB body refused (413)
- **Guarded egress:** a live local server returns `302 → 169.254.169.254`, and the request is refused. `file:` URLs and credentialed URLs are refused.
- **E2E (`tests/e2e/tv-ui.spec.ts`):**
  - onboarding completed with Enter only
  - default focus lands on Watch Now; up/down column memory; Left from a row start enters the side rail
  - Netflix tile hands off to `https://www.netflix.com/…`
  - search "RRR" opens a detail page showing "Availability unknown"
  - **His Girl Friday (1940, public domain, Internet Archive) streams for >1 s in the in-app player, Escape exits, and progress is saved (duration > 3000 s)**

- **Remote inside streaming pages (`tests/e2e/service-remote.spec.ts`)**, running the exact injected script on a site-like fixture in Chrome:
  - the D-pad walks the site's own tiles (row/column aware) and OK opens one
  - during playback, arrows, play-pause and seek reach the player as key events (with keyCode)
  - the touchpad cursor clicks what's under it
  - phone text fills the search box
  - Back steps back inside the site, and from the entry page returns to MonitorOS
- **Phone touchpad (`tests/e2e/remote-touchpad.spec.ts`, mobile Chrome with real TouchEvents):** with a service open it auto-switches to Mouse mode; a one-finger drag sends pointer deltas (no click); a tap clicks; two-finger drag scrolls without clicking. In MonitorOS it swipes like a D-pad. The macOS permission hint is shown when needed.
- **Not yet verified against live Netflix/Prime** (needs the user's sign-in). Sites that ignore synthetic keys still work with cursor mode.

## Manual checks done in this session

| Check | Result |
|---|---|
| Home screen at 1920×1080 against the reference mock-up | Matches the layout: rail, pill nav, hero with IMDb rating, Continue Watching, brand app tiles, landscape trending cards with title logos |
| iPhone PWA (375×812 emulation) → dev harness server | Paired with a 6-digit code; play-pause, OK, +10 s, text "Kalki" and TV/Desktop toggle all received as validated commands |
| Release app launches on macOS | Process starts and stays up with no errors logged. **I did not see the window myself** (no screen-capture permission); the user should confirm visually. |

## Bugs found by testing and fixed

1. **HTML5 player: CORS vs. redirects.** `crossOrigin="anonymous"` broke archive.org's redirecting CDN (MEDIA_ERR_SRC_NOT_SUPPORTED). It is now only set when cross-origin VTT tracks need it.
2. **Error overlay ignored OK.** OK was captured as play/pause, so the remote couldn't press Back.
3. **Focus restore was wrong after mouse/autoFocus focus.** Fixed with `focusin` tracking.
4. **Keys pressed before load were lost.** They navigated, then init overwrote the page. Input is now ignored until the app is ready.
5. **mpv one-shot events were missed.** `duration` was emitted before callers subscribed (the test failed 4 of 5 runs). `spawn` now returns a pre-subscribed receiver (passed 6 of 6). This would have stopped native playback from saving progress.
6. **Netflix-style hero trailers stole the D-pad.** An autoplaying browse-page trailer was mistaken for the movie being watched, so arrows only scrolled and nothing could be selected (user report). Now only a (near-)full-screen or fullscreen video counts. A regression test reproduces the original failure.
7. **Onboarding lost keyboard focus** when the Back button appeared (flaky E2E, 1 of 3 runs). Focus is now pinned to the primary button on each step.
8. **Remote port collision.** 8765 was already used by another local process. The default is now 47815, with an OS-assigned fallback.

## Environment notes

- Playwright's bundled Chromium has no H.264. E2E uses installed Chrome (`channel: "chrome"`).
- The styled Tauri DMG needs Finder automation permission, so `build.sh` uses plain `hdiutil` instead.

## Not yet tested (needs hardware or accounts)

- **Windows 10/11:** everything at runtime, including COM audio, WebView2, NSIS/MSI, and the Dell G7 with HDD + NVIDIA.
- **Real iPhone Safari:** home-screen install, background reconnect, haptics.
- **External HDMI display hot-plug, sleep/wake, multi-monitor full screen.**
- **Subscription playback in the in-app window:** requires the user's own sign-in. Whether Netflix/Prime/JioHotstar allow DRM playback in WKWebView or WebView2 is unverified.
- **Performance targets** (§18): not yet measured. No numbers are claimed.
- **Bluetooth audio switching** (needs SwitchAudioSource on macOS; per-playback only on Windows).
