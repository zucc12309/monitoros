import { describe, expect, it, vi } from "vitest";
import { Cinemeta } from "./cinemeta";
import { CatalogCache, CATALOG_TTL, type CatalogPage } from "./catalog-cache";
import { seedToItem } from "./cinemeta";
import { SEED } from "./seed";

const page: CatalogPage = { items: [seedToItem(SEED[0]!)], nextSkip: 50 };
const meta = (id: string) => ({ id, name: id, type: "movie", poster: "https://example.com/poster.jpg" });

describe("live Cinemeta catalogs", () => {
  it("uses the direct HTTPS endpoint and advances 50 slots even for a short page", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ metas: [meta("tt1234567"), meta("tt1234567"), null] }).mockResolvedValueOnce({ metas: [] });
    const c = new Cinemeta(fetch);
    const first = await c.catalog({ type: "movie" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://cinemeta-catalogs.strem.io/top/catalog/movie/top.json");
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.availability).toEqual([]);
    expect(first.nextSkip).toBe(50);
    expect(await c.catalog({ type: "movie", skip: first.nextSkip! })).toEqual({ items: [], nextSkip: null });
    expect(fetch.mock.calls[1]?.[0]).toContain("/skip=50.json");
  });

  it("separates type, year and offset in cache keys", async () => {
    const fetch = vi.fn().mockResolvedValue({ metas: [] });
    const c = new Cinemeta(fetch);
    const year = new Date().getFullYear();
    await c.catalog({ type: "movie", catalog: "year", year, skip: 50 });
    await c.catalog({ type: "series", catalog: "year", year, skip: 50 });
    await c.catalog({ type: "series", catalog: "year", year: year - 1, skip: 50 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[0]).toContain(`/year/catalog/movie/year/genre=${year}&skip=50.json`);
    await c.catalog({ type: "movie", catalog: "year", year, skip: 50 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed catalog responses instead of caching a false end-of-list", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ error: "unavailable" }).mockResolvedValueOnce({ metas: [meta("tt1234567")] });
    const c = new Cinemeta(fetch);
    await expect(c.catalog({ type: "movie" })).rejects.toThrow("Invalid");
    expect((await c.catalog({ type: "movie" })).items).toHaveLength(1);
  });

  it("loads episode details for titles outside the seed list", async () => {
    const fetch = vi.fn().mockResolvedValue({ meta: { id: "tt9999999", name: "New show", type: "series", videos: [{ id: "ep1", season: 1, episode: 1, name: "Pilot" }] } });
    const c = new Cinemeta(fetch);
    const item = { ...page.items[0]!, id: "imdb:tt9999999", ids: { imdb: "tt9999999" }, type: "series" as const };
    expect((await c.details(item)).episodes?.[0]?.title).toBe("Pilot");
    expect(fetch.mock.calls[0]?.[0]).toContain("/meta/series/tt9999999.json");
  });
});

describe("persistent catalog cache", () => {
  it("deduplicates concurrent loads and persists across instances", async () => {
    let disk: unknown;
    const storage = { load: async () => disk, save: async (data: unknown) => { disk = data; } };
    const fetch = vi.fn(async () => page);
    const cache = new CatalogCache(storage);
    await Promise.all([cache.get("movies", fetch), cache.get("movies", fetch)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await new CatalogCache(storage).get("movies", fetch)).items).toEqual(page.items);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("revalidates expired pages and keeps stale data on failure without extending freshness", async () => {
    let now = 1000;
    const cache = new CatalogCache(undefined, () => now);
    await cache.get("movies", async () => page);
    now += CATALOG_TTL;
    const fail = vi.fn(async () => { throw new Error("offline"); });
    expect((await cache.get("movies", fail)).stale).toBe(true);
    expect((await cache.get("movies", fail)).stale).toBe(true);
    expect(fail).toHaveBeenCalledTimes(2);
    const updated = { items: [], nextSkip: null };
    expect(await cache.get("movies", async () => updated)).toEqual(updated);
    expect((await cache.peek("movies"))?.stale).toBe(false);
    now += 8 * 24 * 60 * 60 * 1000;
    await expect(cache.get("movies", fail)).rejects.toThrow("offline");
  });

  it("tolerates malformed persistence and disk write failures", async () => {
    const cache = new CatalogCache({ load: async () => ({ version: 1, entries: [null, ["bad", { at: Date.now(), page: {} }]] }), save: async () => { throw new Error("quota"); } });
    expect(await cache.get("movies", async () => page)).toEqual(page);
    expect((await cache.peek("movies"))?.items).toEqual(page.items);
  });

  it("bounds the persisted cache", async () => {
    const save = vi.fn(async (_data: unknown) => {});
    const cache = new CatalogCache({ load: async () => null, save });
    for (let i = 0; i < 40; i++) await cache.get(`page${i}`, async () => page);
    expect((save.mock.lastCall?.[0] as { entries: unknown[] }).entries).toHaveLength(32);
    expect(await cache.peek("page0")).toBeUndefined();
  });
});
