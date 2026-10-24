import { describe, expect, it, vi } from "vitest";
import { SEED, HOME_ROWS } from "./seed";
import { SUBSCRIPTION_SERVICES, launchUrl } from "./services";
import { Cinemeta, seedToItem } from "./cinemeta";
import { InternetArchiveProvider, docToItem, pickVideoFiles } from "./internet-archive";
import { parseM3U } from "./m3u";
import { accessLabel, filterAndRank } from "./search";

describe("seed catalogue", () => {
  it("has unique, well-formed IMDb ids", () => {
    const ids = SEED.map((s) => s.imdb);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^tt\d{7,8}$/));
  });

  it("every media row has content", () => {
    for (const row of HOME_ROWS.filter((r) => r.kind === "media")) {
      expect(SEED.filter((s) => s.tags.includes(row.tag!)).length, row.id).toBeGreaterThan(2);
    }
  });

  it("makes no availability claims", () => {
    expect(SEED.map(seedToItem).every((i) => i.availability.length === 0)).toBe(true);
  });
});

describe("subscription hand-off", () => {
  const netflix = SUBSCRIPTION_SERVICES.find((s) => s.id === "netflix")!;
  const hotstar = SUBSCRIPTION_SERVICES.find((s) => s.id === "jiohotstar")!;

  it("prefers a known deep link", () => {
    expect(launchUrl(netflix, { title: "x", availability: [{ providerId: "netflix", access: "subscription", source: "curated", deepLink: "https://www.netflix.com/title/81" }] })).toBe(
      "https://www.netflix.com/title/81",
    );
  });

  it("falls back to search, then to the home page", () => {
    expect(launchUrl(netflix, { title: "Dune: Part Two", availability: [] })).toBe("https://www.netflix.com/search?q=Dune%3A%20Part%20Two");
    expect(launchUrl(hotstar, { title: "x", availability: [] })).toBe("https://www.hotstar.com/in");
  });

  it("refuses unsafe deep links", () => {
    expect(() => launchUrl(netflix, { title: "x", availability: [{ providerId: "netflix", access: "subscription", source: "addon", deepLink: "javascript:alert(1)" }] })).toThrow();
  });
});

describe("Cinemeta enrichment", () => {
  it("falls back to the offline seed when the network fails", async () => {
    const c = new Cinemeta(async () => {
      throw new Error("offline");
    });
    const item = await c.enrich(SEED[0]!);
    expect(item.title).toBe("Dune: Part Two");
    expect(item.id).toBe("imdb:tt15239678");
  });

  it("merges live metadata but keeps editorial tags", async () => {
    const c = new Cinemeta(async () => ({ meta: { id: "tt15239678", type: "movie", name: "Dune: Part Two", imdbRating: "8.5", poster: "https://images.metahub.space/poster/medium/tt15239678/img" } }));
    const item = await c.enrich(SEED[0]!);
    expect(item.rating?.source).toBe("IMDb");
    expect(item.tags).toContain("hero");
    expect(item.artwork.poster).toMatch(/^https:/);
  });
});

describe("Internet Archive provider", () => {
  it("maps docs and rejects odd identifiers", () => {
    expect(docToItem({ identifier: "his_girl_friday", title: "His Girl Friday", year: 1940, licenseurl: "http://creativecommons.org/licenses/publicdomain/" })?.availability[0]?.access).toBe("free");
    expect(docToItem({ identifier: "../etc", title: "x" })).toBeNull();
  });

  it("prefers h.264 mp4 derivatives", () => {
    const files = pickVideoFiles([
      { name: "a.ogv", format: "Ogg Video" },
      { name: "a.mp4", format: "h.264", height: "480" },
      { name: "a_512kb.mp4", format: "512Kb MPEG4", height: "240" },
      { name: "a.txt", format: "Text" },
    ]);
    expect(files.map((f) => f.name)).toEqual(["a.mp4", "a_512kb.mp4", "a.ogv"]);
  });

  it("re-checks the licence before returning streams", async () => {
    const fetchJson = vi.fn(async () => ({ metadata: { licenseurl: "http://creativecommons.org/licenses/by-nc/4.0/" }, files: [{ name: "a.mp4", format: "h.264" }] }));
    const p = new InternetArchiveProvider(fetchJson);
    const item = docToItem({ identifier: "x", title: "x" })!;
    expect(await p.getStreams(item)).toEqual([]);
  });

  it("returns public-domain streams with provenance", async () => {
    const p = new InternetArchiveProvider(async () => ({ metadata: { licenseurl: "http://creativecommons.org/publicdomain/mark/1.0/" }, files: [{ name: "film.mp4", format: "h.264", height: "720" }] }));
    const [s] = await p.getStreams(docToItem({ identifier: "film", title: "Film" })!);
    expect(s).toMatchObject({ url: "https://archive.org/download/film/film.mp4", provenance: "public-domain", quality: "720p", drm: false });
  });
});

describe("M3U parser", () => {
  const playlist = `#EXTM3U
#EXTINF:-1 tvg-id="dd" tvg-logo="https://x.example.com/dd.png" group-title="News",DD News
https://cdn.example.com/dd/index.m3u8
#EXTINF:-1,Router admin
http://192.168.1.1/stream
#EXTINF:-1,Bad
javascript:alert(1)`;

  it("parses channels and skips unsafe URLs", () => {
    const { channels, skipped } = parseM3U(playlist);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ id: "dd", name: "DD News", group: "News" });
    expect(skipped).toBe(2);
  });

  it("allows LAN streams only when the user opts in", () => {
    expect(parseM3U(playlist, { allowPrivateNetwork: true }).channels).toHaveLength(2);
  });

  it("rejects non-playlists", () => {
    expect(() => parseM3U("<html>")).toThrow(/M3U/);
  });
});

describe("search filters", () => {
  const items = SEED.map(seedToItem).map((i) => (i.title === "RRR" ? { ...i, cast: ["N.T. Rama Rao Jr.", "Ram Charan"], genres: ["Action"] } : i));

  it("matches titles, people and year", () => {
    expect(filterAndRank(items, "dune")[0]?.title).toBe("Dune: Part Two");
    expect(filterAndRank(items, "ram charan")[0]?.title).toBe("RRR");
    expect(filterAndRank(items, "", { languages: ["ml"] }).map((i) => i.title)).toEqual(["Manjummel Boys"]);
    expect(filterAndRank(items, "", { types: ["anime"] }).length).toBe(5);
  });

  it("free-only excludes items with unknown availability", () => {
    expect(filterAndRank(items, "", { freeOnly: true })).toEqual([]);
  });

  it("labels availability honestly", () => {
    expect(accessLabel(items[0]!, []).label).toBe("Availability unknown");
  });
});
