/**
 * Game controller mode: the phone becomes one player's Wii Remote + Nunchuk.
 * Stick (left thumb) steers, A accelerates, B drifts/brakes, Item uses items.
 *
 * Every message is the complete pad state, so a lost message can never
 * leave a button held. The TV decides which player this phone is.
 */
import { PAD_BUTTONS, type GamePlayer, type RemoteCommand } from "@monitoros/contracts";

export interface ControllerHost {
  send(cmd: RemoteCommand): boolean;
  deviceId(): string | null;
  exit(): void;
}

const SEND_INTERVAL_MS = 33; // ≤30 updates/s (server allows 40/s)
const PLAYER_COLOURS = ["#3b82f6", "#ef4444", "#22c55e", "#eab308"];

let host: ControllerHost | null = null;
let buttons = 0;
let stick = { x: 0, y: 0 };
let lastSent = "";
let timer = 0;

function snapshot(): RemoteCommand {
  const r = (v: number) => Math.round(v * 100) / 100;
  return { type: "pad", buttons, lx: r(stick.x), ly: r(stick.y) };
}

/** Send the current state now, or as soon as the rate budget allows. */
function push() {
  if (timer) return;
  const cmd = snapshot();
  const key = JSON.stringify(cmd);
  if (key === lastSent) return;
  host?.send(cmd);
  lastSent = key;
  timer = window.setTimeout(() => {
    timer = 0;
    push(); // flush anything that changed while waiting
  }, SEND_INTERVAL_MS);
}

function releaseAll() {
  buttons = 0;
  stick = { x: 0, y: 0 };
  push();
}

export function renderController(root: HTMLElement, h: ControllerHost) {
  host = h;
  buttons = 0;
  stick = { x: 0, y: 0 };
  lastSent = "";
  root.innerHTML = `
    <section class="ctl" id="ctl">
      <header class="ctl-top">
        <button id="ctl-exit" class="pill">‹ Remote</button>
        <span id="ctl-player" class="ctl-player">Joining…</span>
        <span class="ctl-small">
          <button data-btn="share" class="mini">−</button>
          <button data-btn="ps" class="mini">Home</button>
          <button data-btn="options" class="mini">+</button>
        </span>
      </header>
      <div class="ctl-body">
        <div id="stick" class="stick" aria-label="Steering stick"><div id="knob" class="knob"></div></div>
        <div class="ctl-dpad">
          <button data-btn="up">▲</button>
          <button data-btn="left">◀</button>
          <button data-btn="right">▶</button>
          <button data-btn="down">▼</button>
        </div>
        <div class="ctl-face">
          <button data-btn="r1" class="face item">Item</button>
          <button data-btn="circle" class="face b">B</button>
          <button data-btn="cross" class="face a">A</button>
        </div>
      </div>
      <p class="ctl-hint">Hold the phone sideways · Stick steers · A go · B drift · Item use</p>
      <p id="ctl-msg" class="ctl-msg"></p>
    </section>`;

  root.querySelectorAll<HTMLButtonElement>("[data-btn]").forEach((b) => {
    const bit = PAD_BUTTONS[b.dataset.btn as keyof typeof PAD_BUTTONS];
    const down = (e: PointerEvent) => {
      e.preventDefault();
      capture(b, e.pointerId);
      b.classList.add("held");
      buttons |= bit;
      navigator.vibrate?.(6);
      push();
    };
    const up = () => {
      b.classList.remove("held");
      buttons &= ~bit;
      push();
    };
    b.addEventListener("pointerdown", down);
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("lostpointercapture", up);
  });

  bindStick(root.querySelector<HTMLElement>("#stick")!, root.querySelector<HTMLElement>("#knob")!);

  root.querySelector<HTMLButtonElement>("#ctl-exit")!.onclick = () => {
    releaseAll();
    host?.send({ type: "game", action: "leave" });
    host = null;
    h.exit();
  };
  join();
}

/** Keep receiving a finger's events after it slides off the control. */
function capture(el: HTMLElement, pointerId: number) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* pointer already gone: its up/cancel event still arrives */
  }
}

function bindStick(area: HTMLElement, knob: HTMLElement) {
  let id: number | null = null;
  let cx = 0, cy = 0, radius = 1;
  const update = (e: PointerEvent) => {
    let dx = (e.clientX - cx) / radius;
    let dy = (e.clientY - cy) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    knob.style.transform = `translate(${dx * radius * 0.6}px, ${dy * radius * 0.6}px)`;
    stick = { x: dx, y: -dy }; // screen y grows down; stick +y = up
    push();
  };
  area.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (id !== null) return;
    id = e.pointerId;
    capture(area, id);
    const r = area.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    radius = r.width / 2;
    update(e);
  });
  area.addEventListener("pointermove", (e) => e.pointerId === id && update(e));
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null;
    knob.style.transform = "";
    stick = { x: 0, y: 0 };
    push();
  };
  area.addEventListener("pointerup", end);
  area.addEventListener("pointercancel", end);
}

/** (Re)claim this phone's player slot, e.g. after a reconnect. */
export function join() {
  if (!host) return;
  lastSent = "";
  host.send({ type: "game", action: "join" });
  push();
}

export function controllerActive() {
  return host !== null;
}

/** Phone going to the background: let go of everything first. */
export function suspend() {
  if (host) releaseAll();
}

export function showPlayers(players: GamePlayer[] | undefined, error?: string) {
  const label = document.getElementById("ctl-player");
  const msg = document.getElementById("ctl-msg");
  const ctl = document.getElementById("ctl");
  if (!label || !players || !host) return;
  const me = players.find((p) => p.deviceId && p.deviceId === host!.deviceId());
  if (me && me.status === "connected") {
    label.textContent = `Player ${me.player + 1}`;
    ctl?.style.setProperty("--player", PLAYER_COLOURS[me.player] ?? "");
  } else {
    label.textContent = players.every((p) => p.status !== "empty") ? "Game full" : "Joining…";
  }
  if (msg) msg.textContent = error ?? "";
}
