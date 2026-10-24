# MonitorOS threat model

Audit date: 2026-10-24. Scope: checked-out npm/Cargo workspace, desktop/native bridge, remote PWA, release/setup tooling and installed mpv. Existing uncommitted catalog/navigation work is preserved. This is a source and local macOS assessment, not a Windows/iPhone certification.

## Assets and boundaries

| Boundary | Untrusted input / attacker | Assets and controls |
|---|---|---|
| Internet → provider-runtime | Malicious add-on, metadata, M3U, DNS answer or redirect | Local network/files; HTTPS, credential rejection, DNS checks, pinned addresses, no redirects, response cap |
| Internet → player/browser | Media, subtitles, streaming websites | Native process/user session; argument arrays, mpv scripting disabled, Tauri origin ACL; nested media fetching remains a separate boundary |
| Webview → Tauri | Compromised remote service or main frontend | Storage, player, OS input/process launch; remote origins require ACL, main is trusted and privileged |
| LAN → remote-server | Unpaired client, hostile website, paired malicious phone, network interceptor | OS input and playback; literal Host, Origin, TV approval/code, hashed bearer, expiry/revocation, rate/frame limits |
| Process → local storage/IPC | Other local accounts, same-user malicious software | Watch history, settings, token hashes, mpv control; private directories and IPC required; same-user compromise is not isolated |
| Repository → developer/release | Compromised dependency/action/update or malicious PR | Developer credentials and signed releases; lockfiles, pinned actions, scans, restricted CI tokens |

## Abuse scenarios

1. Add-on uses numeric/IPv6/translated address, mixed DNS answers, redirects or an oversized streamed response to reach local services or exhaust memory.
2. Streaming page invokes a native command or subscribes to sensitive events. Installed Tauri must reject remote origins and service windows; plugin permissions alone are not sufficient evidence.
3. A paired client stays connected after expiry, revocation or disabling remote, bypasses connection-local throttles with many sockets, or fills dispatch queues.
4. LAN observer steals plaintext HTTP pairing/session bearer and reconnects. Sequence counters protect only each connection; they do not provide transport confidentiality or bearer replay resistance.
5. A media playlist redirects or references private hosts/local files after initial URL validation. mpv parses media outside the provider HTTP guard; initial validation does not establish complete egress isolation.
6. A dependency/build script or CI action executes in a credential-bearing environment. Development-only advisories still matter on developer machines but are not automatically packaged-app vulnerabilities.
7. Browser retry/duplicate handlers spawn unwanted processes. Source tracing and controlled tests must distinguish app behavior from unrelated browser automation.

## Assumptions and residual design decisions

The trusted main UI may exercise native commands. Remote service origins have no authorized native privileges. User-approved LAN playlists are explicitly distinct from Internet add-ons. Same-user malware, OS compromise and compromised streaming accounts are outside this application's isolation guarantees. Remote transport encryption, comprehensive media egress isolation, signed distribution, and platform runtime tests require separate validation; no custom cryptography will be introduced.
