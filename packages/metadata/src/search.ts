import type { AccessModel, MediaItem, MediaType } from "@monitoros/contracts";
import { normalizeTitle } from "@monitoros/provider-sdk";

export interface SearchFilters {
  types?: MediaType[];
  genres?: string[];
  languages?: string[];
  yearFrom?: number;
  yearTo?: number;
  providers?: string[];
  freeOnly?: boolean;
}

const FREE: AccessModel[] = ["free", "free-with-ads", "local"];

/** Local filter + rank over an already-fetched result set (actor/director/genre/lang/year/provider/free). */
export function filterAndRank(items: MediaItem[], query: string, f: SearchFilters = {}): MediaItem[] {
  const q = normalizeTitle(query);
  const terms = q.split(" ").filter(Boolean);
  const scored = items
    .filter((i) => !f.types?.length || f.types.includes(i.type))
    .filter((i) => !f.genres?.length || i.genres.some((g) => f.genres!.some((x) => x.toLowerCase() === g.toLowerCase())))
    .filter((i) => !f.languages?.length || i.languages.some((l) => f.languages!.includes(l)))
    .filter((i) => f.yearFrom === undefined || (i.year ?? 0) >= f.yearFrom)
    .filter((i) => f.yearTo === undefined || (i.year ?? 9999) <= f.yearTo)
    .filter((i) => !f.providers?.length || i.availability.some((a) => f.providers!.includes(a.providerId)))
    .filter((i) => !f.freeOnly || i.availability.some((a) => FREE.includes(a.access)))
    .map((item) => {
      if (!terms.length) return { item, score: 1 };
      const title = normalizeTitle(item.title);
      const people = [...(item.cast ?? []), ...(item.directors ?? [])].map(normalizeTitle).join(" | ");
      const genres = item.genres.map(normalizeTitle).join(" ");
      let score = 0;
      if (title === q) score += 100;
      else if (title.startsWith(q)) score += 60;
      else if (title.includes(q)) score += 40;
      for (const t of terms) {
        if (title.includes(t)) score += 10;
        if (people.includes(t)) score += 8;
        if (genres.includes(t)) score += 4;
        if (String(item.year) === t) score += 6;
      }
      return { item, score };
    })
    .filter((x) => x.score > 0);
  return scored.sort((a, b) => b.score - a.score).map((x) => x.item);
}

/** Free / paid label for the UI. Unknown is shown as unknown, never guessed. */
export function accessLabel(item: MediaItem, subscriptions: string[]): { label: string; tone: "free" | "included" | "paid" | "unknown" } {
  const av = item.availability;
  if (av.some((a) => a.access === "local")) return { label: "On this device", tone: "free" };
  if (av.some((a) => a.access === "free")) return { label: "Free", tone: "free" };
  if (av.some((a) => a.access === "free-with-ads")) return { label: "Free with ads", tone: "free" };
  if (av.some((a) => a.access === "subscription" && subscriptions.includes(a.providerId))) return { label: "Included", tone: "included" };
  if (av.some((a) => a.access === "subscription")) return { label: "Subscription", tone: "paid" };
  if (av.some((a) => a.access === "rent-or-buy")) return { label: "Rent or buy", tone: "paid" };
  return { label: "Availability unknown", tone: "unknown" };
}
