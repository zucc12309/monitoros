/**
 * Geometry for the right-thumb buttons of the phone controller.
 *
 * Gas (A) is the biggest button and sits where the right thumb rests, in
 * the lower-right corner. Drift (B), Item and Trick fan out around it in an
 * arc the thumb reaches by rolling, not stretching. Hit areas reach a bit
 * past each circle, and Gas and Drift overlap only along their seam, so a
 * thumb on the seam presses both (drifting while accelerating). Item and
 * Trick are kept clear of Gas so resting on Gas never fires them.
 */
import { PAD_BUTTONS } from "@monitoros/contracts";

export type PadKey = "gas" | "drift" | "item" | "trick";

export interface PadButton {
  key: PadKey;
  bit: number;
  x: number;
  y: number;
  r: number;
}

/** Extra reach beyond each drawn circle, as a fraction of its radius. */
export const HIT_SLOP = 0.15;

export const PAD_BITS: Record<PadKey, number> = {
  gas: PAD_BUTTONS.cross, // Wii Remote A
  drift: PAD_BUTTONS.circle, // Wii Remote B
  item: PAD_BUTTONS.r1, // Nunchuk Z
  trick: PAD_BUTTONS.r2, // Wii Remote shake (tricks, wheelies)
};

/** Places the buttons inside a right-hand zone of `w` × `h` CSS pixels. */
export function layoutPad(w: number, h: number): PadButton[] {
  // Smallest button (Trick, 0.66 R) must still be a 44 pt touch target.
  const R = Math.max(34, Math.min(h * 0.19, w * 0.17, 66));
  const margin = Math.max(10, R * 0.2);
  const ax = w - R - margin;
  const ay = h - R - margin;
  const at = (key: PadKey, dx: number, dy: number, scale: number): PadButton => ({ key, bit: PAD_BITS[key], x: ax + dx * R, y: ay + dy * R, r: scale * R });
  const buttons = [
    at("gas", 0, 0, 1),
    at("drift", -2.05, 0.2, 0.85),
    at("item", -1.75, -2.25, 0.72),
    at("trick", -0.15, -2.45, 0.66),
  ];
  // Keep everything on screen even in a short zone (e.g. portrait halves).
  for (const b of buttons) {
    b.x = Math.min(w - b.r - 4, Math.max(b.r + 4, b.x));
    b.y = Math.min(h - b.r - 4, Math.max(b.r + 4, b.y));
  }
  return buttons;
}

/** Bits pressed by a finger at (x, y); the Gas/Drift seam presses both. */
export function hitPad(buttons: PadButton[], x: number, y: number): number {
  let bits = 0;
  for (const b of buttons) {
    if (Math.hypot(x - b.x, y - b.y) <= b.r * (1 + HIT_SLOP)) bits |= b.bit;
  }
  return bits;
}

/** Floating stick: offset from where the thumb landed, scaled to -1..1
 * (+y up), with a small dead zone so a resting thumb doesn't drift. */
export const STICK_RADIUS = 56;
export const DEAD_ZONE = 0.12;

export function stickValue(dx: number, dy: number, radius = STICK_RADIUS): { x: number; y: number } {
  let x = dx / radius;
  let y = -dy / radius;
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  if (len < DEAD_ZONE) return { x: 0, y: 0 };
  // Rescale so full deflection still reaches 1 after the dead zone.
  const k = (Math.min(len, 1) - DEAD_ZONE) / (1 - DEAD_ZONE) / Math.min(len, 1);
  return { x: x * k, y: y * k };
}
