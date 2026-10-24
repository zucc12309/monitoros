/**
 * Curated home-screen rows. Only identifiers and editorial tags live here;
 * titles, artwork, ratings and descriptions come from Cinemeta at runtime.
 * Every IMDb id below was verified against v3-cinemeta.strem.io on 2026-10-24.
 *
 * Deliberately NO provider availability claims: which service streams a title
 * in India changes monthly, and stale claims would mislead users (spec §7).
 */
import type { MediaType } from "@monitoros/contracts";

export interface SeedEntry {
  imdb: string;
  type: Extract<MediaType, "movie" | "series" | "anime">;
  title: string; // offline fallback only
  year: number;
  tags: string[];
  languages: string[];
}

const m = (imdb: string, title: string, year: number, tags: string[], languages = ["en"]): SeedEntry => ({ imdb, type: "movie", title, year, tags, languages });
const s = (imdb: string, title: string, year: number, tags: string[], languages = ["en"]): SeedEntry => ({ imdb, type: "series", title, year, tags, languages });
const a = (imdb: string, title: string, year: number, tags: string[] = []): SeedEntry => ({ imdb, type: "anime", title, year, tags: ["anime", ...tags], languages: ["ja"] });

export const SEED: SeedEntry[] = [
  m("tt15239678", "Dune: Part Two", 2024, ["hero", "trending", "hollywood"]),
  m("tt12735488", "Kalki 2898 AD", 2024, ["hero", "trending", "india", "south"], ["te", "hi"]),
  m("tt6263850", "Deadpool & Wolverine", 2024, ["hero", "trending", "hollywood"]),
  m("tt27510174", "Stree 2", 2024, ["hero", "trending", "india", "hindi"], ["hi"]),
  m("tt9218128", "Gladiator II", 2024, ["hero", "trending", "hollywood"]),
  m("tt16539454", "Pushpa: The Rule - Part 2", 2024, ["trending", "india", "south"], ["te", "hi"]),
  m("tt13818368", "Fighter", 2024, ["trending", "india", "hindi"], ["hi"]),
  m("tt15398776", "Oppenheimer", 2023, ["hollywood", "recent"]),
  m("tt15354916", "Jawan", 2023, ["india", "hindi"], ["hi"]),
  m("tt13751694", "Animal", 2023, ["india", "hindi"], ["hi"]),
  m("tt23849204", "12th Fail", 2023, ["india", "hindi", "recent"], ["hi"]),
  m("tt21626284", "Laapataa Ladies", 2024, ["india", "hindi", "recent"], ["hi"]),
  m("tt12844910", "Pathaan", 2023, ["hindi"], ["hi"]),
  m("tt8178634", "RRR", 2022, ["india", "south"], ["te"]),
  m("tt10698680", "K.G.F: Chapter 2", 2022, ["south"], ["kn"]),
  m("tt26458038", "Manjummel Boys", 2024, ["south", "recent"], ["ml"]),
  m("tt15654328", "Leo", 2023, ["south"], ["ta"]),
  m("tt13927994", "Salaar", 2023, ["south"], ["te"]),
  m("tt22022452", "Inside Out 2", 2024, ["hollywood", "recent"]),
  m("tt12037194", "Furiosa: A Mad Max Saga", 2024, ["hollywood"]),
  m("tt1262426", "Wicked", 2024, ["hollywood", "recent"]),
  s("tt1190634", "The Boys", 2019, ["trending-tv"]),
  s("tt6473300", "Mirzapur", 2018, ["trending-tv", "india"], ["hi"]),
  s("tt12004706", "Panchayat", 2020, ["trending-tv", "india"], ["hi"]),
  s("tt2788316", "Shōgun", 2024, ["trending-tv"]),
  s("tt11198330", "House of the Dragon", 2022, ["trending-tv"]),
  s("tt9544034", "The Family Man", 2019, ["trending-tv", "india"], ["hi"]),
  s("tt12392504", "Scam 1992", 2020, ["india"], ["hi"]),
  s("tt4574334", "Stranger Things", 2016, ["trending-tv"]),
  a("tt2560140", "Attack on Titan", 2013),
  a("tt9335498", "Demon Slayer", 2019),
  a("tt12343534", "Jujutsu Kaisen", 2020),
  a("tt0388629", "One Piece", 1999),
  a("tt22248376", "Frieren: Beyond Journey's End", 2023),
  { imdb: "tt5311514", type: "movie", title: "Your Name.", year: 2016, tags: ["anime"], languages: ["ja"] },
  { imdb: "tt0245429", type: "movie", title: "Spirited Away", year: 2001, tags: ["anime"], languages: ["ja"] },
];

export interface HomeRow {
  id: string;
  title: string;
  tag?: string;
  kind: "media" | "continue" | "apps" | "free" | "watchlist" | "local" | "live";
}

export const HOME_ROWS: HomeRow[] = [
  { id: "continue", title: "Continue Watching", kind: "continue" },
  { id: "apps", title: "Your Apps", kind: "apps" },
  { id: "trending", title: "Trending Movies in India", tag: "trending", kind: "media" },
  { id: "trending-tv", title: "Trending Series", tag: "trending-tv", kind: "media" },
  { id: "free", title: "Free to Watch", kind: "free" },
  { id: "hindi", title: "Hindi Movies", tag: "hindi", kind: "media" },
  { id: "south", title: "South Indian Cinema", tag: "south", kind: "media" },
  { id: "hollywood", title: "Hollywood", tag: "hollywood", kind: "media" },
  { id: "india", title: "Popular in India", tag: "india", kind: "media" },
  { id: "anime", title: "Anime", tag: "anime", kind: "media" },
  { id: "recent", title: "Recently Added", tag: "recent", kind: "media" },
  { id: "watchlist", title: "My Watchlist", kind: "watchlist" },
  { id: "local", title: "Local Library", kind: "local" },
  { id: "live", title: "Live TV", kind: "live" },
];
