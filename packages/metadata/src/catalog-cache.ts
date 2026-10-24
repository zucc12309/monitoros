import type { MediaItem } from "@monitoros/contracts";

export const CATALOG_TTL = 6 * 60 * 60 * 1000;
const MAX_STALE = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
export interface CatalogPage { items: MediaItem[]; nextSkip: number | null; stale?: boolean }
export interface CatalogStorage { load(): Promise<unknown>; save(value: unknown): Promise<void> }
interface Entry { at: number; page: CatalogPage }

/** Bounded persistent cache; failed refreshes never extend a cached page's lifetime. */
export class CatalogCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<CatalogPage>>();
  private ready?: Promise<void>;
  private writes = Promise.resolve();
  constructor(private storage?: CatalogStorage, private now = Date.now) {}

  private hydrate() {
    return this.ready ??= (async () => {
      try {
        const data = await this.storage?.load() as { version?: number; entries?: [string, Entry][] } | undefined;
        if (data?.version !== 1 || !Array.isArray(data.entries)) return;
        for (const pair of data.entries.slice(-32)) {
          if (!Array.isArray(pair) || pair.length !== 2) continue;
          const [key, entry] = pair;
          if (typeof key !== "string" || !entry || !Number.isFinite(entry.at) || entry.at > this.now() || this.now() - entry.at > MAX_STALE) continue;
          const p = entry.page;
          if (!p || !Array.isArray(p.items) || p.items.length > 100 || !(p.nextSkip === null || Number.isSafeInteger(p.nextSkip) && p.nextSkip >= 0)) continue;
          if (!p.items.every(i => i && typeof i.id === "string" && typeof i.title === "string" && i.artwork && Array.isArray(i.genres) && Array.isArray(i.languages) && Array.isArray(i.availability))) continue;
          this.entries.set(key, entry);
        }
      } catch { /* An unavailable/corrupt disk cache must not prevent live loading. */ }
    })();
  }

  async peek(key: string): Promise<CatalogPage | undefined> {
    await this.hydrate();
    const e = this.entries.get(key);
    if (!e || this.now() - e.at > MAX_STALE) return;
    return { ...e.page, stale: this.now() - e.at >= CATALOG_TTL };
  }

  async get(key: string, fetch: () => Promise<CatalogPage>): Promise<CatalogPage> {
    await this.hydrate();
    const cached = await this.peek(key);
    if (cached && !cached.stale) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = (async () => {
      try {
        const page = await fetch();
        this.entries.delete(key);
        this.entries.set(key, { at: this.now(), page });
        while (this.entries.size > 32 || new TextEncoder().encode(JSON.stringify([...this.entries])).byteLength > MAX_BYTES) {
          this.entries.delete(this.entries.keys().next().value!);
        }
        const snapshot = { version: 1, entries: [...this.entries] };
        this.writes = this.writes.then(() => this.storage?.save(snapshot)).then(() => {}).catch(() => {});
        await this.writes;
        return page;
      } catch (error) {
        if (cached) return { ...cached, stale: true };
        throw error;
      }
    })();
    this.pending.set(key, request);
    try { return await request; } finally { this.pending.delete(key); }
  }
}
