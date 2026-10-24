# MonitorOS

Turn a Windows PC, MacBook or mini PC into a Smart TV without replacing its OS. You get a couch-friendly launcher, your streaming apps, free public-domain films, local media through mpv, and an iPhone remote. Switch back to the normal desktop at any time.

**Status:** MVP on macOS (built and tested). Windows support is compile-checked but not yet run on hardware. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) and [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

## Quick start (macOS)

```bash
./scripts/macos/setup.sh
```

```bash
npm run tauri -- dev
```

Release build (`MonitorOS.app` and a DMG in `target/release/bundle/`):

```bash
./scripts/macos/build.sh
```

Unsigned builds open after right-click › Open.

## Quick start (Windows 10/11)

```powershell
./scripts/windows/setup.ps1
./scripts/windows/build.ps1
```

## Using it

| Want to… | Do |
|---|---|
| Move around | Arrow keys / D-pad. **OK** = Enter. **Back** = Esc. **/** = search |
| Leave TV mode | The **Desktop** button in the rail, the tray menu, or **Cmd/Ctrl + Shift + M** (always works) |
| Watch Netflix, Prime, JioHotstar… | Pick the app. It opens full screen inside MonitorOS; use **← MonitorOS** at top-left to come back. If a service won't play protected video there, switch Settings › Playback to **Chrome/Edge app window** |
| Watch free films | **Free**: public-domain films play in MonitorOS's own player |
| Play your files | **Library** › Add folder (MKV/HEVC/subtitles via mpv) |
| Use your iPhone | Settings › iPhone Remote › Start, scan the QR code, approve on the TV, type the code. Inside Netflix & co. the D-pad moves between titles and Back steps back. The touchpad becomes the computer's mouse (1 finger moves, tap clicks, 2 fingers scroll; macOS asks once for Accessibility). **Home** returns to MonitorOS. The remote also works in any other app in front (keys + mouse), and **⛶ Full screen** fills the screen with whatever app is showing |

### What plays inside MonitorOS's own player

- Free/public-domain films
- Your files
- Your IPTV playlists
- Direct streams from add-ons you trust

Subscription services are DRM-protected and play through their own web player inside a MonitorOS window (or Chrome). MonitorOS never decrypts, records or bypasses DRM, and never asks for your streaming passwords.

## Repository layout

```text
apps/desktop        React TV UI + Tauri shell (src-tauri)
apps/remote         iPhone PWA (served by the desktop app on your LAN)
packages/contracts  shared types + remote protocol validation
packages/provider-sdk  Stremio add-on protocol, URL guard, registry, ranking
packages/metadata   catalogue rows, Cinemeta, Internet Archive, services, M3U, search
packages/player     playback routing, player state machine, resume rules
crates/*            core, storage (SQLite + event log), media-engine (mpv, library),
                    provider-runtime (guarded egress), remote-server, platform-macos/-windows
tests/{security,e2e}   cross-package security tests, Playwright E2E
docs/               architecture, research, provider spec, security, test report, roadmap
```

## Tests

```bash
npm test
```

```bash
cargo test --workspace
```

```bash
npm run test:e2e
```

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Reference research](docs/REFERENCE_RESEARCH.md)
- [Provider spec](docs/PROVIDER_SPEC.md)
- [Security](docs/SECURITY.md)
- [Test report](docs/TEST_REPORT.md)
- [Roadmap](docs/ROADMAP.md)
