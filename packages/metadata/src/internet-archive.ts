/**
 * Internet Archive public-domain feature films — MonitorOS's first fully
 * integrated free provider. Only items whose licenseurl declares public
 * domain / CC0 are listed, and the declared licence is shown to the user.
 */
import type { CatalogRequest, ContentProvider, MediaItem, PlaybackSource, ProviderHealth } from "@monitoros/contracts";
import { canonicalId } from "@monitoros/contracts";
import { paletteFor, type JsonFetcher } from "@monitoros/provider-sdk";

const BASE = "https://archive.org";
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const TIMEOUT = 10000;
const LICENSE_FILTER = "(licenseurl:*publicdomain* OR licenseurl:*zero*)";

interface IaDoc {
  identifier: string;
  title?: string;
  year?: string | number;
  description?: string | string[];
  licenseurl?: string;
  language?: string | string[];
  subject?: string | string[];
}

interface IaFile {
  name: string;
  format?: string;
  size?: string;
  length?: string;
  height?: string;
}

const arr = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
const stripHtml = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

export function docToItem(doc: IaDoc): MediaItem | null {
  if (!ID_RE.test(doc.identifier) || !doc.title) return null;
  const ids = { provider: { "internet-archive": doc.identifier } };
  const year = Number.parseInt(String(doc.year ?? ""), 10);
  return {
    id: canonicalId("movie", ids),
    ids,
    type: "movie",
    title: doc.title.slice(0, 200),
    year: Number.isFinite(year) ? year : undefined,
    description: stripHtml(arr(doc.description).join(" ")).slice(0, 500) || undefined,
    genres: arr(doc.subject).slice(0, 3),
    languages: arr(doc.language).slice(0, 3),
    artwork: { poster: `${BASE}/services/img/${doc.identifier}`, palette: paletteFor(doc.title) },
    availability: [{ providerId: "internet-archive", access: "free", source: "provider-api", deepLink: `${BASE}/details/${doc.identifier}` }],
    tags: ["free", "public-domain", doc.licenseurl ? `license:${doc.licenseurl}` : "license:unknown"],
  };
}

/** Pick the best browser/mpv-friendly derivative: h.264 MP4 first, highest resolution. */
export function pickVideoFiles(files: IaFile[]): IaFile[] {
  const score = (f: IaFile) => {
    const fmt = (f.format ?? "").toLowerCase();
    let s = 0;
    if (fmt.includes("h.264") || fmt === "mpeg4" || f.name.endsWith(".mp4")) s += 100;
    else if (fmt.includes("matroska") || f.name.endsWith(".mkv")) s += 60;
    else if (fmt.includes("ogg video") || f.name.endsWith(".ogv")) s += 30;
    else return -1;
    s += Math.min(Number(f.height ?? 0), 2160) / 100;
    return s;
  };
  return files.filter((f) => typeof f.name === "string" && !f.name.split("/").includes("..") && score(f) >= 0).sort((a, b) => score(b) - score(a));
}

export class InternetArchiveProvider implements ContentProvider {
  readonly id = "internet-archive";
  readonly name = "Internet Archive";
  readonly category = "public-domain" as const;
  readonly capabilities = { types: ["movie" as const], catalog: true, search: true, metadata: true, streams: true, subtitles: false, requiresAuth: false };

  constructor(private readonly fetchJson: JsonFetcher) {}

  private async query(q: string, rows: number, page = 1): Promise<MediaItem[]> {
    const params = new URLSearchParams({ q, rows: String(rows), page: String(page), output: "json" });
    for (const f of ["identifier", "title", "year", "description", "licenseurl", "language", "subject"]) params.append("fl[]", f);
    params.append("sort[]", "downloads desc");
    const data = (await this.fetchJson(`${BASE}/advancedsearch.php?${params}`, "addon", TIMEOUT)) as { response?: { docs?: IaDoc[] } };
    return (data.response?.docs ?? []).map(docToItem).filter((x): x is MediaItem => x !== null);
  }

  catalog(req: CatalogRequest): Promise<MediaItem[]> {
    const page = Math.floor((req.skip ?? 0) / 30) + 1;
    return this.query(`collection:feature_films AND mediatype:movies AND ${LICENSE_FILTER}`, 30, page);
  }

  search(query: string): Promise<MediaItem[]> {
    const q = query.replace(/[^\p{L}\p{N} '-]/gu, " ").trim().slice(0, 80);
    if (!q) return Promise.resolve([]);
    return this.query(`title:(${q}) AND collection:feature_films AND mediatype:movies AND ${LICENSE_FILTER}`, 20);
  }

  async getMetadata(id: string): Promise<MediaItem> {
    const ident = id.replace(/^internet-archive:/, "");
    if (!ID_RE.test(ident)) throw new Error("invalid id");
    const data = (await this.fetchJson(`${BASE}/metadata/${ident}`, "addon", TIMEOUT)) as { metadata?: IaDoc };
    const item = data.metadata && docToItem({ ...data.metadata, identifier: ident });
    if (!item) throw new Error("not found");
    return item;
  }

  async getStreams(item: MediaItem): Promise<PlaybackSource[]> {
    const ident = item.ids.provider?.["internet-archive"];
    if (!ident || !ID_RE.test(ident)) return [];
    const data = (await this.fetchJson(`${BASE}/metadata/${ident}`, "addon", TIMEOUT)) as { files?: IaFile[]; metadata?: IaDoc };
    const license = data.metadata?.licenseurl ?? "";
    if (!/publicdomain|zero/i.test(license)) return []; // licence changed since listing
    return pickVideoFiles(data.files ?? []).slice(0, 4).map((f, i) => {
      const h = Number(f.height ?? 0);
      return {
        id: `internet-archive#${ident}#${i}`,
        providerId: this.id,
        kind: "direct",
        url: `${BASE}/download/${encodeURIComponent(ident)}/${f.name.split("/").map(encodeURIComponent).join("/")}`,
        title: `${f.format ?? "Video"}${h ? ` · ${h}p` : ""}`,
        quality: h >= 2000 ? "2160p" : h >= 1000 ? "1080p" : h >= 700 ? "720p" : h ? "480p" : "unknown",
        codec: /h\.264|mpeg4/i.test(f.format ?? "") || f.name.endsWith(".mp4") ? "h264" : "unknown",
        access: "free",
        provenance: "public-domain",
        drm: false,
      } satisfies PlaybackSource;
    });
  }

  async healthCheck(): Promise<ProviderHealth> {
    const t0 = Date.now();
    try {
      await this.query("identifier:night_of_the_living_dead", 1);
      return { status: "ok", latencyMs: Date.now() - t0, checkedAt: Date.now() };
    } catch (e) {
      return { status: "down", checkedAt: Date.now(), message: (e as Error).message };
    }
  }
}
