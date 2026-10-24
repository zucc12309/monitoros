# Implementation status

Legend: ✅ done and tested · 🟡 implemented, not verified on target hardware · ⬜ not started

| Phase / feature | Status | Notes |
|---|---|---|
| **1 Foundation** | | |
| Monorepo (npm workspaces + Cargo workspace) | ✅ | pnpm needs Node 22; npm used |
| Tauri 2 shell, React/TS/Vite/Tailwind/Zustand | ✅ | macOS release bundle built |
| TV home screen matching the mock-up | ✅ | |
| Deterministic focus engine + remote/keyboard/media keys | ✅ | side rail, per-row memory, per-page restore |
| TV ⇄ Desktop mode (button, tray, shortcut, remote) | 🟡 | logic built; full screen not yet observed on an external display |
| **2 Discovery** | | |
| Curated rows (Hindi, South, Hollywood, Anime, …) with live Cinemeta metadata | ✅ | 36 IMDb ids verified |
| Unified search (title/actor/director/genre/year/free) + dedupe | ✅ | |
| Watchlist, Continue Watching, resume | ✅ | |
| Subscription selection + service hand-off | ✅ | search deep links for Netflix/Prime/ZEE5/YouTube/Apple TV |
| Services inside MonitorOS (in-app window + back button) | 🟡 | DRM acceptance per service unverified |
| TMDB adapter | ⬜ | Cinemeta covers metadata without a key |
| **3 Free streaming** | | |
| Provider SDK + registry + health | ✅ | |
| Internet Archive public-domain films (integrated playback) | ✅ | E2E plays real film |
| MX Player / YouTube / WAVES launchers | ✅ | hand-off only |
| Stremio-compatible add-ons (install/validate/enable/remove) | ✅ | |
| Source ranking with provenance; unverified hidden | ✅ | |
| **4 Playback** | | |
| mpv native player (Unix socket + Windows pipe) | ✅ / 🟡 | macOS tested; Windows compile-checked |
| HTML5 + hls.js fallback | ✅ | |
| Subtitles, audio-track cycling, speed, hwdec toggle | 🟡 | commands built; not hand-tested |
| Local library (folders, USB/NAS mounts, sidecar subs) | ✅ / 🟡 | scanner tested; UI flow needs the desktop app |
| IPTV M3U (user playlists, LAN opt-in) | ✅ | parser tested |
| **5 iPhone remote** | | |
| PWA: pairing, D-pad, touchpad, media, volume, text, mode | ✅ | emulated; real iPhone pending |
| Auth WS, heartbeats, reconnect, acks, rate limit, replay guard | ✅ | |
| **6 Platform** | | |
| macOS displays/audio/volume | ✅ | live read-only test passes |
| Windows displays/audio/volume (COM) | 🟡 | compile-checked only |
| Autostart (opt-in), recovery shortcut, tray | 🟡 | |
| Sleep/wake + monitor hot-plug recovery | ⬜ | |
| macOS DMG / Windows MSI+NSIS scripts | ✅ / 🟡 | DMG built; Windows untested |
| **7 Hardening** | | |
| Threat model + security tests | ✅ | docs/SECURITY.md |
| Performance measurement | ⬜ | |
| Code signing / notarization | ⬜ | documented |
