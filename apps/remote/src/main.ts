import type { NavKey, RemoteCommand, RemoteStatus } from "@monitoros/contracts";
import { RemoteConnection, completePairing, getToken, requestPairing, setToken, takeTicket, type ConnState } from "./connection";
import { controllerActive, join as rejoinGame, renderController, showPlayers, suspend as suspendController } from "./controller";
import "./style.css";

const app = document.getElementById("app")!;
let conn: RemoteConnection | null = null;
/** Touchpad mode: "swipe" = D-pad gestures, "cursor" = the computer's mouse (trackpad). */
let padMode: "swipe" | "cursor" = "swipe";
let padModeLocked = false; // user chose a mode explicitly
/** What the remote is driving (from the TV's status). */
let control: "monitoros" | "page" | "system" = "monitoros";

function setPadMode(m: "swipe" | "cursor") {
  padMode = m;
  const t = document.getElementById("padmode");
  const hint = document.querySelector(".pad .hint");
  if (t) t.textContent = m === "cursor" ? "Mouse ✓" : "Swipe ✓";
  if (hint) hint.textContent = m === "cursor" ? "1 finger: move · Tap: click · 2 fingers: scroll" : "Swipe to move · Tap to select";
}

const h = (html: string) => {
  app.innerHTML = html;
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => app.querySelector<T>(sel)!;

function haptic() {
  // iOS Safari ignores vibrate; harmless elsewhere.
  navigator.vibrate?.(8);
}

// ---------------- pairing ----------------

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Phone";
}

function renderPairing(message = "") {
  h(`
    <section class="pair">
      <div class="logo">M</div>
      <h1>Pair with MonitorOS</h1>
      <p class="muted">Your phone and computer must be on the same Wi-Fi.</p>
      <label>Name this phone<input id="name" maxlength="40" value="${guessDeviceName()}" /></label>
      <button id="start" class="primary">Pair</button>
      <p class="msg">${message}</p>
    </section>`);
  $("#start").onclick = async () => {
    const name = $<HTMLInputElement>("#name").value.trim() || "Phone";
    try {
      const requestId = await requestPairing(name);
      renderAwaitApproval(requestId);
    } catch (e) {
      renderPairing(`Couldn't start pairing: ${(e as Error).message}`);
    }
  };
}

/** From the TV's QR code; used if this phone isn't paired (any more). */
let ticket = takeTicket();

/** Scanned the TV's QR code: the TV only has to tap Allow, nothing to type. */
async function scanPair(t: string) {
  ticket = null; // single use
  h(`
    <section class="pair">
      <div class="logo">M</div>
      <h1>Tap Allow on the TV</h1>
      <p class="muted">This phone is asking to be the remote. It will stay paired.</p>
      <p class="msg" id="msg"></p>
    </section>`);
  try {
    const requestId = await requestPairing(guessDeviceName(), t);
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
      const r = await completePairing(requestId, t);
      if (!("waiting" in r)) {
        setToken(r.token);
        return start();
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    renderPairing("Not allowed on the TV in time. Scan the code again, or pair here.");
  } catch (e) {
    renderPairing(`${(e as Error).message}`);
  }
}

function renderAwaitApproval(requestId: string, message = "") {
  h(`
    <section class="pair">
      <h1>Check your TV</h1>
      <p class="muted">Choose <b>Allow</b> on the TV, then type the 6-digit code it shows.</p>
      <input id="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="••••••" class="code" />
      <button id="go" class="primary">Connect</button>
      <p class="msg">${message}</p>
    </section>`);
  const submit = async () => {
    const code = $<HTMLInputElement>("#code").value.replace(/\D/g, "");
    if (code.length !== 6) return;
    try {
      const r = await completePairing(requestId, code);
      if ("waiting" in r) return renderAwaitApproval(requestId, "Not approved on the TV yet.");
      setToken(r.token);
      start();
    } catch (e) {
      const m = (e as Error).message;
      if (/not found|expired|too many/i.test(m)) renderPairing(`${m}. Start again.`);
      else renderAwaitApproval(requestId, m);
    }
  };
  $("#go").onclick = submit;
  $<HTMLInputElement>("#code").oninput = (e) => (e.target as HTMLInputElement).value.length === 6 && submit();
}

// ---------------- remote ----------------

function send(cmd: RemoteCommand) {
  haptic();
  if (!conn?.send(cmd)) flash("Not connected");
}

function flash(text: string) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 1400);
}

