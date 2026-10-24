/** Parser for user-authorised IPTV playlists (extended M3U). */
import type { MediaItem } from "@monitoros/contracts";
import { isSafeUrl, paletteFor } from "@monitoros/provider-sdk";

export interface Channel {
  id: string;
  name: string;
  group?: string;
  logo?: string;
  url: string;
  language?: string;
  country?: string;
}

const MAX_CHANNELS = 5000;
const attr = (line: string, key: string) => new RegExp(`${key}="([^"]*)"`, "i").exec(line)?.[1];

export function parseM3U(text: string, opts: { allowPrivateNetwork?: boolean } = {}): { channels: Channel[]; skipped: number } {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.trim().startsWith("#EXTM3U")) throw new Error("not an M3U playlist (missing #EXTM3U header)");
  const channels: Channel[] = [];
  let pending: Partial<Channel> | null = null;
  let skipped = 0;
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const name = line.slice(line.lastIndexOf(",") + 1).trim();
      pending = {
        name: name.slice(0, 120) || "Channel",
        group: attr(line, "group-title")?.slice(0, 60),
        logo: attr(line, "tvg-logo"),
        language: attr(line, "tvg-language"),
        country: attr(line, "tvg-country"),
        id: attr(line, "tvg-id"),
      };
    } else if (!line.startsWith("#") && pending) {
      const urlOk = isSafeUrl(line, "stream", { allowHttp: !!opts.allowPrivateNetwork, allowPrivateNetwork: !!opts.allowPrivateNetwork });
      if (urlOk && channels.length < MAX_CHANNELS) {
        channels.push({
          ...pending,
          id: pending.id || `ch-${channels.length}`,
          name: pending.name!,
          url: line,
          logo: pending.logo && isSafeUrl(pending.logo, "artwork") ? pending.logo : undefined,
        });
      } else skipped++;
      pending = null;
    }
  }
  return { channels, skipped };
}

export function channelToItem(c: Channel, playlistId: string): MediaItem {
  return {
    id: `iptv:${playlistId}:${c.id}`,
    ids: { provider: { [`iptv:${playlistId}`]: c.id } },
    type: "live",
    title: c.name,
    genres: c.group ? [c.group] : [],
    languages: c.language ? [c.language] : [],
    artwork: { logo: c.logo, palette: paletteFor(c.name) },
    availability: [{ providerId: `iptv:${playlistId}`, access: "unknown", source: "user", deepLink: c.url }],
    tags: ["live"],
  };
}
