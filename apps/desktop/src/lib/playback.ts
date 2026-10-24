import type { EpisodeReference, MediaItem, PlaybackSource } from "@monitoros/contracts";
import { PlaybackRouteError, planPlayback, resumePosition, type DeviceCapabilities } from "@monitoros/player";
import { rankSources, type RankedSource } from "@monitoros/provider-sdk";
import { appInfo, isTauri, playNative } from "./bridge";
import { registry } from "./catalog";
import { useApp } from "../store/app";

let capsPromise: Promise<DeviceCapabilities> | null = null;

export function deviceCaps(): Promise<DeviceCapabilities> {
  capsPromise ??= (async () => {
    const info = await appInfo();
    const v = document.createElement("video");
    const can = (t: string) => v.canPlayType(t) !== "" || (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(t));
    return {
      mpvAvailable: isTauri && !!info.mpvPath,
      html5Codecs: {
        h264: can('video/mp4; codecs="avc1.64001F"'),
        hevc: can('video/mp4; codecs="hvc1.1.6.L93.B0"'),
        av1: can('video/mp4; codecs="av01.0.05M.08"'),
        vp9: can('video/webm; codecs="vp9"'),
      },
      hlsNative: v.canPlayType("application/vnd.apple.mpegurl") !== "",
    };
  })();
  return capsPromise;
}

export async function findSources(item: MediaItem, episode?: EpisodeReference): Promise<{ ranked: RankedSource[]; errors: string[] }> {
  const { settings } = useApp.getState();
  const res = await registry.streams(item, episode);
  const ranked = rankSources(res.value, {
    subscriptions: settings.subscriptions,
    preferFree: settings.preferFree,
    region: settings.region,
    languages: settings.languages,
    maxQuality: settings.maxQuality,
    hevcSupported: (await deviceCaps()).mpvAvailable || (await deviceCaps()).html5Codecs.hevc,
    allowUnverified: settings.allowUnverified,
  });
  return { ranked, errors: res.errors.map((e) => `${e.providerId}: ${e.message}`) };
}

export async function startPlayback(item: MediaItem, source: PlaybackSource, episode?: EpisodeReference): Promise<void> {
  const app = useApp.getState();
  const prev = app.progress.find((p) => p.mediaId === item.id);
  const startSec = resumePosition(prev);
  try {
    const plan = planPlayback(source, await deviceCaps());
    if (plan.route === "browser" || plan.route === "app") {
      await app.launchService(plan.url, item.title);
      return;
    }
    if (plan.route === "mpv") {
      await playNative({
        url: plan.url,
        title: item.title,
        startSec,
        subtitleUrls: source.subtitles?.map((s) => s.url),
        audioDevice: app.settings.audioDevice ?? undefined,
        localPath: source.kind === "local-file",
      });
    }
    app.play({ item, source, route: plan.route, startSec, episode });
  } catch (e) {
    const msg = e instanceof PlaybackRouteError ? e.message : `Playback failed: ${(e as Error)?.message ?? String(e)}`;
    app.toast(msg, "error");
  }
}
