import { describe, expect, it } from "vitest";
import type { ContentProvider, MediaItem, PlaybackSource } from "@monitoros/contracts";
import { mergeResults, normalizeTitle } from "./dedupe";
import { rankSources, bestSource, type SourcePreferences } from "./select";
import { ProviderRegistry } from "./registry";

const item = (over: Partial<MediaItem>): MediaItem => ({
  id: "x",
  ids: {},
  type: "movie",
  title: "x",
  genres: [],
  languages: [],
  artwork: { palette: ["#000", "#000"] },
  availability: [],
  ...over,
});

describe("dedupe", () => {
  it("normalizes titles", () => {
    expect(normalizeTitle("The Lord of the Rings: The Two Towers")).toBe("lord of the rings the two towers");
    expect(normalizeTitle("Deadpool & Wolverine")).toBe("deadpool and wolverine");
    expect(normalizeTitle("Amélie")).toBe("amelie");
  });

  it("merges on IMDb id and combines availability", () => {
    const out = mergeResults([
      item({ id: "a", ids: { imdb: "tt1" }, title: "Dune", availability: [{ providerId: "netflix", access: "subscription", source: "curated" }] }),
      item({ id: "b", ids: { imdb: "tt1" }, title: "Dune", description: "desc", availability: [{ providerId: "prime", access: "rent-or-buy", source: "curated" }] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.availability.map((a) => a.providerId)).toEqual(["netflix", "prime"]);
    expect(out[0]!.description).toBe("desc");
  });

  it("merges id-less items by title+year but keeps remakes apart", () => {
    const out = mergeResults([
      item({ id: "a", title: "Dune", year: 1984 }),
      item({ id: "b", title: "Dune", year: 2021 }),
      item({ id: "c", title: "dune", year: 2021 }),
      item({ id: "d", title: "Dune" }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "d"]);
  });
});

const src = (over: Partial<PlaybackSource>): PlaybackSource => ({
  id: Math.random().toString(),
  providerId: "p",
  kind: "direct",
  url: "https://x.example.com/v.mp4",
  title: "",
  access: "free",
  provenance: "public-domain",
  drm: false,
  ...over,
});

const prefs: SourcePreferences = {
  subscriptions: ["netflix"],
  preferFree: false,
  region: "IN",
  languages: ["hi"],
  maxQuality: "1080p",
  hevcSupported: true,
  allowUnverified: false,
};

describe("source selection", () => {
  it("prefers subscriptions the user has", () => {
    const best = bestSource([src({ id: "free" }), src({ id: "nf", providerId: "netflix", access: "subscription", kind: "external-browser" })], prefs);
    expect(best?.id).toBe("nf");
  });

  it("prefers free when asked", () => {
    const best = bestSource([src({ id: "free" }), src({ id: "nf", providerId: "netflix", access: "subscription" })], { ...prefs, preferFree: true, subscriptions: [] });
    expect(best?.id).toBe("free");
  });

  it("never auto-selects unverified sources", () => {
    const ranked = rankSources([src({ id: "u", provenance: "unverified", quality: "2160p" })], prefs);
    expect(ranked[0]!.playable).toBe(false);
    expect(bestSource([src({ id: "u", provenance: "third-party-addon" })], prefs)).toBeUndefined();
  });

  it("blocks region-locked and unsupported codecs", () => {
    expect(rankSources([src({ regions: ["US"] })], prefs)[0]!.blockedReason).toMatch(/IN/);
    expect(rankSources([src({ codec: "hevc" })], { ...prefs, hevcSupported: false })[0]!.blockedReason).toMatch(/HEVC/);
  });

  it("does not exceed the device quality cap", () => {
    const best = bestSource([src({ id: "4k", quality: "2160p" }), src({ id: "hd", quality: "1080p" })], prefs);
    expect(best?.id).toBe("hd");
  });
});

const fakeProvider = (id: string, impl: Partial<ContentProvider>): ContentProvider => ({
  id,
  name: id,
  category: "addon",
  capabilities: { types: ["movie"], catalog: false, search: true, metadata: false, streams: true, subtitles: false, requiresAuth: false },
  search: async () => [],
  getMetadata: async () => {
    throw new Error("no");
  },
  getStreams: async () => [],
  healthCheck: async () => ({ status: "ok", checkedAt: 0 }),
  ...impl,
});

describe("ProviderRegistry", () => {
  it("fans out search, merges, and reports failures and timeouts", async () => {
    const reg = new ProviderRegistry(50);
    reg.register(fakeProvider("a", { search: async () => [item({ id: "1", ids: { imdb: "tt1" } })] }));
    reg.register(fakeProvider("b", { search: async () => [item({ id: "2", ids: { imdb: "tt1" } })] }));
    reg.register(fakeProvider("c", { search: async () => { throw new Error("boom"); } }));
    reg.register(fakeProvider("d", { search: () => new Promise(() => {}) }));
    const res = await reg.search("dune");
    expect(res.value).toHaveLength(1);
    expect(res.errors.map((e) => e.providerId).sort()).toEqual(["c", "d"]);
  });

  it("skips disabled providers and supports removal", async () => {
    const reg = new ProviderRegistry();
    reg.register(fakeProvider("a", { search: async () => [item({ id: "1" })] }), false);
    expect((await reg.search("x")).value).toHaveLength(0);
    reg.setEnabled("a", true);
    expect((await reg.search("x")).value).toHaveLength(1);
    expect(reg.unregister("a")).toBe(true);
    expect(() => reg.register(fakeProvider("b", {})) ).not.toThrow();
    expect(() => reg.register(fakeProvider("b", {}))).toThrow(/already/);
  });

  it("records health failures", async () => {
    const reg = new ProviderRegistry(50);
    reg.register(fakeProvider("a", { healthCheck: async () => { throw new Error("dns"); } }));
    const h = await reg.checkHealth();
    expect(h.get("a")?.status).toBe("down");
  });
});
