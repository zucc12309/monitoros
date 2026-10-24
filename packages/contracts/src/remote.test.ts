import { describe, expect, it } from "vitest";
import { validateCommand, validateEnvelope } from "./remote";

describe("remote command validation", () => {
  it("accepts valid commands", () => {
    expect(validateCommand({ type: "nav", key: "up" })).toEqual({ type: "nav", key: "up" });
    expect(validateCommand({ type: "seek", deltaSec: -10 })).toEqual({ type: "seek", deltaSec: -10 });
    expect(validateCommand({ type: "mode", target: "toggle" })).toEqual({ type: "mode", target: "toggle" });
    expect(validateCommand({ type: "fullscreen", extra: 1 })).toEqual({ type: "fullscreen" });
  });

  it("accepts scroll and range-checks it", () => {
    expect(validateCommand({ type: "scroll", dx: 0, dy: -30 })).toEqual({ type: "scroll", dx: 0, dy: -30 });
    expect(() => validateCommand({ type: "scroll", dx: 0, dy: 1e9 })).toThrow();
  });

  it("rejects unknown types and bad values", () => {
    expect(() => validateCommand({ type: "exec", cmd: "rm -rf /" })).toThrow(/unknown command/);
    expect(() => validateCommand({ type: "nav", key: "sideways" })).toThrow();
    expect(() => validateCommand({ type: "seek", deltaSec: Infinity })).toThrow();
    expect(() => validateCommand({ type: "seek", deltaSec: 99999 })).toThrow();
    expect(() => validateCommand({ type: "text", value: "x".repeat(300) })).toThrow();
    expect(() => validateCommand(null)).toThrow();
    expect(() => validateCommand([])).toThrow();
  });

  it("strips control characters from text", () => {
    expect(validateCommand({ type: "text", value: "dune\u0000\n" })).toEqual({ type: "text", value: "dune" });
  });

  it("drops extra fields so nothing unexpected passes through", () => {
    expect(validateCommand({ type: "volume", action: "up", shell: "x" })).toEqual({ type: "volume", action: "up" });
  });

  it("validates envelopes", () => {
    expect(validateEnvelope({ seq: 1, sentAt: 1, command: { type: "ping" } }).seq).toBe(1);
    expect(() => validateEnvelope({ seq: -1, sentAt: 1, command: { type: "ping" } })).toThrow();
    expect(() => validateEnvelope({ seq: 1.5, sentAt: 1, command: { type: "ping" } })).toThrow();
  });
});
