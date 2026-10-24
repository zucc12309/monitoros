/**
 * Cinemeta (Stremio's official metadata add-on) as the default metadata
 * source. Read-only, no API key, CORS-enabled.
 */
import type { MediaItem } from "@monitoros/contracts";
import { canonicalId } from "@monitoros/contracts";
import { metaToMediaItem, paletteFor, type JsonFetcher, type StremioMeta } from "@monitoros/provider-sdk";
import type { SeedEntry } from "./seed";
import { CatalogCache, type CatalogStorage, type CatalogPage } from "./catalog-cache";

export interface CatalogQuery { type: "movie" | "series"; catalog?: "top" | "year"; year?: number; skip?: number }
// Direct destination advertised by Cinemeta; keep the guarded fetcher redirect-free.
export const CINEMETA_CATALOG_BASE = "https://cinemeta-catalogs.strem.io";
const PAGE_SIZE = 50;

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

  private pages: CatalogCache;
  constructor(private readonly fetchJson: JsonFetcher, storage?: CatalogStorage) {
    this.pages = new CatalogCache(storage);
  }

  private catalogUrl(q: CatalogQuery): string {
    const catalog = q.catalog ?? "top";
    const skip = q.skip ?? 0;
    if (!Number.isSafeInteger(skip) || skip < 0) throw new Error("Invalid catalog offset");
    const extra: string[] = [];
    if (catalog === "year") {
      const year = q.year ?? new Date().getFullYear();
      if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear() + 1) throw new Error("Invalid catalog year");
      extra.push(`genre=${year}`);
    }
    if (skip) extra.push(`skip=${skip}`);
    return `${CINEMETA_CATALOG_BASE}/${catalog}/catalog/${q.type}/${catalog}${extra.length ? "/" + extra.join("&") : ""}.json`;
  }

  cachedCatalog(q: CatalogQuery): Promise<CatalogPage | undefined> {
    return this.pages.peek(this.catalogUrl(q));
  }

  catalog(q: CatalogQuery): Promise<CatalogPage> {
    const url = this.catalogUrl(q);
    return this.pages.get(url, async () => {
      const data = await this.fetchJson(url, "addon", TIMEOUT) as { metas?: unknown[] } | null;
      if (!data || !Array.isArray(data.metas)) throw new Error("Invalid Cinemeta catalog response");
      const items: MediaItem[] = [];
      for (const raw of data.metas.slice(0, 100)) {
        try {
          const m = raw as StremioMeta;
          if (!m || typeof m.id !== "string" || typeof m.name !== "string" || !m.name || m.type !== q.type) continue;
          const item = metaToMediaItem(m, "cinemeta");
          if (!Array.isArray(item.genres) || !Array.isArray(item.languages)) continue;
          // Episode lists are loaded on the detail page, not duplicated in every catalog cache page.
          item.episodes = undefined;
          if (!items.some(i => i.id === item.id)) items.push(item);
        } catch { /* Skip malformed provider entries, not the whole page. */ }
      }
      if (data.metas.length && !items.length) throw new Error("Cinemeta returned no valid titles");
      // Cinemeta can omit entries within a 50-slot page. Only an empty page ends pagination.
      return { items, nextSkip: data.metas.length ? (q.skip ?? 0) + PAGE_SIZE : null };
    });
  }

  async details(item: MediaItem): Promise<MediaItem> {
    if (!item.ids.imdb) return item;
    const type = item.type === "movie" ? "movie" : "series";
    const data = await this.fetchJson(`${CINEMETA_BASE}/meta/${type}/${item.ids.imdb}.json`, "addon", TIMEOUT) as { meta?: StremioMeta };
    if (!data.meta?.id || !data.meta.name) return item;
    return { ...metaToMediaItem(data.meta, "cinemeta"), type: item.type, tags: item.tags, availability: item.availability };
  }

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
