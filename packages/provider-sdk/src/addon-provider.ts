import type {
  CatalogRequest,
  ContentProvider,
  EpisodeReference,
  MediaItem,
  MediaType,
  PlaybackSource,
  ProviderCapabilities,
  ProviderHealth,
  Provenance,
} from "@monitoros/contracts";
import type { JsonFetcher } from "./http";
import {
  metaToMediaItem,
  normalizeManifestUrl,
  normalizeStreams,
  resourceUrl,
  supportsResource,
  toStremioType,
  validateManifest,
  type StremioManifest,
  type StremioMeta,
} from "./stremio";

export interface AddonInstallation {
  manifestUrl: string;
  manifest: StremioManifest;
  enabled: boolean;
  installedAt: number;
  /** User-declared trust level. Third-party add-ons default to "unverified". */
  provenance: Provenance;
}

const TIMEOUT_MS = 8000;

export async function fetchManifest(input: string, fetchJson: JsonFetcher): Promise<{ manifestUrl: string; manifest: StremioManifest }> {
  const manifestUrl = normalizeManifestUrl(input);
  const manifest = validateManifest(await fetchJson(manifestUrl, "addon", TIMEOUT_MS));
  if (manifest.behaviorHints?.adult) throw new Error("adult add-ons are not supported");
  return { manifestUrl, manifest };
}

/** Wraps a remote Stremio-protocol add-on as a ContentProvider. */
export class StremioAddonProvider implements ContentProvider {
  readonly id: string;
  readonly name: string;
  readonly category = "addon" as const;
  readonly capabilities: ProviderCapabilities;

  constructor(
    readonly install: AddonInstallation,
    private readonly fetchJson: JsonFetcher,
  ) {
    const m = install.manifest;
    this.id = `addon:${m.id}`;
    this.name = m.name;
    const has = (r: string) => m.resources.some((x) => (typeof x === "string" ? x : x.name) === r);
    this.capabilities = {
      types: m.types.map((t) => (t === "movie" ? "movie" : t === "tv" ? "live" : "series")) as MediaType[],
      catalog: m.catalogs.length > 0,
      search: m.catalogs.some((c) => c.extra?.some((e) => e.name === "search")),
      metadata: has("meta"),
      streams: has("stream"),
      subtitles: has("subtitles"),
      requiresAuth: false,
    };
  }

  async catalog(req: CatalogRequest): Promise<MediaItem[]> {
    const type = toStremioType(req.type);
    const extra: Record<string, string> = {};
    if (req.genre) extra.genre = req.genre;
    if (req.skip) extra.skip = String(req.skip);
    const data = (await this.fetchJson(resourceUrl(this.install.manifestUrl, "catalog", type, req.catalogId, extra), "addon", TIMEOUT_MS)) as { metas?: StremioMeta[] };
    return (data.metas ?? []).slice(0, 100).filter((m) => m?.id && m?.name).map((m) => metaToMediaItem(m, this.id));
  }

  async search(query: string): Promise<MediaItem[]> {
    const q = query.trim().slice(0, 100);
    if (!q) return [];
    const cats = this.install.manifest.catalogs.filter((c) => c.extra?.some((e) => e.name === "search"));
    const results = await Promise.allSettled(
      cats.map(async (c) => {
        const data = (await this.fetchJson(resourceUrl(this.install.manifestUrl, "catalog", c.type, c.id, { search: q }), "addon", TIMEOUT_MS)) as { metas?: StremioMeta[] };
        return (data.metas ?? []).slice(0, 50).filter((m) => m?.id && m?.name).map((m) => metaToMediaItem(m, this.id));
      }),
    );
    return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  async getMetadata(id: string, type: MediaType): Promise<MediaItem> {
    const st = toStremioType(type);
    if (!supportsResource(this.install.manifest, "meta", st, id)) throw new Error(`${this.name} has no metadata for ${id}`);
    const data = (await this.fetchJson(resourceUrl(this.install.manifestUrl, "meta", st, id), "addon", TIMEOUT_MS)) as { meta?: StremioMeta };
    if (!data.meta) throw new Error("not found");
    return metaToMediaItem(data.meta, this.id);
  }

  async getStreams(item: MediaItem, episode?: EpisodeReference): Promise<PlaybackSource[]> {
    const st = toStremioType(item.type);
    const base = item.ids.imdb ?? item.ids.provider?.[this.id];
    if (!base) return [];
    const id = episode ? `${base}:${episode.season}:${episode.episode}` : base;
    if (!supportsResource(this.install.manifest, "stream", st, id)) return [];
    const data = (await this.fetchJson(resourceUrl(this.install.manifestUrl, "stream", st, id), "addon", TIMEOUT_MS)) as { streams?: unknown };
    return normalizeStreams(data.streams, { providerId: this.id, provenance: this.install.provenance });
  }

  async healthCheck(): Promise<ProviderHealth> {
    const t0 = Date.now();
    try {
      validateManifest(await this.fetchJson(this.install.manifestUrl, "addon", TIMEOUT_MS));
      return { status: "ok", latencyMs: Date.now() - t0, checkedAt: Date.now() };
    } catch (e) {
      return { status: "down", checkedAt: Date.now(), message: (e as Error).message };
    }
  }
}
