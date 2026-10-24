# Architecture

```text
┌──────────────────────── MonitorOS.app / MonitorOS.exe (Tauri 2) ────────────────────────┐
│  WebView "main" (React + Zustand, apps/desktop/src)                                      │
│   pages ─ focus engine ─ store ─ bridge.ts ──invoke──┐                                   │
│                                                      ▼                                   │
│  Rust shell (apps/desktop/src-tauri)   commands.rs  remote.rs  services.rs              │
│     │            │              │             │              │                           │
│  storage     media-engine   provider-     remote-server   platform-macos / -windows      │
│  (SQLite +   (mpv process   runtime       (axum HTTP+WS,  (displays, audio, volume)      │
│   event log)  + JSON IPC,   (guarded      pairing, PWA)                                  │
│               library scan)  egress)                                                     │
└──────────┬─────────────────────────────────────────┬────────────────────────────────────┘
           │ mpv window (separate process)            │ LAN, private IP only
           ▼                                          ▼
       local files / https streams             iPhone PWA (apps/remote)
```

## Bounded contexts

| Context | TS package | Rust crate | Owns |
|---|---|---|---|
| Contracts | `packages/contracts` | `monitoros-core` | MediaItem, PlaybackSource, remote protocol, pairing, platform trait |
| Providers | `packages/provider-sdk` | `provider-runtime` | Stremio protocol, URL guard, registry, dedupe, source ranking, guarded HTTP |
| Metadata | `packages/metadata` | – | Curated rows, Cinemeta, Internet Archive, subscription services, M3U, search |
| Playback | `packages/player` | `media-engine` | Route planning, player state machine, resume rules, mpv, library scan |
| Remote | `apps/remote` | `remote-server` | PWA, pairing API, authenticated WebSocket |
| Platform | – | `platform-macos`, `platform-windows` | Displays, audio devices, volume/mute |
| Persistence | – | `storage` | SQLite with an `events` log written in the same transaction as projections |

## Playback routing (`packages/player`)

```text
MediaItem → ProviderRegistry.streams() → normalizeStreams (guard, drop P2P)
          → rankSources (subscription > verified free > quality/codec/region; unverified hidden)
          → planPlayback:
              DRM / external  → open service (in-app window | Chrome app window | browser)
              local file      → mpv (path must resolve inside a library root)
              http(s) stream  → mpv if installed, else <video>/hls.js (codec-checked)
          → session state machine → progress (throttled, resume after 30 s, done at last 5 %)
```

## TV / Desktop mode

- **TV mode:** un-minimise, full screen, focus.
- **Desktop mode:** close any service window, leave full screen, minimise. Other apps are never touched.
- **Switching** works from:
  - the rail button
  - the tray menu
  - the iPhone remote
  - the global shortcut **Cmd+Shift+M** (macOS) / **Ctrl+Shift+M** (Windows), which is also the recovery path if full screen misbehaves.

## Streaming services

See `apps/desktop/src-tauri/src/services.rs`. The default is a full-screen in-app window with a Safari user agent on macOS, plus an injected "← MonitorOS" button that navigates to `https://monitoros.invalid/close`, which the shell intercepts. The external page gets no IPC: capabilities are scoped to the `main` window.

## Packaging

- **macOS:** `scripts/macos/build.sh` produces `MonitorOS.app` and a DMG.
  - Builds are unsigned by default. To distribute:
    1. set `bundle.macOS.signingIdentity` (Developer ID Application)
    2. export `APPLE_ID`, `APPLE_PASSWORD` (app-specific) and `APPLE_TEAM_ID`
    3. run `tauri build`, which notarizes and staples.
  - Unsigned local builds run after right-click › Open.
- **Windows:** `scripts/windows/build.ps1` produces MSI and NSIS installers. The installer bootstraps WebView2 if missing. Code-sign with `bundle.windows.certificateThumbprint`.
- **mpv** is not bundled (GPL/LGPL licensing and size). The app finds it in Homebrew, `/Applications/mpv.app`, Program Files, scoop, PATH, or next to the executable.
