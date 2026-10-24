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

const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);

/**
 * Common spelling variants of a query, for titles whose spelling differs
 * from how people type them (e.g. "big boss" → "bigg boss"). Returns at
 * most one normalised variant, never the query itself.
 */
export function queryVariants(query: string): string[] {
  const words = normalizeTitle(query).split(" ").filter(Boolean);
  if (!words.length) return [];
  // Consonant-vowel-consonant words get their last letter doubled, as in
  // romanised titles ("big" → "bigg"); not plurals or soft endings.
  const cvc = (w: string) => w.length === 3 && !VOWELS.has(w[0]!) && VOWELS.has(w[1]!) && !VOWELS.has(w[2]!) && !"swx".includes(w[2]!);
  const doubled = words.map((w) => (cvc(w) ? w + w.at(-1) : w)).join(" ");
  return doubled === words.join(" ") ? [] : [doubled];
}

/** Levenshtein distance ≤ 1 (one typo / one doubled letter). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Local filter + rank over an already-fetched result set (actor/director/genre/lang/year/provider/free). */
export function filterAndRank(items: MediaItem[], query: string, f: SearchFilters = {}): MediaItem[] {
  const q = normalizeTitle(query);
  const terms = q.split(" ").filter(Boolean);
  const phrases = [q, ...queryVariants(query)];
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
      const titleWords = title.split(" ");
      let score = 0;
      if (phrases.includes(title)) score += 100;
      else if (phrases.some((p) => title.startsWith(p))) score += 60;
      else if (phrases.some((p) => title.includes(p))) score += 40;
      let matched = 0;
      for (const t of terms) {
        const inTitle = title.includes(t) || (t.length >= 3 && titleWords.some((w) => w.length >= 3 && withinOneEdit(w, t)));
        const hit = inTitle || people.includes(t) || genres.includes(t) || String(item.year) === t;
        if (inTitle) score += 10;
        if (people.includes(t)) score += 8;
        if (genres.includes(t)) score += 4;
        if (String(item.year) === t) score += 6;
        if (hit) matched++;
      }
      // Titles that match every word beat those matching only some ("big boss" ≫ "Big Mouth").
      if (terms.length > 1 && matched === terms.length) score += 25;
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
