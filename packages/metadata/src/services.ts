/**
 * Subscription services and free providers MonitorOS can hand off to.
 *
 * MonitorOS never logs in to these services and never stores their
 * passwords. Playback of DRM content always happens in the provider's own
 * browser session or app (spec §6, §10).
 */
import type { MediaItem, ProviderCategory, SubscriptionService } from "@monitoros/contracts";
import { assertSafeUrl } from "@monitoros/provider-sdk";

export const SUBSCRIPTION_SERVICES: SubscriptionService[] = [
  { id: "netflix", name: "Netflix", brand: { bg: "#f5f5f5", fg: "#e50914" }, web: "https://www.netflix.com/browse", searchUrl: "https://www.netflix.com/search?q={title}", regions: ["*"], drm: true },
  { id: "prime", name: "Prime Video", brand: { bg: "#0f79af", fg: "#ffffff", accent: "#1a98ff" }, web: "https://www.primevideo.com/", searchUrl: "https://www.primevideo.com/search/?phrase={title}", regions: ["*"], drm: true },
  { id: "jiohotstar", name: "JioHotstar", brand: { bg: "#1f6bff", fg: "#ffffff", accent: "#e535c9" }, web: "https://www.hotstar.com/in", regions: ["IN"], drm: true },
  { id: "sonyliv", name: "Sony LIV", brand: { bg: "#140a2e", fg: "#ffffff", accent: "#f5a623" }, web: "https://www.sonyliv.com/", regions: ["IN"], drm: true },
  { id: "zee5", name: "ZEE5", brand: { bg: "#000000", fg: "#ffffff", accent: "#8230c6" }, web: "https://www.zee5.com/", searchUrl: "https://www.zee5.com/search?q={title}", regions: ["IN"], drm: true },
  { id: "youtube", name: "YouTube", brand: { bg: "#f5f5f5", fg: "#ff0000" }, web: "https://www.youtube.com/", searchUrl: "https://www.youtube.com/results?search_query={title}", regions: ["*"], drm: false },
  { id: "appletv", name: "Apple TV", brand: { bg: "#1c1c1e", fg: "#ffffff" }, web: "https://tv.apple.com/", searchUrl: "https://tv.apple.com/search?term={title}", regions: ["*"], drm: true },
  { id: "sunnxt", name: "Sun NXT", brand: { bg: "#111111", fg: "#f7b500" }, web: "https://www.sunnxt.com/", regions: ["IN"], drm: true },
  { id: "aha", name: "aha", brand: { bg: "#ff6c00", fg: "#ffffff" }, web: "https://www.aha.video/", regions: ["IN"], drm: true },
  { id: "hoichoi", name: "hoichoi", brand: { bg: "#0b0b0b", fg: "#e30613" }, web: "https://www.hoichoi.tv/", regions: ["IN"], drm: true },
];

export interface FreeProviderInfo {
  id: string;
  name: string;
  category: ProviderCategory;
  access: "free" | "free-with-ads";
  web: string;
  description: string;
  /** "integrated" = MonitorOS lists and plays titles itself; "launcher" = opens the official site. */
  integration: "integrated" | "launcher";
  rights: string;
}

export const FREE_PROVIDERS: FreeProviderInfo[] = [
  {
    id: "internet-archive",
    name: "Internet Archive",
    category: "public-domain",
    access: "free",
    web: "https://archive.org/details/feature_films",
    description: "Feature films marked public domain by their uploaders.",
    integration: "integrated",
    rights: "Public-domain mark / CC0 declared on each item. Verify before redistribution.",
  },
  {
    id: "mxplayer",
    name: "Amazon MX Player",
    category: "free-avod",
    access: "free-with-ads",
    web: "https://www.mxplayer.in/",
    description: "Free, ad-supported Indian movies and originals.",
    integration: "launcher",
    rights: "Licensed by the provider; plays in the official site/app.",
  },
  {
    id: "youtube-movies",
    name: "YouTube (official channels)",
    category: "free-avod",
    access: "free-with-ads",
    web: "https://www.youtube.com/feed/storefront",
    description: "Free movies published by rights-holder channels.",
    integration: "launcher",
    rights: "Uploaded by rights holders; plays in YouTube.",
  },
  {
    id: "waves",
    name: "WAVES (Prasar Bharati)",
    category: "public-broadcast",
    access: "free",
    web: "https://waves.pb.gov.in/",
    description: "India's public broadcaster: DD channels, live TV and archives.",
    integration: "launcher",
    rights: "Public broadcaster; plays in the official site/app.",
  },
];

/** Build the hand-off URL for a title on a service. Falls back to the service home. */
export function launchUrl(service: SubscriptionService, item?: Pick<MediaItem, "title" | "availability">): string {
  const deep = item?.availability.find((a) => a.providerId === service.id)?.deepLink;
  const url = deep ?? (item && service.searchUrl ? service.searchUrl.replace("{title}", encodeURIComponent(item.title)) : service.web);
  return assertSafeUrl(url, "external").toString();
}

export function servicesForRegion(region: string): SubscriptionService[] {
  return SUBSCRIPTION_SERVICES.filter((s) => s.regions.includes("*") || s.regions.includes(region.toUpperCase()));
}
