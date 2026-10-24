/**
 * Stremio add-on protocol support (declarative HTTP only).
 *
 * Spec: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md
 * Resources are fetched as  {base}/{resource}/{type}/{id}[/{extra}].json
 * We never execute add-on JavaScript; add-ons are remote JSON endpoints.
 */
import type { AccessModel, MediaItem, MediaType, PlaybackSource, Provenance, SubtitleTrack } from "@monitoros/contracts";
import { canonicalId } from "@monitoros/contracts";
import { assertSafeUrl, isSafeUrl } from "./url-guard";
import { paletteFor } from "./palette";

export type StremioResourceName = "catalog" | "meta" | "stream" | "subtitles" | "addon_catalog";

export interface StremioResourceDescriptor {
  name: StremioResourceName;
  types?: string[];
  idPrefixes?: string[];
}

export interface StremioCatalogDescriptor {
  type: string;
  id: string;
  name?: string;
  extra?: { name: string; isRequired?: boolean; options?: string[] }[];
}

export interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  resources: (StremioResourceName | StremioResourceDescriptor)[];
  types: string[];
  idPrefixes?: string[];
  catalogs: StremioCatalogDescriptor[];
  behaviorHints?: { adult?: boolean; p2p?: boolean; configurable?: boolean; configurationRequired?: boolean };
}

export class ManifestError extends Error {
  override name = "ManifestError";
}

const ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;
const KNOWN_RESOURCES: StremioResourceName[] = ["catalog", "meta", "stream", "subtitles", "addon_catalog"];
const MAX_CATALOGS = 100;

const str = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Validate and copy only the fields we understand. Unknown fields are dropped. */
export function validateManifest(raw: unknown): StremioManifest {
  if (typeof raw !== "object" || raw === null) throw new ManifestError("manifest must be an object");
  const m = raw as Record<string, unknown>;
  if (!str(m.id, 128) || !ID_RE.test(m.id)) throw new ManifestError("manifest.id is missing or invalid");
  if (!str(m.version, 64) || !SEMVER_RE.test(m.version)) throw new ManifestError("manifest.version must be semver");
  if (!str(m.name, 128)) throw new ManifestError("manifest.name is missing");
  if (!Array.isArray(m.resources) || m.resources.length === 0) throw new ManifestError("manifest.resources is empty");
  if (!Array.isArray(m.types) || !m.types.every((t) => str(t, 32))) throw new ManifestError("manifest.types is invalid");

  const resources = m.resources.map((r): StremioResourceName | StremioResourceDescriptor => {
    if (typeof r === "string") {
      if (!KNOWN_RESOURCES.includes(r as StremioResourceName)) throw new ManifestError(`unknown resource ${r.slice(0, 32)}`);
      return r as StremioResourceName;
    }
    if (typeof r === "object" && r !== null && KNOWN_RESOURCES.includes((r as { name: StremioResourceName }).name)) {
      const d = r as StremioResourceDescriptor;
      return {
        name: d.name,
        types: Array.isArray(d.types) ? d.types.filter((t) => str(t, 32)) : undefined,
        idPrefixes: Array.isArray(d.idPrefixes) ? d.idPrefixes.filter((p) => str(p, 32)) : undefined,
      };
    }
    throw new ManifestError("invalid resource descriptor");
  });

  const catalogsRaw = Array.isArray(m.catalogs) ? m.catalogs : [];
  if (catalogsRaw.length > MAX_CATALOGS) throw new ManifestError("too many catalogs");
  const catalogs = catalogsRaw.map((c) => {
    const cat = c as Record<string, unknown>;
    if (!str(cat.type, 32) || !str(cat.id, 128)) throw new ManifestError("invalid catalog descriptor");
    return {
      type: cat.type,
      id: cat.id,
      name: str(cat.name, 128) ? cat.name : undefined,
      extra: Array.isArray(cat.extra) ? (cat.extra as StremioCatalogDescriptor["extra"]) : undefined,
    };
  });

  const bh = (m.behaviorHints ?? {}) as Record<string, unknown>;
  return {
    id: m.id,
    version: m.version,
    name: m.name,
    description: str(m.description, 2000) ? m.description : undefined,
    resources,
    types: m.types as string[],
    idPrefixes: Array.isArray(m.idPrefixes) ? m.idPrefixes.filter((p) => str(p, 32)) : undefined,
    catalogs,
    behaviorHints: { adult: bh.adult === true, p2p: bh.p2p === true, configurationRequired: bh.configurationRequired === true },
  };
}

