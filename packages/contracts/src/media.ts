/** Media domain types shared by the desktop app, remote, provider SDK and player. */

export type MediaType = "movie" | "series" | "anime" | "live" | "local";

/** Stable cross-provider identifiers used for deduplication. */
export interface MediaIds {
  imdb?: string; // e.g. tt15239678
  tmdb?: number;
  local?: string; // hash of an on-disk path
  provider?: Record<string, string>; // providerId -> provider-native id
}

export interface Rating {
  value: number;
  scale: 10 | 100;
  /** Attribution is mandatory: never display a bare number. */
  source: "IMDb" | "TMDB" | "Cinemeta" | "User";
}

export interface EpisodeReference {
  season: number;
  episode: number;
}

export interface Episode extends EpisodeReference {
  id: string;
  title: string;
  released?: string;
  thumbnail?: string;
}

export interface Artwork {
  poster?: string;
  backdrop?: string;
  logo?: string;
  /** Deterministic gradient used when no licensed artwork is available. */
  palette: [string, string];
}

/**
 * How a title can be watched. Kept separate from metadata on purpose:
 * metadata availability never implies playback availability.
 */
export type AccessModel =
  | "free-with-ads"
  | "free"
  | "subscription"
  | "rent-or-buy"
  | "local"
  | "unknown";

export interface Availability {
  providerId: string;
  access: AccessModel;
  regions?: string[]; // ISO 3166-1 alpha-2, empty/undefined = unknown
  deepLink?: string;
  /** Where the availability claim came from, for honest UI. */
  source: "provider-api" | "curated" | "addon" | "user" | "local-scan";
}

export interface MediaItem {
  id: string; // canonical MonitorOS id, see canonicalId()
  ids: MediaIds;
  type: MediaType;
  title: string;
  year?: number;
  description?: string;
  genres: string[];
  languages: string[];
  cast?: string[];
  directors?: string[];
  rating?: Rating;
  runtimeMinutes?: number;
  artwork: Artwork;
  seasons?: number;
  episodes?: Episode[];
  availability: Availability[];
  tags?: string[]; // e.g. "trending", "india", "south-indian"
}

export type SourceKind = "direct" | "hls" | "dash" | "local-file" | "external-browser" | "external-app";

export type Provenance =
  | "official-provider"
  | "public-domain"
  | "creative-commons"
  | "user-provided"
  | "third-party-addon"
  | "unverified";

export interface PlaybackSource {
  id: string;
  providerId: string;
  kind: SourceKind;
  url: string;
  title: string;
  quality?: "480p" | "720p" | "1080p" | "2160p" | "unknown";
  codec?: "h264" | "hevc" | "av1" | "vp9" | "unknown";
  languages?: string[];
  subtitles?: SubtitleTrack[];
  access: AccessModel;
  provenance: Provenance;
  drm: boolean;
  /** Region restrictions the provider declared, if any. */
  regions?: string[];
}

export interface SubtitleTrack {
  id: string;
  lang: string;
  url: string;
  format: "srt" | "vtt" | "ass" | "unknown";
}

export interface WatchProgress {
  mediaId: string;
  episode?: EpisodeReference;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
}

/** Canonical id: prefer IMDb, then TMDB, then local, then provider. */
export function canonicalId(type: MediaType, ids: MediaIds): string {
  if (ids.imdb) return `imdb:${ids.imdb}`;
  if (ids.tmdb !== undefined) return `tmdb:${type === "movie" ? "movie" : "tv"}:${ids.tmdb}`;
  if (ids.local) return `local:${ids.local}`;
  const first = ids.provider && Object.entries(ids.provider)[0];
  if (first) return `${first[0]}:${first[1]}`;
  throw new Error("MediaItem has no identifiers");
}
