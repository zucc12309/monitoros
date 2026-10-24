import { useEffect, useRef, useState } from "react";
import type { MediaItem, MediaType } from "@monitoros/contracts";
import { Cinemeta, InternetArchiveProvider, SEED, seedToItem, filterAndRank, queryVariants, CATALOG_TTL, type CatalogQuery } from "@monitoros/metadata";
import { ProviderRegistry, StremioAddonProvider, mergeResults, type AddonInstallation } from "@monitoros/provider-sdk";
import { fetchJson, loadState, saveState } from "./bridge";

export const cinemeta = new Cinemeta(fetchJson, {
  load: () => loadState("catalog-cache", null),
  save: (value) => saveState("catalog-cache", value),
});
export const internetArchive = new InternetArchiveProvider(fetchJson);
export const registry = new ProviderRegistry(10_000);
registry.register(internetArchive);

let addonsLoaded = false;
export async function loadAddons(): Promise<AddonInstallation[]> {
  const installs = await loadState<AddonInstallation[]>("addons", []);
  if (!addonsLoaded) {
    for (const inst of installs) {
      try {
        registry.register(new StremioAddonProvider(inst, fetchJson), inst.enabled);
      } catch {
        /* already registered */
      }
    }
    addonsLoaded = true;
  }
  return installs;
}

export async function saveAddons(installs: AddonInstallation[]) {
  await saveState("addons", installs);
}

/** Only use live feeds whose meaning matches the row; regional/anime picks stay curated. */
function rowQueries(tag: string | undefined): CatalogQuery[] {
  switch (tag) {
    case "hero":
    case "trending": return [{ type: "movie" }];
    case "trending-tv": return [{ type: "series" }];
    case "recent": return ["movie", "series"].map(type => ({ type: type as "movie" | "series", catalog: "year", year: new Date().getFullYear() }));
    default: return [];
  }
}

export function useTagItems(tag: string | undefined, limit = 20): MediaItem[] {
  const [items, setItems] = useState<MediaItem[]>(() => SEED.filter(s => tag && s.tags.includes(tag)).slice(0, limit).map(seedToItem));
  useEffect(() => {
    let alive = true;
    let busy = false;
    const seeds = SEED.filter(s => tag && s.tags.includes(tag)).slice(0, limit);
    setItems(seeds.map(seedToItem));
    const update = async () => {
      if (busy) return;
      busy = true;
      try {
        const queries = rowQueries(tag);
        if (!queries.length) {
          const enriched = await Promise.all(seeds.map(e => cinemeta.enrich(e)));
          if (alive) setItems(enriched);
          return;
        }
        const combine = (pages: { items: MediaItem[] }[]) => {
          // Interleave new movies and shows so neither disappears behind the other.
          const result: MediaItem[] = [];
          for (let i = 0; i < Math.max(0, ...pages.map(p => p.items.length)); i++) {
            for (const p of pages) if (p.items[i]) result.push(p.items[i]!);
          }
          return mergeResults(result).slice(0, limit);
        };
        const cached = await Promise.all(queries.map(q => cinemeta.cachedCatalog(q)));
        const warm = combine(cached.filter((p): p is NonNullable<typeof p> => !!p));
        if (alive && warm.length) setItems(warm);
        const results = await Promise.allSettled(queries.map(q => cinemeta.catalog(q)));
        const live = combine(results.flatMap(r => r.status === "fulfilled" ? [r.value] : []));
        if (alive && live.length) setItems(live);
        else if (!warm.length) {
          const fallback = await Promise.all(seeds.map(e => cinemeta.enrich(e)));
          if (alive) setItems(fallback);
        }
      } finally { busy = false; }
    };
    void update();
    const timer = window.setInterval(() => { if (!document.hidden) void update(); }, CATALOG_TTL);
    const visible = () => { if (!document.hidden) void update(); };
    window.addEventListener("online", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("online", visible); document.removeEventListener("visibilitychange", visible); };
  }, [tag, limit]);
  return items;
}

/** Paged browsing, with stale cache shown immediately and request races isolated per kind. */
export function useTypeItems(kind: MediaType) {
  const [state, setState] = useState({ items: [] as MediaItem[], loading: true, hasMore: true, error: null as string | null });
  const next = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let busy = false;
    let offset: number | null = 0;
    let current: MediaItem[] = [];
    const fallback = SEED.filter(s => s.type === kind).map(seedToItem);
    setState({ items: fallback, loading: true, hasMore: kind !== "anime", error: null });
    const load = async (replace: boolean) => {
      if (busy || !replace && offset === null) return;
      busy = true;
      if (alive) setState(s => ({ ...s, loading: true, error: null }));
      try {
        if (kind === "anime") {
          const items = await Promise.all(SEED.filter(s => s.type === kind).map(s => cinemeta.enrich(s)));
          if (alive) setState({ items, loading: false, hasMore: false, error: null });
          return;
        }
        const query: CatalogQuery = { type: kind === "movie" ? "movie" : "series", skip: replace ? 0 : offset! };
        if (replace) {
          const cached = await cinemeta.cachedCatalog(query);
          if (alive && cached?.items.length && !current.length) setState(s => ({ ...s, items: cached.items }));
        }
        const page = await cinemeta.catalog(query);
        if (!alive) return;
        const added = page.items.filter(i => !current.some(old => old.id === i.id));
        offset = !replace && !added.length ? null : page.nextSkip;
        current = replace ? page.items : [...current, ...added];
        setState({ items: current, loading: false, hasMore: offset !== null, error: page.stale ? "Offline or catalog unavailable — showing saved titles." : null });
      } catch {
        if (alive) setState(s => ({ ...s, loading: false, error: "Couldn't update the catalog. Check your connection and try again." }));
      } finally { busy = false; }
    };
    next.current = () => { void load(!current.length); };
    const refresh = async () => {
      if (document.hidden || kind === "anime") return;
      const page = await cinemeta.cachedCatalog({ type: kind === "movie" ? "movie" : "series" });
      if (alive && (!page || page.stale)) void load(true);
    };
    void load(true);
    const timer = window.setInterval(() => void refresh(), CATALOG_TTL);
    const visible = () => { void refresh(); };
    window.addEventListener("online", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("online", visible); document.removeEventListener("visibilitychange", visible); };
  }, [kind]);
  return { ...state, loadMore: () => next.current() };
}

export function useFreeItems(): { items: MediaItem[]; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ items: MediaItem[]; loading: boolean; error: string | null }>({ items: [], loading: true, error: null });
  useEffect(() => {
    let alive = true;
    internetArchive
      .catalog({ catalogId: "feature_films", type: "movie" })
      .then((items) => alive && setState({ items, loading: false, error: null }))
      .catch((e: Error) => alive && setState({ items: [], loading: false, error: e.message }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

export interface SearchOutcome {
  items: MediaItem[];
  errors: string[];
}

export async function searchAll(query: string, freeOnly: boolean): Promise<SearchOutcome> {
  const local = filterAndRank(SEED.map(seedToItem), query);
  // Also search a common spelling variant ("big boss" → "bigg boss").
  const metaQueries = [query, ...queryVariants(query)].map((q) => cinemeta.search(q).catch(() => [] as MediaItem[]));
  const [metaPages, providers] = await Promise.all([Promise.all(metaQueries), registry.search(query)]);
  const meta = metaPages.flat();
  const merged = mergeResults([...local, ...meta, ...providers.value]);
  const ranked = filterAndRank(merged, query, { freeOnly });
  return { items: ranked.length ? ranked : freeOnly ? [] : merged, errors: providers.errors.map((e) => `${e.providerId}: ${e.message}`) };
}
