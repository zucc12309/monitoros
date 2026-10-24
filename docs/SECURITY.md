# Security & threat model

## Assets

- The user's machine: files, shell, other apps.
- Their streaming sessions.
- The LAN.
- Paired-device tokens.
- Watch history.

## Threats and mitigations

| Threat | Mitigation | Where | Tested |
|---|---|---|---|
| **Malicious add-on manifest** | Field-by-field validation, unknown fields dropped, size/count caps, adult refused, no code execution (add-ons are remote JSON only) | `provider-sdk/stremio.ts` | ✅ unit |
| **SSRF / LAN scanning via add-on or stream URL** | https only; blocks loopback, RFC1918, CGNAT, link-local/metadata (169.254.169.254), ULA, mapped IPv6, single-label and `.local/.internal/.lan` names, decimal/hex/short IPv4 forms | `url-guard.ts`, `provider-runtime` | ✅ 28 TS + Rust cases |
| **DNS rebinding (egress)** | Rust resolves DNS itself, rejects if *any* address is private, then pins the connection to the checked address | `provider-runtime::guarded_get_*` | ✅ |
| **Unsafe redirects** | `redirect::Policy::none()`; a 3xx is an error | `provider-runtime` | ✅ live local server |
| **Remote-control abuse** | Closed command enum with no path/URL/shell variants; numeric range checks; text stripped of control chars; 2 KiB message cap | `monitoros-core::remote`, `contracts/remote.ts` | ✅ |
| **Pairing brute force** | Desktop approval *plus* a 6-digit code shown only on the TV (never sent to the phone); 2-minute expiry; 5 attempts; max 4 pending requests; global 10-burst rate limit | `pairing.rs`, `remote-server` | ✅ |
| **Token theft** | 48-char random token, stored only as SHA-256, constant-time compare, 30-day expiry, per-device revoke (takes effect on the next message), sent as the first WS message (never in a URL or log) | `pairing.rs`, `remote-server` | ✅ |
| **WebSocket hijacking (CSWSH)** | `Origin` must equal `http(s)://<bound host>` on WS and POST | `remote-server` | ✅ e2e |
| **DNS rebinding (remote server)** | `Host` header must equal the bound IP:port literal | `remote-server` | ✅ e2e |
| **Replay** | Per-connection strictly increasing `seq` | `ReplayGuard` | ✅ |
| **Command flooding** | Token bucket: 30 burst, 20/s per connection | `RateLimiter` | ✅ |
| **Exposure to the internet** | Binds a single private LAN IP (or loopback), never `0.0.0.0`. Public binds refused at startup | `is_allowed_bind` | ✅ |
| **Path traversal (local playback)** | File must canonicalize inside a user-added library root. Roots `/`, home, and system dirs refused | `media-engine::library` | ✅ |
| **Option injection into mpv** | Target passed after `--`; leading `-`, `file://`, `edl://`, `av://`, `lavfi` refused; `--load-scripts=no --config=no --ytdl=no`; no shell anywhere | `media-engine::mpv` | ✅ |
| **Untrusted subtitles** | https-only URLs; mpv parses them in its own process (crash-isolated from the UI) | normalize + mpv | ✅ partial |
| **Third-party page in in-app service window** | No IPC capability for that window; navigation limited to https/about/blob/data; back button uses a sentinel URL, not IPC | `services.rs`, `capabilities/default.json` | ✅ unit; manual for UI |
| **Remote driving a service page** | Commands reach the in-app service page only as a validated enum serialised to a JSON literal and passed to a fixed handler (`service_remote.js`). The page can only act on itself | `services::forward` | ✅ unit + 5 E2E |
| **Remote typing into other apps** | By design (user request), when another app is in front a *paired, approved* phone sends real keys/mouse to it, so the remote works in every app. Limited to the closed command set (arrows, Enter, Esc, Space, the full-screen shortcut, typed text, pointer, scroll); no shortcuts like Cmd+Q, Cmd+Tab or Win+R. Can be switched off: Settings › iPhone Remote › "Remote controls other apps". macOS additionally requires the user to grant Accessibility | `routing.rs`, `input.rs` | ✅ routing + mapping unit; manual for OS |
| **Credential theft** | MonitorOS never asks for streaming passwords; sign-in happens on the provider's own page | design | n/a |
| **XSS in UI** | React escaping; strict CSP (no `unsafe-eval`; verified, since Playwright's eval-based wait was blocked); `freezePrototype` | `index.html`, `tauri.conf.json` | ✅ |
| **Privilege escalation** | No elevated operations. Autostart is a user LaunchAgent / Run key via the official plugin, enabled only by an explicit toggle | design | n/a |

## Known gaps

- **Plain http on the LAN:** the remote PWA is served over plain `http://<LAN-IP>`. Traffic on the LAN is not encrypted. Tokens can't be replayed across connections, but someone sniffing the same Wi-Fi could read one. Planned: an optional self-signed TLS mode with certificate pinning in the PWA.
- **No add-on sandboxing beyond declarative JSON:** if JS add-ons are ever supported, they must run in an isolated worker with only the fetcher capability.
- **Unsigned dev builds:** these are local builds. See ARCHITECTURE.md › Packaging for signing.
