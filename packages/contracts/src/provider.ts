import type { EpisodeReference, MediaItem, MediaType, PlaybackSource } from "./media";

export interface ProviderCapabilities {
  types: MediaType[];
  catalog: boolean;
  search: boolean;
  metadata: boolean;
  streams: boolean;
  subtitles: boolean;
  requiresAuth: boolean;
  regions?: string[];
}

export type ProviderCategory =
  | "subscription"
  | "free-avod"
  | "public-broadcast"
  | "public-domain"
  | "user-source"
  | "addon";

export interface ProviderHealth {
  status: "ok" | "degraded" | "down" | "unknown";
  latencyMs?: number;
  checkedAt: number;
  message?: string;
}

export interface CatalogRequest {
  catalogId: string;
  type: MediaType;
  skip?: number;
  genre?: string;
}

export interface ContentProvider {
  id: string;
  name: string;
  category: ProviderCategory;
  capabilities: ProviderCapabilities;
  catalog?(req: CatalogRequest): Promise<MediaItem[]>;
  search(query: string): Promise<MediaItem[]>;
  getMetadata(id: string, type: MediaType): Promise<MediaItem>;
  getStreams(item: MediaItem, episode?: EpisodeReference): Promise<PlaybackSource[]>;
  healthCheck(): Promise<ProviderHealth>;
}

/** A subscription service MonitorOS can hand off to. Never stores passwords. */
export interface SubscriptionService {
  id: string;
  name: string;
  brand: { bg: string; fg: string; accent?: string };
  web: string;
  /** Template with {title} placeholder, used only when no deep link is known. */
  searchUrl?: string;
  regions: string[];
  drm: boolean;
}
