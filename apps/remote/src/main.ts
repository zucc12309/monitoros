import type { NavKey, RemoteCommand, RemoteStatus } from "@monitoros/contracts";
import { RemoteConnection, completePairing, getToken, requestPairing, setToken, type ConnState } from "./connection";
import "./style.css";

const app = document.getElementById("app")!;
let conn: RemoteConnection | null = null;

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
      <button id="mode" class="pill">TV ⇄ Desktop</button>
    </header>
    <div id="now" class="now hidden"></div>
    <div id="pad" class="pad" aria-label="Touchpad: swipe to move, tap to select">
      <span class="hint">Swipe to move · Tap to select</span>
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
      <input id="text" placeholder="Type to search on TV" autocomplete="off" autocapitalize="off" enterkeyhint="send" />
      <button class="primary">Send</button>
    </form>
    <footer><span id="lat" class="muted"></span><button id="unpair" class="link">Unpair this phone</button></footer>
    <div id="toast" class="toast"></div>`);

  app.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((b) => (b.onclick = () => send({ type: "nav", key: b.dataset.nav as NavKey })));
  $("#pp").onclick = () => send({ type: "media", action: "play-pause" });
  $("#rew").onclick = () => send({ type: "seek", deltaSec: -10 });
  $("#fwd").onclick = () => send({ type: "seek", deltaSec: 10 });
  $("#vup").onclick = () => send({ type: "volume", action: "up" });
  $("#vdown").onclick = () => send({ type: "volume", action: "down" });
  $("#mute").onclick = () => send({ type: "volume", action: "mute" });
  $("#mode").onclick = () => send({ type: "mode", target: "toggle" });
  $("#unpair").onclick = () => {
    conn?.close();
    setToken(null);
    renderPairing("Unpaired. You can also revoke phones in Settings › iPhone Remote on the TV.");
  };
  $<HTMLFormElement>("#kb").onsubmit = (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("#text");
    if (input.value) send({ type: "text", value: input.value.slice(0, 256) });
    input.value = "";
  };
  bindTouchpad($("#pad"));
}

/** Apple-TV-style touchpad: swipes become D-pad steps, taps become OK. */
function bindTouchpad(pad: HTMLElement) {
  const STEP = 42; // px of travel per nav step
  let sx = 0, sy = 0, moved = false, t0 = 0;
  pad.addEventListener("touchstart", (e) => {
    const t = e.touches[0]!;
    sx = t.clientX;
    sy = t.clientY;
    moved = false;
    t0 = Date.now();
  }, { passive: true });
  pad.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const t = e.touches[0]!;
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < STEP) return;
    moved = true;
    const key: NavKey = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
    send({ type: "nav", key });
    sx = t.clientX;
    sy = t.clientY;
  }, { passive: false });
  pad.addEventListener("touchend", () => {
    if (!moved && Date.now() - t0 < 300) send({ type: "nav", key: "ok" });
  });
}

function setState(s: ConnState) {
  const dot = document.getElementById("dot");
  const label = document.getElementById("state");
  if (!dot || !label) return;
  dot.className = `dot ${s}`;
  label.textContent = { connecting: "Connecting…", online: "Connected", offline: "Reconnecting…", unauthorized: "Pairing expired" }[s];
  if (s === "unauthorized") {
    setToken(null);
    renderPairing("This phone's pairing was revoked or expired. Pair again.");
  }
}

function setStatus(st: RemoteStatus) {
  const now = document.getElementById("now");
  const mode = document.getElementById("mode");
  if (mode) mode.textContent = st.mode === "tv" ? "Switch to Desktop" : "Switch to TV";
  if (!now) return;
  if (st.nowPlaying) {
    now.classList.remove("hidden");
    now.textContent = `Now playing: ${st.nowPlaying.title}`;
  } else now.classList.add("hidden");
}

function start() {
  const token = getToken();
  if (!token) return renderPairing();
  renderRemote();
  conn?.close();
  conn = new RemoteConnection(token, setState, setStatus);
  conn.connect();
  setInterval(() => {
    const lat = document.getElementById("lat");
    if (lat && conn?.latencyMs != null) lat.textContent = `${conn.latencyMs} ms`;
  }, 1000);
}

document.addEventListener("visibilitychange", () => {
  // iOS suspends sockets in the background; reconnect promptly on return.
  if (document.visibilityState === "visible" && getToken()) start();
});

start();
