import { useEffect, useState } from "react";
import type { MediaItem, MediaType } from "@monitoros/contracts";
import { Cinemeta, InternetArchiveProvider, SEED, seedToItem, filterAndRank } from "@monitoros/metadata";
import { ProviderRegistry, StremioAddonProvider, mergeResults, type AddonInstallation } from "@monitoros/provider-sdk";
import { fetchJson, loadState, saveState } from "./bridge";

export const cinemeta = new Cinemeta(fetchJson);
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

/** Seed entries for a tag, enriched progressively with Cinemeta metadata. */
export function useTagItems(tag: string | undefined, limit = 20): MediaItem[] {
  const entries = SEED.filter((s) => tag && s.tags.includes(tag)).slice(0, limit);
  const [items, setItems] = useState<MediaItem[]>(() => entries.map(seedToItem));
  useEffect(() => {
    let alive = true;
    Promise.all(entries.map((e) => cinemeta.enrich(e))).then((res) => alive && setItems(res));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, limit]);
  return items;
}

export function useTypeItems(kind: MediaType): MediaItem[] {
  const entries = SEED.filter((s) => s.type === kind);
  const [items, setItems] = useState<MediaItem[]>(() => entries.map(seedToItem));
  useEffect(() => {
    let alive = true;
    Promise.all(entries.map((e) => cinemeta.enrich(e))).then((res) => alive && setItems(res));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  return items;
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
  const [meta, providers] = await Promise.all([cinemeta.search(query).catch(() => []), registry.search(query)]);
  const merged = mergeResults([...local, ...meta, ...providers.value]);
  const ranked = filterAndRank(merged, query, { freeOnly });
  return { items: ranked.length ? ranked : freeOnly ? [] : merged, errors: providers.errors.map((e) => `${e.providerId}: ${e.message}`) };
}
