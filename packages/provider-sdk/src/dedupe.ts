import type { Availability, MediaItem } from "@monitoros/contracts";

/** Lowercase, strip accents/punctuation/articles for fuzzy title matching. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .trim();
}

function fuzzyKey(item: MediaItem): string {
  const kind = item.type === "movie" ? "m" : "s";
  return `${kind}|${normalizeTitle(item.title)}|${item.year ?? "?"}`;
}

function mergeAvailability(a: Availability[], b: Availability[]): Availability[] {
  const seen = new Map(a.map((x) => [`${x.providerId}|${x.access}`, x]));
  for (const x of b) if (!seen.has(`${x.providerId}|${x.access}`)) seen.set(`${x.providerId}|${x.access}`, x);
  return [...seen.values()];
}

function mergeTwo(a: MediaItem, b: MediaItem): MediaItem {
  return {
    ...a,
    ids: { ...b.ids, ...a.ids, provider: { ...b.ids.provider, ...a.ids.provider } },
    year: a.year ?? b.year,
    description: a.description || b.description,
    genres: a.genres.length ? a.genres : b.genres,
    languages: [...new Set([...a.languages, ...b.languages])],
    rating: a.rating ?? b.rating,
    artwork: {
      poster: a.artwork.poster ?? b.artwork.poster,
      backdrop: a.artwork.backdrop ?? b.artwork.backdrop,
      logo: a.artwork.logo ?? b.artwork.logo,
      palette: a.artwork.palette,
    },
    episodes: a.episodes ?? b.episodes,
    seasons: a.seasons ?? b.seasons,
    availability: mergeAvailability(a.availability, b.availability),
    tags: [...new Set([...(a.tags ?? []), ...(b.tags ?? [])])],
  };
}

/**
 * Merge items from several providers into one list without duplicates.
 * Pass 1 merges on stable ids (IMDb/TMDB). Pass 2 merges id-less items on
 * (type, normalized title, year) — only when the year is known on both sides,
 * so remakes with the same title are not collapsed.
 */
export function mergeResults(items: MediaItem[]): MediaItem[] {
  const byId = new Map<string, MediaItem>();
  const order: string[] = [];
  for (const item of items) {
    const key = item.ids.imdb ? `imdb:${item.ids.imdb}` : item.ids.tmdb !== undefined ? `tmdb:${item.type}:${item.ids.tmdb}` : `id:${item.id}`;
    const existing = byId.get(key);
    if (existing) byId.set(key, mergeTwo(existing, item));
    else {
      byId.set(key, item);
      order.push(key);
    }
  }
  const byFuzzy = new Map<string, string>();
  const out: MediaItem[] = [];
  const indexOf = new Map<string, number>();
  for (const key of order) {
    const item = byId.get(key)!;
    const fk = item.year ? fuzzyKey(item) : null;
    const target = fk ? byFuzzy.get(fk) : undefined;
    if (target !== undefined) {
      const idx = indexOf.get(target)!;
      out[idx] = mergeTwo(out[idx]!, item);
    } else {
      if (fk) byFuzzy.set(fk, key);
      indexOf.set(key, out.length);
      out.push(item);
    }
  }
  return out;
}
