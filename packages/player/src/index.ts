/**
 * Player routing + session logic (spec §10).
 *
 *   source → validate → compatibility check → route → session → progress
 *
 * Routes:
 *  - "mpv":       native libmpv/mpv process (Tauri build, mpv installed)
 *  - "html5":     in-app <video>/hls.js (browser preview or mpv missing)
 *  - "browser":   hand off to the system browser (DRM services, YouTube)
 *  - "app":       hand off to an installed provider app
 */
import type { EpisodeReference, PlaybackSource, WatchProgress } from "@monitoros/contracts";
import { assertSafeUrl } from "@monitoros/provider-sdk";

export type PlayerRoute = "mpv" | "html5" | "browser" | "app";

export interface DeviceCapabilities {
  mpvAvailable: boolean;
  /** Codecs the WebView's <video> can decode (from MediaSource.isTypeSupported probes). */
  html5Codecs: { h264: boolean; hevc: boolean; av1: boolean; vp9: boolean };
  hlsNative: boolean; // Safari/WKWebView play HLS natively
}

export interface RoutePlan {
  route: PlayerRoute;
  url: string;
  reason: string;
}

export class PlaybackRouteError extends Error {
  override name = "PlaybackRouteError";
}

export function planPlayback(source: PlaybackSource, caps: DeviceCapabilities): RoutePlan {
  if (source.kind === "external-app") return { route: "app", url: source.url, reason: "provider app hand-off" };
  if (source.drm || source.kind === "external-browser") {
    return { route: "browser", url: assertSafeUrl(source.url, "external").toString(), reason: source.drm ? "DRM content plays in the provider's official player" : "provider web player" };
  }
  if (source.kind === "local-file") {
    if (!caps.mpvAvailable) throw new PlaybackRouteError("Local files need mpv. Install it from Settings › Diagnostics.");
    return { route: "mpv", url: source.url, reason: "local file" };
  }

  const url = assertSafeUrl(source.url, "stream", {
    allowHttp: source.provenance === "user-provided",
    allowPrivateNetwork: source.provenance === "user-provided",
  }).toString();

  if (caps.mpvAvailable) return { route: "mpv", url, reason: "native player (hardware decoding)" };

  const codec = source.codec ?? "unknown";
  if (codec !== "unknown" && codec in caps.html5Codecs && !caps.html5Codecs[codec as keyof DeviceCapabilities["html5Codecs"]]) {
    throw new PlaybackRouteError(`This device's web player can't decode ${codec.toUpperCase()}. Install mpv for native playback.`);
  }
  if (source.kind === "dash") throw new PlaybackRouteError("DASH streams need mpv.");
  return { route: "html5", url, reason: source.kind === "hls" && !caps.hlsNative ? "in-app player (hls.js)" : "in-app player" };
}

// ---------- session state machine ----------

export type PlayerState =
  | { status: "idle" }
  | { status: "loading"; sourceId: string }
  | { status: "playing" | "paused" | "buffering"; sourceId: string; positionSec: number; durationSec: number }
  | { status: "ended"; sourceId: string }
  | { status: "error"; sourceId?: string; message: string; retryable: boolean };

export type PlayerEvent =
  | { type: "load"; sourceId: string }
  | { type: "ready"; durationSec: number; startAt?: number }
  | { type: "time"; positionSec: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "buffering" }
  | { type: "ended" }
  | { type: "error"; message: string; retryable?: boolean }
  | { type: "stop" };

export function reducePlayer(state: PlayerState, ev: PlayerEvent): PlayerState {
  switch (ev.type) {
    case "load":
      return { status: "loading", sourceId: ev.sourceId };
    case "stop":
      return { status: "idle" };
    case "error":
      return { status: "error", sourceId: "sourceId" in state ? state.sourceId : undefined, message: ev.message, retryable: ev.retryable ?? true };
  }
  if (!("sourceId" in state) || state.status === "error") return state;
  const sourceId = state.sourceId;
  const pos = "positionSec" in state ? state.positionSec : 0;
  const dur = "durationSec" in state ? state.durationSec : 0;
  switch (ev.type) {
    case "ready":
      return { status: "playing", sourceId, positionSec: ev.startAt ?? 0, durationSec: ev.durationSec };
    case "time":
      return state.status === "loading" || state.status === "ended" ? state : { ...state, status: state.status === "buffering" ? "playing" : state.status, sourceId, positionSec: ev.positionSec, durationSec: dur } as PlayerState;
    case "pause":
      return state.status === "playing" || state.status === "buffering" ? { status: "paused", sourceId, positionSec: pos, durationSec: dur } : state;
    case "resume":
      return state.status === "paused" ? { status: "playing", sourceId, positionSec: pos, durationSec: dur } : state;
    case "buffering":
      return state.status === "playing" ? { status: "buffering", sourceId, positionSec: pos, durationSec: dur } : state;
    case "ended":
      return { status: "ended", sourceId };
  }
  return state;
}

// ---------- resume / progress ----------

/** Don't offer resume for the first 30s, and treat the last 5% (min 60s) as finished. */
export function resumePosition(p: WatchProgress | undefined): number {
  if (!p || p.durationSec <= 0) return 0;
  if (p.positionSec < 30) return 0;
  if (isFinished(p)) return 0;
  return Math.max(0, p.positionSec - 5);
}

export function isFinished(p: WatchProgress): boolean {
  const tail = Math.max(60, p.durationSec * 0.05);
  return p.durationSec > 0 && p.positionSec >= p.durationSec - tail;
}

export function progressFraction(p: WatchProgress): number {
  return p.durationSec > 0 ? Math.min(1, Math.max(0, p.positionSec / p.durationSec)) : 0;
}

export function remainingLabel(p: WatchProgress): string {
  const left = Math.max(0, Math.round((p.durationSec - p.positionSec) / 60));
  return left >= 60 ? `${Math.floor(left / 60)}h ${left % 60}m left` : `${left}m left`;
}

/** Throttle progress writes: every 10s of playback or on pause/stop. */
export function shouldPersist(lastSavedSec: number, nowSec: number, force: boolean): boolean {
  return force || Math.abs(nowSec - lastSavedSec) >= 10;
}

export interface EpisodeList {
  season: number;
  episode: number;
}

/** Next episode for autoplay; crosses season boundaries. */
export function nextEpisode(current: EpisodeReference, all: EpisodeList[]): EpisodeReference | undefined {
  const sorted = [...all].sort((a, b) => a.season - b.season || a.episode - b.episode);
  const idx = sorted.findIndex((e) => e.season === current.season && e.episode === current.episode);
  const next = idx >= 0 ? sorted[idx + 1] : undefined;
  return next ? { season: next.season, episode: next.episode } : undefined;
}
