import { describe, expect, it, vi } from "vitest";
import { metaToMediaItem, normalizeManifestUrl, normalizeStreams, resourceUrl, supportsResource, validateManifest } from "./stremio";
import { StremioAddonProvider, fetchManifest } from "./addon-provider";

const CINEMETA = {
  id: "com.linvo.cinemeta",
  version: "3.0.14",
  name: "Cinemeta",
  resources: ["catalog", "meta", "addon_catalog"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [{ type: "movie", id: "top", extra: [{ name: "search" }, { name: "genre" }] }],
};

const STREAMER = {
  id: "org.example.publicdomain",
  version: "1.0.0",
  name: "Public Domain Films",
  resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
  types: ["movie"],
  catalogs: [],
};

describe("manifest validation", () => {
  it("accepts the real Cinemeta manifest shape", () => {
    const m = validateManifest(CINEMETA);
    expect(m.id).toBe("com.linvo.cinemeta");
    expect(m.catalogs).toHaveLength(1);
  });

  it("rejects malformed manifests", () => {
    expect(() => validateManifest({ ...CINEMETA, id: "../../etc" })).toThrow(/id/);
    expect(() => validateManifest({ ...CINEMETA, version: "latest" })).toThrow(/semver/);
    expect(() => validateManifest({ ...CINEMETA, resources: [] })).toThrow(/resources/);
    expect(() => validateManifest({ ...CINEMETA, resources: ["shell"] })).toThrow(/unknown resource/);
    expect(() => validateManifest({ ...CINEMETA, catalogs: Array(101).fill({ type: "movie", id: "x" }) })).toThrow(/too many/);
    expect(() => validateManifest("nope")).toThrow();
  });

  it("drops unknown fields", () => {
    const m = validateManifest({ ...CINEMETA, onInstall: "require('child_process')" }) as unknown as Record<string, unknown>;
    expect(m.onInstall).toBeUndefined();
  });

  it("checks resource support by type and id prefix", () => {
    const m = validateManifest(STREAMER);
    expect(supportsResource(m, "stream", "movie", "tt0032138")).toBe(true);
    expect(supportsResource(m, "stream", "series", "tt0032138")).toBe(false);
    expect(supportsResource(m, "stream", "movie", "kitsu:1")).toBe(false);
  });
});

describe("manifest URLs", () => {
  it("normalizes stremio:// and bare URLs", () => {
    expect(normalizeManifestUrl("stremio://v3-cinemeta.strem.io/manifest.json")).toBe("https://v3-cinemeta.strem.io/manifest.json");
    expect(normalizeManifestUrl("addon.example.com/cfg")).toBe("https://addon.example.com/cfg/manifest.json");
  });

  it("refuses private hosts and http", () => {
    expect(() => normalizeManifestUrl("http://addon.example.com")).toThrow();
    expect(() => normalizeManifestUrl("https://127.0.0.1:11470")).toThrow();
    expect(() => normalizeManifestUrl("https://169.254.169.254/latest")).toThrow();
  });

  it("builds resource URLs with encoded ids and extras", () => {
    expect(resourceUrl("https://a.example.com/manifest.json", "catalog", "movie", "top", { search: "dune part two" })).toBe(
      "https://a.example.com/catalog/movie/top/search=dune%20part%20two.json",
    );
    expect(resourceUrl("https://a.example.com/manifest.json", "stream", "series", "tt1:1:2")).toBe("https://a.example.com/stream/series/tt1%3A1%3A2.json");
  });
});

describe("stream normalization", () => {
  it("keeps safe http streams, drops torrents and unsafe URLs", () => {
    const out = normalizeStreams(
      [
        { url: "https://archive.org/download/x/x.mp4", title: "1080p H.264" },
        { url: "https://cdn.example.com/x/master.m3u8", name: "HLS 4K HEVC" },
        { infoHash: "abc", title: "torrent" },
        { url: "file:///etc/passwd" },
        { url: "http://192.168.1.1/admin" },
        { ytId: "dQw4w9WgXcQ" },
        { ytId: "bad id;" },
      ],
      { providerId: "p", provenance: "public-domain", access: "free" },
    );
    expect(out.map((s) => s.kind)).toEqual(["direct", "hls", "external-browser"]);
    expect(out[0]).toMatchObject({ quality: "1080p", codec: "h264" });
    expect(out[1]).toMatchObject({ quality: "2160p", codec: "hevc" });
  });

  it("filters unsafe subtitle URLs", () => {
    const [s] = normalizeStreams(
      [{ url: "https://a.example.com/v.mp4", subtitles: [{ url: "https://a.example.com/en.srt", lang: "eng" }, { url: "file:///x.srt", lang: "x" }] }],
      { providerId: "p", provenance: "unverified" },
    );
    expect(s!.subtitles).toHaveLength(1);
    expect(s!.subtitles![0]!.format).toBe("srt");
  });

  it("returns [] for non-arrays", () => {
    expect(normalizeStreams({ evil: true }, { providerId: "p", provenance: "unverified" })).toEqual([]);
  });
});

describe("meta mapping", () => {
  it("maps Cinemeta meta to a MediaItem with attributed rating", () => {
    const item = metaToMediaItem(
      { id: "tt15239678", type: "movie", name: "Dune: Part Two", releaseInfo: "2024", imdbRating: "8.5", genres: ["Sci-Fi"], poster: "javascript:alert(1)" },
      "addon:cinemeta",
    );
    expect(item.id).toBe("imdb:tt15239678");
    expect(item.rating).toEqual({ value: 8.5, scale: 10, source: "IMDb" });
    expect(item.year).toBe(2024);
    expect(item.artwork.poster).toBeUndefined();
  });
});

describe("StremioAddonProvider", () => {
  it("installs via fetchManifest and resolves streams for episodes", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith("/manifest.json")) return { ...STREAMER, types: ["movie", "series"], resources: ["stream"] };
      if (url.includes("/stream/series/tt1%3A2%3A3.json")) return { streams: [{ url: "https://cdn.example.com/e.mp4", title: "720p" }] };
      throw new Error(`unexpected ${url}`);
    });
    const { manifestUrl, manifest } = await fetchManifest("https://pd.example.com", fetchJson);
    const p = new StremioAddonProvider({ manifestUrl, manifest, enabled: true, installedAt: 0, provenance: "public-domain" }, fetchJson);
    const streams = await p.getStreams(
      { id: "imdb:tt1", ids: { imdb: "tt1" }, type: "series", title: "x", genres: [], languages: [], artwork: { palette: ["#000", "#000"] }, availability: [] },
      { season: 2, episode: 3 },
    );
    expect(streams).toHaveLength(1);
    expect(streams[0]!.provenance).toBe("public-domain");
  });

  it("refuses adult add-ons", async () => {
    await expect(fetchManifest("https://x.example.com", async () => ({ ...STREAMER, behaviorHints: { adult: true } }))).rejects.toThrow(/adult/);
  });
});
