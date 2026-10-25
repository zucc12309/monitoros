/**
 * Game controller mode: the phone becomes one player's Wii Remote + Nunchuk.
 *
 * Left thumb: a floating stick that starts wherever the thumb lands.
 * Right thumb: Gas, Drift, Item and Trick in an arc (pad-layout.ts). One
 * finger can slide between them, the Gas/Drift seam presses both, and a
 * quick upward flick does a trick without leaving Gas.
 *
 * Every message is the complete pad state, so a lost message can never
 * leave a button held. The TV decides which player this phone is.
 */
import { PAD_BUTTONS, type GamePlayer, type RemoteCommand } from "@monitoros/contracts";
import { PAD_BITS, STICK_RADIUS, hitPad, layoutPad, stickValue, type PadButton } from "./pad-layout";

export interface ControllerHost {
  send(cmd: RemoteCommand): boolean;
  deviceId(): string | null;
  exit(): void;
}

const SEND_INTERVAL_MS = 33; // ≤30 updates/s (server allows 40/s)
const PLAYER_COLOURS = ["#3b82f6", "#ef4444", "#22c55e", "#eab308"];
/** An upward flick this far, this fast, on the right side is a trick. */
const FLICK_PX = 38;
const FLICK_MS = 220;
const TRICK_PULSE_MS = 160;

let host: ControllerHost | null = null;
/** Discrete buttons (D-pad, Look back, −/Home/+). */
let buttons = 0;
/** Right-thumb pad: bits per finger. */
const padTouches = new Map<number, { bits: number; y0: number; t0: number; flicked: boolean }>();
let trickUntil = 0;
/** Holds Gas for the player during races (menus need real taps, so it's opt-in). */
let autoGas = false;
let stick = { x: 0, y: 0 };
let lastSent = "";
let timer = 0;
let layout: PadButton[] = [];

function padBits() {
  let bits = 0;
  for (const t of padTouches.values()) bits |= t.bits;
  if (performance.now() < trickUntil) bits |= PAD_BITS.trick;
  return bits;
}

function snapshot(): RemoteCommand {
  const r = (v: number) => Math.round(v * 100) / 100;
  return { type: "pad", buttons: buttons | padBits() | (autoGas ? PAD_BITS.gas : 0), lx: r(stick.x), ly: r(stick.y) };
}

