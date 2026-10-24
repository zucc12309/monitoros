import type { ContentProvider, EpisodeReference, MediaItem, PlaybackSource, ProviderHealth } from "@monitoros/contracts";
import { withTimeout } from "./http";
import { mergeResults } from "./dedupe";

export interface ProviderError {
  providerId: string;
  message: string;
}

export interface FanOutResult<T> {
  value: T;
  errors: ProviderError[];
}

type Listener = () => void;

/** Holds every registered provider and fans requests out with per-provider timeouts. */
export class ProviderRegistry {
  private providers = new Map<string, { provider: ContentProvider; enabled: boolean }>();
  private health = new Map<string, ProviderHealth>();
  private listeners = new Set<Listener>();

  constructor(private readonly timeoutMs = 8000) {}

  register(provider: ContentProvider, enabled = true): void {
    if (this.providers.has(provider.id)) throw new Error(`provider ${provider.id} already registered`);
    this.providers.set(provider.id, { provider, enabled });
    this.emit();
  }

  unregister(id: string): boolean {
    const removed = this.providers.delete(id);
    this.health.delete(id);
    if (removed) this.emit();
    return removed;
  }

  setEnabled(id: string, enabled: boolean): void {
    const entry = this.providers.get(id);
    if (!entry) throw new Error(`unknown provider ${id}`);
    entry.enabled = enabled;
    this.emit();
  }

  get(id: string): ContentProvider | undefined {
    return this.providers.get(id)?.provider;
  }

  list(): { provider: ContentProvider; enabled: boolean; health?: ProviderHealth }[] {
    return [...this.providers.values()].map((e) => ({ ...e, health: this.health.get(e.provider.id) }));
  }

  enabled(): ContentProvider[] {
    return [...this.providers.values()].filter((e) => e.enabled).map((e) => e.provider);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private async fanOut<T>(targets: ContentProvider[], label: string, fn: (p: ContentProvider) => Promise<T[]>): Promise<FanOutResult<T[]>> {
    const settled = await Promise.allSettled(targets.map((p) => withTimeout(fn(p), this.timeoutMs, `${p.id} ${label}`)));
    const errors: ProviderError[] = [];
    const value: T[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") value.push(...r.value);
      else errors.push({ providerId: targets[i]!.id, message: (r.reason as Error)?.message ?? String(r.reason) });
    });
    return { value, errors };
  }

  async search(query: string): Promise<FanOutResult<MediaItem[]>> {
    const targets = this.enabled().filter((p) => p.capabilities.search);
    const res = await this.fanOut(targets, "search", (p) => p.search(query));
    return { value: mergeResults(res.value), errors: res.errors };
  }

  async streams(item: MediaItem, episode?: EpisodeReference): Promise<FanOutResult<PlaybackSource[]>> {
    const targets = this.enabled().filter((p) => p.capabilities.streams && p.capabilities.types.includes(item.type === "anime" ? "series" : item.type));
    return this.fanOut(targets, "streams", (p) => p.getStreams(item, episode));
  }

  async checkHealth(): Promise<Map<string, ProviderHealth>> {
    await Promise.all(
      [...this.providers.values()].map(async ({ provider }) => {
        try {
          this.health.set(provider.id, await withTimeout(provider.healthCheck(), this.timeoutMs, `${provider.id} health`));
        } catch (e) {
          this.health.set(provider.id, { status: "down", checkedAt: Date.now(), message: (e as Error).message });
        }
      }),
    );
    this.emit();
    return new Map(this.health);
  }
}
