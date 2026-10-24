# Reference research

Sources were shallow-cloned on 2026-10-24 and read directly. Statements below come from source files, not READMEs, unless marked *(README)*. Nothing from these repos was copied into MonitorOS. All MonitorOS code is original, and the license column explains why.

## Summary

| Repo | Stack | License | Reuse in MonitorOS |
|---|---|---|---|
| [Streamee](https://github.com/StreameeApp/Streamee-app) | Tauri 2 + React/TS + Rust, mpv over IPC, Stremio add-ons | **GPL-3.0** | Patterns only. Copying code would force GPL on MonitorOS. |
| [stremio-official-addons](https://github.com/Stremio/stremio-official-addons) | Static `index.json` of manifests + Rust build crate | MIT | Protocol shapes; the manifest list was used to validate our parser. |
| [CineMoy](https://github.com/SaeedMoy/CineMoy) | Node/Express + WebTorrent + FFmpeg, Electron, Android | **No LICENSE file** (all rights reserved) | Nothing. Patterns studied only. |
| [ELI6 Movies](https://github.com/EliseyRotar/eli6_movies) | Static HTML/JS + Express, third-party embeds | **No LICENSE file** | Nothing. |
| [Scenic](https://github.com/vanshaj-pahwa/scenic) | CRA React + Vercel functions + Cloudflare worker | MIT | Season/episode URL patterns only. |

## Streamee (GPL-3.0)

Files read: `src-tauri/Cargo.toml`, `src-tauri/src/{remote_server,addons,mpv_ipc,credential_vault}.rs`.

- **Stack:** pins `tauri =2.11.5`, `tauri-plugin-store`, `-dialog`, `-updater`, `reqwest 0.11`, and `tokio`.
- **mpv:** `mpv_ipc.rs` is 3,840 lines, and every IPC path is behind `#[cfg(target_os = "windows")]` using a Windows named-pipe `HANDLE`. In this snapshot, macOS mpv control is not implemented.
  - **MonitorOS:** `crates/media-engine/src/mpv.rs` implements both Unix sockets and Windows named pipes behind one API. On macOS it is verified by a real integration test.
- **Add-on install (`addons.rs`):**
  - Good practices worth matching: `redirect::Policy::none()`, an `is_private()` check, forcing a `/manifest.json` suffix, and a request timeout.
  - It also accepts `http://localhost` add-ons and rewrites them to `127.0.0.1`.
  - **MonitorOS:** add-ons are https-only, every resolved IP is checked, and the connection is pinned to the checked address (DNS-rebinding defence).
- **Remote control (`remote_server.rs`):**
  - Binds `0.0.0.0:<port>` and serves an embedded PWA from a hand-rolled HTTP parser.
  - A search for `token|auth|pin|secret|origin` finds **no authentication or origin checks**. Anyone on the network can send commands.
  - **MonitorOS:** binds one private LAN IP, requires desktop approval plus a 6-digit code, stores only hashed tokens, and checks Host and Origin on every request.
- **Credentials (`credential_vault.rs`):** uses Windows Credential Manager; non-Windows builds are stubs that return errors.

## Stremio official add-ons (MIT)

Files read: `index.json`, `Cargo.toml`.

- **`index.json`** lists these manifests with transport URLs:
  - `com.linvo.cinemeta` (catalog, meta)
  - `org.stremio.watchhub` (streams = "where to watch" external links)
  - `org.stremio.pubdomainmovies`
  - OpenSubtitles v3
  - Channels
  - `org.stremio.local` at `http://127.0.0.1:11470` (desktop-local)
- **Resource URLs** follow the pattern `{base}/{resource}/{type}/{id}[/{extra}].json`, with `extra` as `k=v&k=v`.
- **IDs:** IMDb `tt…` ids. Series episodes are `tt…:season:episode`.
- **Implemented as:** `packages/provider-sdk/src/stremio.ts`, tested against the real Cinemeta manifest shape.
- **Liveness checked 2026-10-24:** the WatchHub manifest returned 200 and the public-domain movies manifest returned 200.

## CineMoy (no license)

Files read: `server/{addons,torrent,transcode}.js`, `package.json`.

- **Metadata and streams:** Cinemeta for metadata, Torrentio as the default stream add-on, and WebTorrent (`maxConns: 80`) for playback. These are served over a local Express HTTP server.
- **Transcoding:** an optional FFmpeg "compatibility mode" remuxes/transcodes HEVC/AC3/DTS to fragmented MP4 for browsers.
- **Low disk:** a low-disk guard stops whole-file downloading.
- **Decisions for MonitorOS:**
  - **No torrent engine.** P2P streams (`infoHash`) are dropped during normalization, because swarm content provenance can't be verified and seeding uploads content.
  - **No automatic transcoding.** mpv plays HEVC/AC3/DTS natively.
  - **Adopted from CineMoy:** its Homebrew-path lookup idea (`/opt/homebrew/bin`), since Finder-launched apps lack the shell PATH. We do the same for mpv.

## ELI6 Movies (no license)

Files read: `package.json`, `addons.txt`, `frontend/player.html`.

- **Player:** embeds third-party iframe players from `vidsrc.cc`, `vidlink.pro`, `vidfast.pro`, `embed.su` and `vixsrc.to`. Fallback is switching servers by hand.
- **Rights:** none of these hosts state distribution rights.
- **Concerning feature note:** the developer's notes in `addons.txt` include a "custom domain… to bypass ISP blocks and avoid detection" option.
- **Decision for MonitorOS:** no embed-scraper providers. The provider SDK records provenance, and the UI never auto-selects unverified sources.

## Scenic (MIT)

Files read: `api/_sources.js`, `api/hls-proxy.js`.

- **Source tiers:** "catalog / mirror / relay" tiers come from env vars (`CATALOG_BASE`, `MIRROR_BASE`, `RELAY_BASE`). The client walks a flat index and falls through on failure.
- **HLS proxy:** `hls-proxy.js` rewrites manifests and **injects Referer/Origin headers the browser can't set, with a spoofed Chrome UA**, to satisfy upstream token binding.
- **Decision for MonitorOS:** the fall-through-on-failure UX is good and is reflected in `rankSources` plus manual source selection. Header spoofing to get around upstream access controls is not adopted.

## Implemented from scratch (original)

These were built new for MonitorOS rather than reused:

- Provider SDK
- Spatial focus engine
- Pairing protocol
- Guarded egress
- mpv controller (Unix and Windows)
- Library scanner
- Platform adapters
- Remote PWA
- All UI
