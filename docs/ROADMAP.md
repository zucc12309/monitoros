# Roadmap

## Next (MVP gaps)

1. **Windows validation on the Dell G7.**
   - Run `scripts/windows/setup.ps1` and `build.ps1`.
   - Verify WebView2, COM audio, the mpv pipe and NVIDIA hwdec.
   - Measure HDD cold start.
2. **Real-iPhone pass.** Check PWA install, iOS background reconnect, and optional self-signed TLS with certificate pinning.
3. **Honest availability data.** Preinstall Stremio's official **WatchHub** add-on (live as of 2026-10-24) to turn "Availability unknown" into real per-service links where WatchHub has them. Also add a TMDB watch-providers adapter for users who bring their own key (JustWatch-sourced, India coverage).
4. **Official public-domain add-on.** Add `org.stremio.pubdomainmovies` as a preinstalled, `public-domain`-provenance provider.
5. **Sleep/wake and display hot-plug recovery.** Listen for monitor changes, re-apply TV mode on the active external display, and restart the remote server after wake.
6. **Performance.** Measure launcher-ready time, navigation latency, remote round-trip (the PWA already shows ms) and idle RSS on both machines, then record the results in TEST_REPORT.md.
7. **Subtitle add-ons.** Bring in OpenSubtitles v3 results and route them to mpv `--sub-file`.

## Later

- Jellyfin and Plex libraries (API tokens kept in the OS keychain).
- DLNA/UPnP discovery.
- Per-profile watch history.
- Kids mode.
- CEC (HDMI-CEC) via USB-CEC adapters, so the TV remote drives MonitorOS.
- Trakt sync (opt-in).

## Dedicated HDMI device

- **Linux platform adapter.** It already fits the `Platform` trait; currently it falls back to `NullPlatform`.
- **Kiosk image.** A minimal Linux plus a Wayland kiosk compositor (cage) booting straight into MonitorOS. mpv uses DRM/KMS output with VA-API.
- **Target boards.** N100-class mini PC first (Widevine L3 via Chromium app windows), then ARM SBCs.
- **OTA updates** via the Tauri updater with signed manifests.
