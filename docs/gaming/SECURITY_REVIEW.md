# Gaming integration: security review of reference projects

Reviewed 2026-10-25, before any integration work. Sources were shallow clones, read only (never built or run):

- [Dolphin](https://github.com/dolphin-emu/dolphin) at `b5f580e`
- [PartyPad](https://github.com/benmross/partypad) at `71ee10d`
- [SuperTuxKart](https://github.com/supertuxkart/stk-code) at `e05fef3`

Data sources:

- GitHub security advisories
- NVD (no CVEs filed for either Dolphin or SuperTuxKart)
- [OSV.dev](https://osv.dev) for pinned dependency versions
- Direct source reading

## Summary

| Project | License | Maturity | Security verdict for MonitorOS |
|---|---|---|---|
| **Dolphin** | GPL-2.0+ | Mature, very active | **Use as an external program, version ≥ 2609 only.** It has 7 advisories in 2026, 3 of them high, including guest-to-host code execution. Treat game images and memory cards as untrusted input. |
| **PartyPad** | MIT | Alpha, single author, 0 stars, created 2026-07 | **Do not depend on or run it.** Reuse ideas only (DSU server, slot reservation). Its local mode has no authentication or Origin check, and it pins dependencies with 1 critical and 7 high advisories. |
| **SuperTuxKart** | GPL-3.0 (code), mixed CC licences (assets) | Mature, active | **Future reference only.** It bundles old C/C++ libraries, for example ENet 1.3.14 (upstream is 1.3.18). Run it as an external program; don't link it. |

## Dolphin

### Published advisories

There are 7 GitHub advisories, none with a CVE number.

| Advisory | Severity | Issue | Fixed in |
|---|---|---|---|
| GHSA-4q28-hhjv-hf3f | **High** | DSP-HLE AX voice update: out-of-bounds stack write → **host code execution** | 2606a / 2606-235 |
| GHSA-7pvc-j9pm-c2rp | **High** (7.8) | GCZ disc image reader heap overflow via crafted block pointers | 2606a / 2606-272 |
| GHSA-gwwh-9r4g-8rqq | **High** | GCMemcardDirectory heap out-of-bounds read/write, **escapes the emulated sandbox** | **2609** / 2606-387 |
| GHSA-6839-x3rg-fqgv | Medium (6.1) | Zelda DSP-HLE discloses a host pointer | 2609 / 2606-387 |
| GHSA-5fqv-9qrg-gm4j | Medium | IOS socket IOCTLs leak uninitialised host memory | 2606a / 2606-265 |
| GHSA-983q-fjjx-96h3 | Medium | Zelda DSP-HLE out-of-bounds stack read | 2606a / 2606-298 |
| GHSA-27c8-xjgc-74mj | Low (3.3) | DOL loader integer overflow (heap out-of-bounds read) | 2606a / 2606-239 |

### Consequences for MonitorOS

- **Minimum version:** refuse to launch Dolphin older than **2609**, or dev builds older than **2606-387**. Read the version, show "update Dolphin", and don't override it. The latest release is 2609a. It's not installed on the test Mac.
- **Untrusted input:** game images, memory-card folders and save files can trigger these bugs. Only launch files the user explicitly picked. Never fetch game files from the network, and never auto-open files from downloads or shared folders.
- **No bundling:** Dolphin is GPL-2.0+ and MonitorOS is MIT. Launch the user's installed Dolphin as a separate process with an argument array (no shell). Don't link it or ship it.
- **Netplay:** keep Dolphin's netplay out of scope. Local multiplayer doesn't need it, and it adds a network attack surface.

### Controller path (DSU / Cemuhook), verified in source

`InputCommon/ControllerInterface/DualShockUDPClient`:

- 4 slots per server (`PORT_COUNT = 4`).
- The default server is `127.0.0.1:26760`, and multiple servers can be configured.
- Packets carry a protocol version and a CRC32. That's an integrity check, **not authentication**: any local process could send to Dolphin's DSU client.

So MonitorOS must serve DSU on **loopback only**. A same-user malicious process is already outside MonitorOS's threat model (see docs/security-audit).

## PartyPad

### Code findings

| # | Finding | Severity for MonitorOS | Evidence |
|---|---|---|---|
| P1 | **Local controllers are unauthenticated.** Anyone on the Wi-Fi who opens the page gets a player slot. Its SECURITY.md says so: "local controllers are not authenticated beyond network access". | High | `SECURITY.md`; `server.py` `ws_handler` |
| P2 | **No Origin check on the WebSocket.** A web page the host or a phone visits could connect and send input (cross-site WebSocket hijacking). | High | no Origin/Host validation in `server.py` |
| P3 | **Web server binds `0.0.0.0` in local mode**, i.e. every interface, including any public one. | Medium | `server.py:980` |
| P4 | **Slot identity is chosen by the client**, a `?client=` value from the browser's localStorage. It's random 128-bit, so it can't realistically be guessed, but it's a bearer secret in a URL. URLs can leak (logs, history). | Low | `server.py:514`, `static/app.js:57` |
| P5 | **Privileged hotspot helper** run through `pkexec`, plus an optional cloud mode on Cloudflare. MonitorOS forbids both. | Not applicable (don't adopt) | `ap_helper.py`, `hotspot.py`, `cloudflare/` |

Good practices worth keeping:

- the DSU server binds `127.0.0.1`
- processes are spawned with argument arrays (no `shell=True`)
- input values are clamped with `isfinite` checks
- 16 KiB WebSocket message cap
- per-slot reconnect reservations, with only the current socket able to release a slot

### Dependencies (OSV, pinned versions in `uv.lock` / `package-lock.json`)

- **Python (56 pinned):**
  - **Critical:** `certifi 2026.6.17` bundles emSign roots with compromised intermediate CA keys. Fixed in 2026.10.19.
  - **High:**
    - `aiohttp 3.14.1`, which is the web and WebSocket server itself: no initial request/header timeout, unbounded memory/CPU, file-descriptor exhaustion, and an out-of-bounds heap read in the C parser. There are also moderate request-smuggling issues, including via WebSocket upgrade. All fixed in 3.14.4.
    - `urllib3 2.7.0` (2 high issues), fixed in 2.8.0.
    - `cryptography 49.0.0`: Bleichenbacher oracle. Fixed in 50.0.0.
  - **Moderate/low:** `multidict`, `setuptools`.
- **npm, Cloudflare worker (164):** 9 packages with advisories, including `undici@7.28.0` (18 advisories), `vite@8.1.4`, `sharp`, `zod` and `nanoid`.

### Consequences for MonitorOS

Don't vendor or run PartyPad. Implement the DSU server in Rust inside MonitorOS (MIT licence, so the ideas can be reused freely). Put it behind MonitorOS's existing remote protections:

- TV approval plus a code for every phone
- Host and Origin checks
- per-message expiry and revocation checks
- rate limits

## SuperTuxKart

- **Licence:** GPL-3.0 code, mixed-licence assets. Launch it as a separate program; don't link it.
- **Published advisories:** none (GitHub or NVD), and no open issues tagged as security.
- **Bundled third-party code:** ENet 1.3.14 (2019; upstream 1.3.18 contains reliability fixes, none flagged as security), an Irrlicht fork, unmaintained `mcpp`, AngelScript, Bullet and wiiuse. Old bundled C/C++ libraries are the main residual risk, and they only matter if STK's online server mode is exposed. MonitorOS should only use local play.
- **Network crypto:** pluggable OpenSSL, mbedTLS or CryptoKit backends (`src/network/crypto_*`). Not reviewed in depth, since STK online play isn't in scope.

## What this review does not cover

- No dynamic testing, fuzzing or building of any of the three projects.
- Dolphin's DSU client was read, not tested. MonitorOS's own DSU implementation still needs its proof of concept with real Dolphin (Phase 2).
- No Windows-specific review (for example, virtual gamepad drivers).
