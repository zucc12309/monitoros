import { describe, expect, it } from "vitest";
import type { PlaybackSource } from "@monitoros/contracts";
import { isFinished, nextEpisode, planPlayback, reducePlayer, remainingLabel, resumePosition, shouldPersist, type DeviceCapabilities, type PlayerState } from "./index";

const caps: DeviceCapabilities = { mpvAvailable: false, html5Codecs: { h264: true, hevc: false, av1: false, vp9: true }, hlsNative: true };
const src = (over: Partial<PlaybackSource>): PlaybackSource => ({
  id: "s",
  providerId: "p",
  kind: "direct",
  url: "https://archive.org/download/x/x.mp4",
  title: "",
  access: "free",
  provenance: "public-domain",
  drm: false,
  ...over,
});

describe("planPlayback", () => {
  it("sends DRM content to the official browser player", () => {
    expect(planPlayback(src({ drm: true, url: "https://www.netflix.com/title/1" }), { ...caps, mpvAvailable: true }).route).toBe("browser");
  });

  it("prefers mpv when available", () => {
    expect(planPlayback(src({}), { ...caps, mpvAvailable: true }).route).toBe("mpv");
  });

  it("falls back to html5 and checks codecs", () => {
    expect(planPlayback(src({ codec: "h264" }), caps).route).toBe("html5");
    expect(() => planPlayback(src({ codec: "hevc" }), caps)).toThrow(/HEVC/);
    expect(() => planPlayback(src({ kind: "dash" }), caps)).toThrow(/DASH/);
  });

  it("requires mpv for local files", () => {
    expect(() => planPlayback(src({ kind: "local-file", url: "/Movies/a.mkv", provenance: "user-provided" }), caps)).toThrow(/mpv/);
  });

  it("rejects unsafe stream URLs unless user-provided", () => {
    expect(() => planPlayback(src({ url: "http://192.168.1.5/x.mp4" }), caps)).toThrow();
    expect(planPlayback(src({ url: "http://192.168.1.5/x.mp4", provenance: "user-provided" }), caps).route).toBe("html5");
  });
});

describe("player state machine", () => {
  it("runs a normal session", () => {
    let s: PlayerState = { status: "idle" };
    s = reducePlayer(s, { type: "load", sourceId: "a" });
    s = reducePlayer(s, { type: "ready", durationSec: 100, startAt: 30 });
    expect(s).toMatchObject({ status: "playing", positionSec: 30 });
    s = reducePlayer(s, { type: "buffering" });
    expect(s.status).toBe("buffering");
    s = reducePlayer(s, { type: "time", positionSec: 31 });
    expect(s.status).toBe("playing");
    s = reducePlayer(s, { type: "pause" });
    s = reducePlayer(s, { type: "time", positionSec: 31 });
    expect(s.status).toBe("paused");
    s = reducePlayer(s, { type: "resume" });
    s = reducePlayer(s, { type: "ended" });
    expect(s.status).toBe("ended");
  });

  it("captures errors and ignores events after them", () => {
    let s: PlayerState = reducePlayer({ status: "idle" }, { type: "load", sourceId: "a" });
    s = reducePlayer(s, { type: "error", message: "403" });
    expect(s).toMatchObject({ status: "error", sourceId: "a", retryable: true });
    expect(reducePlayer(s, { type: "time", positionSec: 5 })).toBe(s);
  });
});

describe("progress", () => {
  const p = (pos: number, dur = 3600) => ({ mediaId: "m", positionSec: pos, durationSec: dur, updatedAt: 0 });
  it("resumes sensibly", () => {
    expect(resumePosition(undefined)).toBe(0);
    expect(resumePosition(p(10))).toBe(0);
    expect(resumePosition(p(1200))).toBe(1195);
    expect(resumePosition(p(3550))).toBe(0);
    expect(isFinished(p(3550))).toBe(true);
  });

  it("formats remaining time like the home screen", () => {
    expect(remainingLabel(p(7200 - 72 * 60, 7200))).toBe("1h 12m left");
    expect(remainingLabel(p(0, 22 * 60))).toBe("22m left");
  });

  it("throttles writes", () => {
    expect(shouldPersist(0, 5, false)).toBe(false);
    expect(shouldPersist(0, 10, false)).toBe(true);
    expect(shouldPersist(0, 1, true)).toBe(true);
  });

  it("finds the next episode across seasons", () => {
    const eps = [{ season: 1, episode: 1 }, { season: 1, episode: 2 }, { season: 2, episode: 1 }];
    expect(nextEpisode({ season: 1, episode: 2 }, eps)).toEqual({ season: 2, episode: 1 });
    expect(nextEpisode({ season: 2, episode: 1 }, eps)).toBeUndefined();
  });
});
