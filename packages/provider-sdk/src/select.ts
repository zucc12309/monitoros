import type { PlaybackSource } from "@monitoros/contracts";

export interface SourcePreferences {
  subscriptions: string[]; // provider ids the user pays for
  preferFree: boolean;
  region: string; // ISO alpha-2
  languages: string[];
  maxQuality: "720p" | "1080p" | "2160p";
  hevcSupported: boolean;
  /** When false (default) unverified add-on sources are hidden, not just ranked low. */
  allowUnverified: boolean;
}

export interface RankedSource {
  source: PlaybackSource;
  score: number;
  reasons: string[];
  playable: boolean;
  blockedReason?: string;
}

const QUALITY_RANK = { "480p": 1, "720p": 2, "1080p": 3, "2160p": 4, unknown: 0 } as const;

/**
 * Rank sources per spec §9: subscriptions first, then verified free sources,
 * then quality/codec/region/language. Never silently promotes unverified sources.
 */
export function rankSources(sources: PlaybackSource[], prefs: SourcePreferences): RankedSource[] {
  const ranked = sources.map((source): RankedSource => {
    const reasons: string[] = [];
    let score = 0;
    let blockedReason: string | undefined;

    if (source.regions?.length && !source.regions.includes(prefs.region.toUpperCase())) {
      blockedReason = `not available in ${prefs.region}`;
    }
    if (!prefs.allowUnverified && (source.provenance === "unverified" || source.provenance === "third-party-addon")) {
      blockedReason ??= "unverified source (enable in Settings › Add-ons to show)";
    }
    if (source.codec === "hevc" && !prefs.hevcSupported) {
      blockedReason ??= "HEVC decoding not available on this device";
    }

    if (source.access === "subscription" && prefs.subscriptions.includes(source.providerId)) {
      score += 1000;
      reasons.push("included in your subscription");
    } else if (source.access === "subscription") {
      score -= 200;
      reasons.push("requires a subscription you have not added");
    }
    if (source.access === "free" || source.access === "free-with-ads") {
      score += prefs.preferFree ? 800 : 300;
      reasons.push(source.access === "free" ? "free" : "free with ads");
    }
    if (source.access === "local") {
      score += 900;
      reasons.push("on this device");
    }
    if (source.access === "rent-or-buy") score -= 300;

    if (source.provenance === "official-provider" || source.provenance === "public-domain" || source.provenance === "creative-commons") {
      score += 150;
      reasons.push(source.provenance.replace("-", " "));
    }

    const q = QUALITY_RANK[source.quality ?? "unknown"];
    const cap = QUALITY_RANK[prefs.maxQuality];
    score += q <= cap ? q * 20 : cap * 20 - 10;

    if (source.languages?.some((l) => prefs.languages.includes(l))) {
      score += 50;
      reasons.push("in your language");
    }
    if (source.kind === "external-browser" || source.kind === "external-app") score -= 20;

    return { source, score, reasons, playable: !blockedReason, blockedReason };
  });
  return ranked.sort((a, b) => Number(b.playable) - Number(a.playable) || b.score - a.score);
}

export function bestSource(sources: PlaybackSource[], prefs: SourcePreferences): PlaybackSource | undefined {
  return rankSources(sources, prefs).find((r) => r.playable)?.source;
}