function renderRemote() {
  h(`
    <header>
      <span id="dot" class="dot"></span><span id="state">Connecting…</span>
      <button id="fs" class="pill" aria-label="Full screen">⛶ Full screen</button>
      <button id="mode" class="pill">TV ⇄ Desktop</button>
      <button id="game" class="pill">🎮 Controller</button>
    </header>
    <div id="now" class="now hidden"></div>
    <div id="pad" class="pad" aria-label="Touchpad">
      <span class="hint">Swipe to move · Tap to select</span>
      <button id="padmode" class="pill padmode">Swipe ✓</button>
    </div>
    <div class="dpad">
      <button data-nav="up" class="up" aria-label="Up">▲</button>
      <button data-nav="left" class="left" aria-label="Left">◀</button>
      <button data-nav="ok" class="ok">OK</button>
      <button data-nav="right" class="right" aria-label="Right">▶</button>
      <button data-nav="down" class="down" aria-label="Down">▼</button>
    </div>
    <div class="row">
      <button data-nav="back">Back</button>
      <button data-nav="home">Home</button>
      <button data-nav="search">Search</button>
    </div>
    <div class="row">
      <button id="rew" aria-label="Back 10 seconds">−10s</button>
      <button id="pp" class="primary" aria-label="Play or pause">▶︎❚❚</button>
      <button id="fwd" aria-label="Forward 10 seconds">+10s</button>
    </div>
    <div class="row">
      <button id="vdown" aria-label="Volume down">Vol −</button>
      <button id="mute">Mute</button>
      <button id="vup" aria-label="Volume up">Vol +</button>
    </div>
    <form id="kb" class="kb">
      <input id="text" type="search" placeholder="Type to search on the TV" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" />
      <button class="primary">Search</button>
    </form>
    <footer><span id="lat" class="muted"></span><button id="unpair" class="link">Unpair this phone</button></footer>
    <div id="toast" class="toast"></div>`);

  app.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((b) => (b.onclick = () => send({ type: "nav", key: b.dataset.nav as NavKey })));
  // Search: focus the TV's search box AND open the phone keyboard (focus must
  // happen inside this tap for iOS to show the keyboard).
  $('[data-nav="search"]').onclick = () => {
    send({ type: "nav", key: "search" });
    const input = $<HTMLInputElement>("#text");
    input.focus();
    input.select();
  };
  $("#pp").onclick = () => send({ type: "media", action: "play-pause" });
  $("#rew").onclick = () => send({ type: "seek", deltaSec: -10 });
  $("#fwd").onclick = () => send({ type: "seek", deltaSec: 10 });
  $("#vup").onclick = () => send({ type: "volume", action: "up" });
  $("#vdown").onclick = () => send({ type: "volume", action: "down" });
  $("#mute").onclick = () => send({ type: "volume", action: "mute" });
  $("#mode").onclick = () => send({ type: "mode", target: "toggle" });
  $("#fs").onclick = () => send({ type: "fullscreen" });
  $("#game").onclick = openController;
  $("#unpair").onclick = () => {
    conn?.close();
    setToken(null);
    renderPairing("Unpaired. You can also revoke phones in Settings › iPhone Remote on the TV.");
  };
  const input = $<HTMLInputElement>("#text");
  let typing = 0;
  // Mirror what's typed into the TV's search box (debounced). Not for other
  // apps: there text can only be typed, not replaced, so it goes on Search.
  input.oninput = () => {
    clearTimeout(typing);
    if (control === "system") return;
    typing = window.setTimeout(() => conn?.send({ type: "text", value: input.value.slice(0, 256) }), 250);
  };
  $<HTMLFormElement>("#kb").onsubmit = (e) => {
    e.preventDefault();
    clearTimeout(typing);
    send({ type: "text", value: input.value.slice(0, 256), submit: true });
    input.value = "";
    input.blur(); // close the keyboard
  };
  $("#padmode").onclick = (e) => {
    e.stopPropagation();
    padModeLocked = true;
    setPadMode(padMode === "swipe" ? "cursor" : "swipe");
  };
  bindTouchpad($("#pad"));
  setPadMode(padMode);
}

/**
 * Touchpad. Swipe mode (Apple-TV style): swipes become D-pad steps, tap = OK.
 * Mouse mode (trackpad): one finger moves the computer's pointer, tap clicks,
 * two fingers scroll (e.g. Netflix rows sideways).
 */
