import { describe, expect, it } from "vitest";
import { HIT_SLOP, PAD_BITS, hitPad, layoutPad, stickValue, type PadButton, type PadKey } from "./pad-layout";

/** Right-hand zone sizes on real phones held sideways, plus portrait halves. */
const ZONES: [string, number, number][] = [
  ["iPhone SE landscape", 300, 270],
  ["iPhone 15 landscape", 370, 300],
  ["iPhone 15 Pro Max landscape", 410, 340],
  ["iPhone 15 portrait half", 190, 560],
];

const get = (l: PadButton[], k: PadKey) => l.find((b) => b.key === k)!;
/** Space between the hit areas of two buttons (negative = they overlap). */
const gap = (a: PadButton, b: PadButton) => Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r) * (1 + HIT_SLOP);

describe.each(ZONES)("pad layout: %s", (_name, w, h) => {
  const l = layoutPad(w, h);

  it("keeps every button on screen and big enough to hit", () => {
    for (const b of l) {
      expect(b.x - b.r).toBeGreaterThanOrEqual(0);
      expect(b.y - b.r).toBeGreaterThanOrEqual(0);
      expect(b.x + b.r).toBeLessThanOrEqual(w);
      expect(b.y + b.r).toBeLessThanOrEqual(h);
      expect(2 * b.r).toBeGreaterThanOrEqual(44); // Apple's minimum touch target
    }
  });

  it("makes Gas the biggest and puts it rightmost and low, under the resting thumb", () => {
    const gas = get(l, "gas");
    for (const b of l) {
      expect(gas.r).toBeGreaterThanOrEqual(b.r);
      expect(gas.x).toBeGreaterThanOrEqual(b.x - 1);
    }
    // Drift sits slightly lower on the thumb's arc; Item and Trick are above.
    expect(gas.y).toBeGreaterThan(get(l, "item").y);
    expect(gas.y).toBeGreaterThan(get(l, "trick").y);
  });

  it("lets one thumb on the Gas/Drift seam press both", () => {
    const gas = get(l, "gas");
    const drift = get(l, "drift");
    expect(gap(gas, drift)).toBeLessThan(0);
    // The point on the line between them, just inside both hit areas.
    const t = (gas.r * (1 + HIT_SLOP) - 2) / Math.hypot(gas.x - drift.x, gas.y - drift.y);
    const seam = hitPad(l, gas.x + (drift.x - gas.x) * t, gas.y + (drift.y - gas.y) * t);
    expect(seam).toBe(PAD_BITS.gas | PAD_BITS.drift);
  });

  it("never presses Item or Trick from anywhere on Gas", () => {
    const gas = get(l, "gas");
    expect(gap(gas, get(l, "item"))).toBeGreaterThan(8);
    for (let a = 0; a < 360; a += 5) {
      const rad = (a * Math.PI) / 180;
      for (const f of [0, 0.5, 1]) {
        const bits = hitPad(l, gas.x + Math.cos(rad) * gas.r * f, gas.y + Math.sin(rad) * gas.r * f);
        expect(bits & PAD_BITS.item).toBe(0);
      }
    }
  });

  it("keeps Item and Trick apart", () => {
    expect(gap(get(l, "item"), get(l, "trick"))).toBeGreaterThan(0);
  });
});

describe("stick", () => {
  it("ignores a resting thumb and reaches full deflection", () => {
    expect(stickValue(3, -3)).toEqual({ x: 0, y: 0 });
    expect(stickValue(56, 0).x).toBeCloseTo(1);
    expect(stickValue(0, -80).y).toBeCloseTo(1); // screen up = stick up
    const diag = stickValue(100, 100);
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(1);
  });
});