/** Send the current state now, or as soon as the rate budget allows. */
function push() {
  paintPad();
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

function setAutoGas(on: boolean) {
  autoGas = on;
  const t = document.getElementById("ctl-auto");
  if (t) {
    t.textContent = `Auto-gas: ${on ? "On" : "Off"}`;
    t.classList.toggle("on", on);
  }
  push();
}

function releaseAll() {
  autoGas = false;
  buttons = 0;
  padTouches.clear();
  trickUntil = 0;
  stick = { x: 0, y: 0 };
  push();
}

export function renderController(root: HTMLElement, h: ControllerHost) {
  host = h;
  buttons = 0;
  padTouches.clear();
  autoGas = false;
  stick = { x: 0, y: 0 };
  lastSent = "";
  root.innerHTML = `
    <section class="ctl" id="ctl">
      <header class="ctl-top">
        <button id="ctl-exit" class="pill">‹ Remote</button>
        <span id="ctl-player" class="ctl-player">Joining…</span>
        <button id="ctl-auto" class="mini toggle">Auto-gas: Off</button>
        <span class="ctl-small">
          <button data-btn="share" class="mini" aria-label="Minus">−</button>
          <button data-btn="ps" class="mini">Home</button>
          <button data-btn="options" class="mini" aria-label="Pause">+ Pause</button>
        </span>
      </header>
      <div class="ctl-body">
        <div id="steer" class="steer-zone" aria-label="Steering: touch and drag anywhere here">
          <div id="base" class="stick"><div id="knob" class="knob"></div></div>
          <span class="zone-hint">Steer: touch anywhere</span>
        </div>
        <div class="ctl-mid">
          <div class="ctl-dpad" aria-label="Menu buttons">
            <button data-btn="up" aria-label="Up">▲</button>
            <button data-btn="left" aria-label="Left">◀</button>
            <button data-btn="right" aria-label="Right">▶</button>
            <button data-btn="down" aria-label="Down">▼</button>
          </div>
          <button data-btn="l1" class="mini look">Look back</button>
        </div>
        <div id="pad" class="pad-zone">
          <div class="pad-btn gas" data-key="gas"><b>A</b><small>Gas</small></div>
          <div class="pad-btn drift" data-key="drift"><b>B</b><small>Drift</small></div>
          <div class="pad-btn item" data-key="item"><b>Item</b></div>
          <div class="pad-btn trick" data-key="trick"><b>Trick</b><small>or flick ↑</small></div>
        </div>
      </div>
      <p class="ctl-hint">Hold sideways · Slide your right thumb between buttons · Gas+Drift together = drift</p>
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

  bindStick(root.querySelector<HTMLElement>("#steer")!, root.querySelector<HTMLElement>("#base")!, root.querySelector<HTMLElement>("#knob")!);
  bindPad(root.querySelector<HTMLElement>("#pad")!);
  root.querySelector<HTMLButtonElement>("#ctl-auto")!.onclick = () => setAutoGas(!autoGas);

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

function bindStick(zone: HTMLElement, base: HTMLElement, knob: HTMLElement) {
  let id: number | null = null;
  let ox = 0, oy = 0;
  zone.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (id !== null) return;
    id = e.pointerId;
    capture(zone, id);
    const r = zone.getBoundingClientRect();
    ox = e.clientX;
    oy = e.clientY;
    zone.classList.add("active");
    // The stick appears under the thumb, so it can't be missed.
    base.style.left = `${ox - r.left}px`;
    base.style.top = `${oy - r.top}px`;
    knob.style.transform = "";
  });
  zone.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return;
    let dx = e.clientX - ox, dy = e.clientY - oy;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) {
      dx *= STICK_RADIUS / len;
      dy *= STICK_RADIUS / len;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    stick = stickValue(dx, dy);
    push();
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null;
    zone.classList.remove("active");
    base.style.left = base.style.top = "";
    knob.style.transform = "";
    stick = { x: 0, y: 0 };
    push();
  };
  zone.addEventListener("pointerup", end);
  zone.addEventListener("pointercancel", end);
  zone.addEventListener("lostpointercapture", end);
}

function bindPad(zone: HTMLElement) {
  const els = new Map([...zone.querySelectorAll<HTMLElement>(".pad-btn")].map((el) => [el.dataset.key!, el]));
  const relayout = () => {
    layout = layoutPad(zone.clientWidth, zone.clientHeight);
    for (const b of layout) {
      const el = els.get(b.key)!;
      Object.assign(el.style, { left: `${b.x - b.r}px`, top: `${b.y - b.r}px`, width: `${2 * b.r}px`, height: `${2 * b.r}px` });
    }
  };
  relayout();
  new ResizeObserver(relayout).observe(zone);

  const at = (e: PointerEvent) => {
    const r = zone.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  zone.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    capture(zone, e.pointerId);
    const p = at(e);
    const bits = hitPad(layout, p.x, p.y);
    padTouches.set(e.pointerId, { bits, y0: p.y, t0: performance.now(), flicked: false });
    if (bits) navigator.vibrate?.(6);
    push();
  });
  zone.addEventListener("pointermove", (e) => {
    const t = padTouches.get(e.pointerId);
    if (!t) return;
    const p = at(e);
    const bits = hitPad(layout, p.x, p.y);
    if (bits !== t.bits && bits) navigator.vibrate?.(4);
    t.bits = bits;
    // A quick upward flick is a trick, so Gas never has to be let go.
    if (!t.flicked && t.y0 - p.y > FLICK_PX && performance.now() - t.t0 < FLICK_MS) {
      t.flicked = true;
      trickUntil = performance.now() + TRICK_PULSE_MS;
      window.setTimeout(push, TRICK_PULSE_MS + 5);
    }
    push();
  });
  const end = (e: PointerEvent) => {
    if (padTouches.delete(e.pointerId)) push();
  };
  zone.addEventListener("pointerup", end);
  zone.addEventListener("pointercancel", end);
  zone.addEventListener("lostpointercapture", end);
}

/** Lights each pad button that's held (by a finger, a flick or Auto-gas). */
function paintPad() {
  const bits = padBits() | (autoGas ? PAD_BITS.gas : 0);
  document.querySelectorAll<HTMLElement>(".pad-btn").forEach((el) => {
    el.classList.toggle("held", !!(bits & PAD_BITS[el.dataset.key as keyof typeof PAD_BITS]));
    if (el.dataset.key === "gas") el.classList.toggle("auto", autoGas);
  });
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
  if (host) {
    releaseAll();
    setAutoGas(false);
  }
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