function bindTouchpad(pad: HTMLElement) {
  const STEP = 42; // px of travel per nav step (swipe mode)
  let sx = 0, sy = 0, moved = false, t0 = 0, fingers = 0;
  let move = { dx: 0, dy: 0 };
  let scroll = { dx: 0, dy: 0 };
  let timer = 0;
  const clamp = (v: number) => Math.max(-500, Math.min(500, v));
  // Batch touch movement into ≤25 messages/s (server budget is 40/s).
  const flush = () => {
    timer = 0;
    if (move.dx || move.dy) conn?.send({ type: "pointer", dx: clamp(move.dx), dy: clamp(move.dy) });
    if (scroll.dx || scroll.dy) conn?.send({ type: "scroll", dx: clamp(scroll.dx), dy: clamp(scroll.dy) });
    move = { dx: 0, dy: 0 };
    scroll = { dx: 0, dy: 0 };
  };
  const centre = (e: TouchEvent) => {
    let x = 0, y = 0;
    for (const t of Array.from(e.touches)) {
      x += t.clientX;
      y += t.clientY;
    }
    return { x: x / e.touches.length, y: y / e.touches.length };
  };

  pad.addEventListener("touchstart", (e) => {
    const c = centre(e);
    sx = c.x;
    sy = c.y;
    if (e.touches.length === 1) {
      moved = false;
      t0 = Date.now();
    }
    fingers = Math.max(fingers, e.touches.length);
  }, { passive: true });

  pad.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const c = centre(e);
    const dx = c.x - sx, dy = c.y - sy;
    if (padMode === "cursor") {
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      const bucket = e.touches.length >= 2 ? scroll : move;
      bucket.dx += dx;
      bucket.dy += dy;
      sx = c.x;
      sy = c.y;
      timer ||= window.setTimeout(flush, 40);
      return;
    }
    if (Math.max(Math.abs(dx), Math.abs(dy)) < STEP) return;
    moved = true;
    const key: NavKey = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
    send({ type: "nav", key });
    sx = c.x;
    sy = c.y;
  }, { passive: false });

  pad.addEventListener("touchend", (e) => {
    if (e.touches.length > 0) {
      // A finger lifted mid-gesture: re-anchor so the pointer doesn't jump.
      const c = centre(e);
      sx = c.x;
      sy = c.y;
      return;
    }
    flush();
    const tap = !moved && Date.now() - t0 < 300;
    const wasMulti = fingers > 1;
    fingers = 0;
    if (!tap || wasMulti) return;
    if (padMode === "cursor") send({ type: "pointer", dx: 0, dy: 0, click: true });
    else send({ type: "nav", key: "ok" });
  });
}

function openController() {
  renderController(app, {
    send: (cmd) => conn?.send(cmd) ?? false,
    deviceId: () => conn?.deviceId ?? null,
    exit: () => {
      renderRemote();
      setState(conn?.state ?? "connecting");
    },
  });
  if (lastStatus) setStatus(lastStatus);
}

function setState(s: ConnState) {
  if (conn) conn.state = s;
  // Back online in controller mode: take the same player slot again.
  if (s === "online" && controllerActive()) rejoinGame();
  const dot = document.getElementById("dot");
  const label = document.getElementById("state");
  if (!dot || !label) return;
  dot.className = `dot ${s}`;
  label.textContent = { connecting: "Connecting…", online: "Connected", offline: "Reconnecting…", unauthorized: "Pairing expired" }[s];
  if (s === "unauthorized") {
    setToken(null);
    if (ticket) void scanPair(ticket);
    else renderPairing("This phone's pairing was revoked or expired. Pair again.");
  }
}

let lastStatus: RemoteStatus | null = null;

function setStatus(st: RemoteStatus) {
  lastStatus = st;
  if (controllerActive()) return showPlayers(st.game?.players, st.game?.error ?? undefined);
  if (st.control) control = st.control;
  const now = document.getElementById("now");
  const mode = document.getElementById("mode");
  if (mode) mode.textContent = st.mode === "tv" ? "Switch to Desktop" : "Switch to TV";
  if (!now) return;
  // A website (Netflix etc.) is showing: a mouse is the reliable way around it.
  // Outside MonitorOS's own interface (a streaming page or any other app),
  // a mouse is the reliable way to reach everything.
  const outside = st.control ? st.control !== "monitoros" : !!st.service?.open;
  if (!padModeLocked) setPadMode(outside ? "cursor" : "swipe");
  if (st.mouse === "needs-permission" && padMode === "cursor") {
    now.classList.remove("hidden");
    now.textContent = "To move the computer's mouse: on the computer open System Settings › Privacy & Security › Accessibility and turn on MonitorOS.";
    return;
  }
  if (outside) {
    now.classList.remove("hidden");
    now.textContent =
      st.control === "system"
        ? "Controlling the app in front · Home returns to MonitorOS"
        : "Controlling the streaming app · Home returns to MonitorOS";
    return;
  }
  if (st.nowPlaying) {
    now.classList.remove("hidden");
    now.textContent = `Now playing: ${st.nowPlaying.title}`;
  } else now.classList.add("hidden");
}

function start() {
  const token = getToken();
  if (!token) return ticket ? void scanPair(ticket) : renderPairing();
  renderRemote();
  conn?.close();
  conn = new RemoteConnection(token, setState, setStatus);
  conn.connect();
}

setInterval(() => {
  const lat = document.getElementById("lat");
  if (lat && conn?.latencyMs != null) lat.textContent = `${conn.latencyMs} ms`;
}, 1000);

/** Background longer than this: assume iOS killed the socket silently. */
const STALE_AFTER_MS = 10_000;
let hiddenAt = 0;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    suspendController();
    return;
  }
  if (!getToken()) return;
  // Reuse a healthy socket; otherwise reconnect at once (no backoff wait).
  if (conn) conn.reconnectNow(Date.now() - hiddenAt > STALE_AFTER_MS);
  else start();
});
// Wi-Fi came back, or Safari restored the page from its cache.
window.addEventListener("online", () => conn?.reconnectNow(true));
window.addEventListener("pageshow", (e) => (e as PageTransitionEvent).persisted && conn?.reconnectNow(true));

start();
