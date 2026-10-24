/**
 * Remote-control protocol. Mirrors crates/monitoros-core/src/remote.rs —
 * the Rust side is authoritative; this validator exists so the PWA and the
 * desktop UI reject malformed commands before they hit the wire.
 */

export const NAV_KEYS = ["up", "down", "left", "right", "ok", "back", "home", "search"] as const;
export type NavKey = (typeof NAV_KEYS)[number];

export type RemoteCommand =
  | { type: "nav"; key: NavKey }
  | { type: "media"; action: "play-pause" | "stop" | "next" | "previous" }
  | { type: "seek"; deltaSec: number }
  | { type: "volume"; action: "up" | "down" | "mute" }
  | { type: "text"; value: string }
  | { type: "pointer"; dx: number; dy: number; click?: boolean }
  | { type: "mode"; target: "tv" | "desktop" | "toggle" }
  | { type: "ping" };

export interface RemoteEnvelope {
  /** Monotonic per-session counter; the server drops anything <= the last seen value. */
  seq: number;
  sentAt: number;
  command: RemoteCommand;
}

export interface RemoteAck {
  seq: number;
  ok: boolean;
  error?: string;
}

export interface RemoteStatus {
  mode: "tv" | "desktop";
  nowPlaying?: { title: string; positionSec: number; durationSec: number; paused: boolean };
  volume?: number;
  muted?: boolean;
}

export const MAX_TEXT_LEN = 256;
export const MAX_SEEK_SEC = 3600;
export const MAX_POINTER_DELTA = 500;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function validateCommand(raw: unknown): RemoteCommand {
  if (!isObj(raw) || typeof raw.type !== "string") throw new Error("command must be an object with a type");
  switch (raw.type) {
    case "nav":
      if (!NAV_KEYS.includes(raw.key as NavKey)) throw new Error("invalid nav key");
      return { type: "nav", key: raw.key as NavKey };
    case "media":
      if (!["play-pause", "stop", "next", "previous"].includes(raw.action as string)) throw new Error("invalid media action");
      return { type: "media", action: raw.action as "play-pause" };
    case "seek":
      if (!finite(raw.deltaSec) || Math.abs(raw.deltaSec) > MAX_SEEK_SEC) throw new Error("invalid seek");
      return { type: "seek", deltaSec: raw.deltaSec };
    case "volume":
      if (!["up", "down", "mute"].includes(raw.action as string)) throw new Error("invalid volume action");
      return { type: "volume", action: raw.action as "up" };
    case "text": {
      if (typeof raw.value !== "string" || raw.value.length > MAX_TEXT_LEN) throw new Error("invalid text");
      // Strip control characters; remote text is typed into search fields only.
      const value = raw.value.replace(/[\u0000-\u001f\u007f]/g, "");
      return { type: "text", value };
    }
    case "pointer":
      if (!finite(raw.dx) || !finite(raw.dy) || Math.abs(raw.dx) > MAX_POINTER_DELTA || Math.abs(raw.dy) > MAX_POINTER_DELTA)
        throw new Error("invalid pointer delta");
      return { type: "pointer", dx: raw.dx, dy: raw.dy, click: raw.click === true };
    case "mode":
      if (!["tv", "desktop", "toggle"].includes(raw.target as string)) throw new Error("invalid mode");
      return { type: "mode", target: raw.target as "tv" };
    case "ping":
      return { type: "ping" };
    default:
      throw new Error(`unknown command type: ${String(raw.type).slice(0, 32)}`);
  }
}

export function validateEnvelope(raw: unknown): RemoteEnvelope {
  if (!isObj(raw)) throw new Error("envelope must be an object");
  if (!Number.isSafeInteger(raw.seq) || (raw.seq as number) < 0) throw new Error("invalid seq");
  if (!finite(raw.sentAt)) throw new Error("invalid sentAt");
  return { seq: raw.seq as number, sentAt: raw.sentAt, command: validateCommand(raw.command) };
}
