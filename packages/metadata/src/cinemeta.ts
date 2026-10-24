/**
 * Cinemeta (Stremio's official metadata add-on) as the default metadata
 * source. Read-only, no API key, CORS-enabled. TMDB can replace it when the
 * user supplies their own token (see tmdb.ts).
 */
import type { MediaItem } from "@monitoros/contracts";
import { canonicalId } from "@monitoros/contracts";
import { metaToMediaItem, paletteFor, type JsonFetcher, type StremioMeta } from "@monitoros/provider-sdk";
import type { SeedEntry } from "./seed";

export const CINEMETA_BASE = "https://v3-cinemeta.strem.io";
const TIMEOUT = 8000;

export function seedToItem(e: SeedEntry): MediaItem {
  const ids = { imdb: e.imdb };
  return {
    id: canonicalId(e.type, ids),
    ids,
    type: e.type,
    title: e.title,
    year: e.year,
    genres: [],
    languages: e.languages,
    artwork: { palette: paletteFor(e.title) },
    availability: [],
    tags: e.tags,
  };
}

export class Cinemeta {
  private cache = new Map<string, Promise<MediaItem>>();

  constructor(private readonly fetchJson: JsonFetcher) {}

  /** Enrich a seed with live metadata; on failure, return the offline seed. */
  enrich(e: SeedEntry): Promise<MediaItem> {
    const key = e.imdb;
    let p = this.cache.get(key);
    if (!p) {
      const base = seedToItem(e);
      const type = e.type === "movie" ? "movie" : "series";
      p = this.fetchJson(`${CINEMETA_BASE}/meta/${type}/${e.imdb}.json`, "addon", TIMEOUT)
        .then((data) => {
          const meta = (data as { meta?: StremioMeta }).meta;
          if (!meta) return base;
          const live = metaToMediaItem(meta, "cinemeta");
          return { ...live, type: e.type, languages: e.languages, tags: e.tags, title: live.title || base.title };
        })
        .catch(() => base);
      this.cache.set(key, p);
    }
    return p;
  }

  async search(query: string): Promise<MediaItem[]> {
    const q = encodeURIComponent(query.trim().slice(0, 100));
    if (!q) return [];
    const settled = await Promise.allSettled(
      ["movie", "series"].map((t) => this.fetchJson(`${CINEMETA_BASE}/catalog/${t}/top/search=${q}.json`, "addon", TIMEOUT)),
    );
    const metas = settled.flatMap((r) => (r.status === "fulfilled" ? ((r.value as { metas?: StremioMeta[] }).metas ?? []) : []));
    return metas.filter((m) => m?.id && m?.name).slice(0, 40).map((m) => metaToMediaItem(m, "cinemeta"));
  }
}