/** Accepts stremio://, https://…/manifest.json or a bare base URL. Returns the manifest URL. */
export function normalizeManifestUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new ManifestError("enter an add-on manifest URL");
  s = s.replace(/^stremio:\/\//i, "https://");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const url = assertSafeUrl(s, "addon");
  url.hash = "";
  if (!url.pathname.toLowerCase().endsWith("/manifest.json")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/manifest.json`;
  }
  return url.toString();
}

export function resourceUrl(manifestUrl: string, resource: StremioResourceName, type: string, id: string, extra?: Record<string, string>): string {
  const base = manifestUrl.replace(/\/manifest\.json$/i, "");
  const extraPart = extra && Object.keys(extra).length
    ? "/" + Object.entries(extra).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";
  return `${base}/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPart}.json`;
}

export function supportsResource(m: StremioManifest, name: StremioResourceName, type: string, id?: string): boolean {
  for (const r of m.resources) {
    const d: StremioResourceDescriptor = typeof r === "string" ? { name: r } : r;
    if (d.name !== name) continue;
    const types = d.types ?? m.types;
    if (!types.includes(type)) continue;
    const prefixes = d.idPrefixes ?? m.idPrefixes;
    if (id && prefixes && prefixes.length && !prefixes.some((p) => id.startsWith(p))) continue;
    return true;
  }
  return false;
}

export const toStremioType = (t: MediaType): string => (t === "movie" ? "movie" : t === "live" ? "tv" : "series");
const fromStremioType = (t: string): MediaType => (t === "movie" ? "movie" : t === "tv" || t === "channel" ? "live" : "series");

export interface StremioMeta {
  id: string;
  type: string;
  name: string;
  imdb_id?: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  year?: string | number;
  imdbRating?: string;
  genres?: string[];
  genre?: string[];
  cast?: string[];
  director?: string[];
  runtime?: string;
  language?: string;
  videos?: { id: string; season?: number; episode?: number; number?: number; name?: string; title?: string; released?: string; thumbnail?: string }[];
}

export function metaToMediaItem(meta: StremioMeta, providerId: string): MediaItem {
  const imdb = meta.imdb_id ?? (/^tt\d+$/.test(meta.id) ? meta.id : undefined);
  const type = fromStremioType(meta.type);
  const ids = { imdb, provider: { [providerId]: meta.id } };
  const yearMatch = /\d{4}/.exec(String(meta.releaseInfo ?? meta.year ?? ""));
  const rating = meta.imdbRating ? Number.parseFloat(meta.imdbRating) : NaN;
  const art = (u?: string) => (u && isSafeUrl(u, "artwork") ? u : undefined);
  const episodes = (meta.videos ?? [])
    .filter((v) => (v.season ?? 0) > 0)
    .map((v) => ({ id: v.id, season: v.season!, episode: v.episode ?? v.number ?? 0, title: v.name ?? v.title ?? "", released: v.released, thumbnail: art(v.thumbnail) }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  return {
    id: canonicalId(type, ids),
    ids,
    type,
    title: meta.name,
    year: yearMatch ? Number(yearMatch[0]) : undefined,
    description: meta.description,
    genres: meta.genres ?? meta.genre ?? [],
    languages: meta.language ? meta.language.split(/,\s*/) : [],
    cast: meta.cast,
    directors: meta.director,
    rating: Number.isFinite(rating) ? { value: rating, scale: 10, source: "IMDb" } : undefined,
    runtimeMinutes: meta.runtime ? Number.parseInt(meta.runtime, 10) || undefined : undefined,
    artwork: { poster: art(meta.poster), backdrop: art(meta.background), logo: art(meta.logo), palette: paletteFor(meta.name) },
    seasons: episodes.length ? new Set(episodes.map((e) => e.season)).size : undefined,
    episodes: episodes.length ? episodes : undefined,
    availability: [],
  };
}

export interface StremioStream {
  url?: string;
  ytId?: string;
  infoHash?: string;
  externalUrl?: string;
  name?: string;
  title?: string;
  description?: string;
  subtitles?: { id?: string; url: string; lang: string }[];
  behaviorHints?: { notWebReady?: boolean; bingeGroup?: string; countryWhitelist?: string[]; proxyHeaders?: unknown };
}

export interface NormalizeStreamOptions {
  providerId: string;
  provenance: Provenance;
  access?: AccessModel;
}

const QUALITY_RE = /\b(2160p|4k|1080p|720p|480p)\b/i;
const CODEC_RE = /\b(hevc|x265|h\.?265|av1|vp9|x264|h\.?264|avc)\b/i;

function detectQuality(text: string): PlaybackSource["quality"] {
  const q = QUALITY_RE.exec(text)?.[1]?.toLowerCase();
  if (!q) return "unknown";
  return q === "4k" ? "2160p" : (q as PlaybackSource["quality"]);
}

function detectCodec(text: string): PlaybackSource["codec"] {
  const c = CODEC_RE.exec(text)?.[1]?.toLowerCase().replace(".", "");
  if (!c) return "unknown";
  if (["hevc", "x265", "h265"].includes(c)) return "hevc";
  if (["x264", "h264", "avc"].includes(c)) return "h264";
  return c as "av1" | "vp9";
}

function subtitleFormat(url: string): SubtitleTrack["format"] {
  const ext = /\.(srt|vtt|ass)(?:$|\?)/i.exec(url)?.[1]?.toLowerCase();
  return (ext as SubtitleTrack["format"]) ?? "unknown";
}

/**
 * Normalize add-on streams. Rules:
 *  - P2P (infoHash) streams are dropped: MonitorOS ships no torrent engine and
 *    cannot verify rights for swarm content.
 *  - Any URL that fails the guard is dropped, never "fixed".
 *  - externalUrl becomes an external-browser hand-off.
 */
export function normalizeStreams(streams: unknown, opts: NormalizeStreamOptions): PlaybackSource[] {
  if (!Array.isArray(streams)) return [];
  const out: PlaybackSource[] = [];
  streams.slice(0, 200).forEach((s: StremioStream, i) => {
    if (!s || typeof s !== "object") return;
    const label = [s.name, s.title, s.description].filter(Boolean).join(" ").slice(0, 300);
    let kind: PlaybackSource["kind"];
    let url: string;
    if (typeof s.url === "string" && isSafeUrl(s.url, "stream")) {
      url = s.url;
      kind = /\.m3u8(\?|$)/i.test(url) ? "hls" : /\.mpd(\?|$)/i.test(url) ? "dash" : "direct";
    } else if (typeof s.ytId === "string" && /^[A-Za-z0-9_-]{11}$/.test(s.ytId)) {
      url = `https://www.youtube.com/watch?v=${s.ytId}`;
      kind = "external-browser";
    } else if (typeof s.externalUrl === "string" && isSafeUrl(s.externalUrl, "external")) {
      url = s.externalUrl;
      kind = "external-browser";
    } else {
      return; // infoHash / unsafe / empty
    }
    const subtitles = (s.subtitles ?? [])
      .filter((t) => t && typeof t.url === "string" && isSafeUrl(t.url, "subtitle"))
      .slice(0, 50)
      .map((t, j) => ({ id: t.id ?? `${i}-${j}`, lang: String(t.lang ?? "und").slice(0, 16), url: t.url, format: subtitleFormat(t.url) }));
    out.push({
      id: `${opts.providerId}#${i}`,
      providerId: opts.providerId,
      kind,
      url,
      title: label || `Source ${i + 1}`,
      quality: detectQuality(label),
      codec: detectCodec(label),
      subtitles,
      access: opts.access ?? "unknown",
      provenance: opts.provenance,
      drm: false,
      regions: s.behaviorHints?.countryWhitelist?.map((c) => c.toUpperCase()),
    });
  });
  return out;
}
