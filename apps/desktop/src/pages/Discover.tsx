import { useEffect, useRef, useState } from "react";
import type { MediaItem, MediaType } from "@monitoros/contracts";
import { FREE_PROVIDERS, SUBSCRIPTION_SERVICES, accessLabel, launchUrl } from "@monitoros/metadata";
import { PosterCard } from "../components/Media";
import { SectionTitle } from "../components/Chrome";
import { CheckIcon, ExternalIcon } from "../components/icons";
import { searchAll, useFreeItems, useTypeItems } from "../lib/catalog";
import { listen } from "../lib/bridge";
import { useApp } from "../store/app";
import { useOpenItem } from "./Home";

function Grid({ items, row, badge }: { items: MediaItem[]; row: string; badge?: (i: MediaItem) => string | undefined }) {
  const open = useOpenItem();
  // One nav row per visual line keeps up/down deterministic in a wrapping grid.
  const perLine = 8;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-8 pr-10">
      {items.map((i, idx) => (
        <PosterCard key={i.id} item={i} row={`${row}-${Math.floor(idx / perLine)}`} onOpen={open} badge={badge?.(i)} />
      ))}
    </div>
  );
}

export function BrowsePage({ kind }: { kind: "movie" | "series" | "anime" }) {
  const items = useTypeItems(kind as MediaType);
  const title = kind === "movie" ? "Movies" : kind === "series" ? "Series" : "Anime";
  return (
    <div className="pb-16 pl-10 pt-2">
      <SectionTitle>{title}</SectionTitle>
      <p className="-mt-2 mb-6 text-lg text-white/50">Editor's picks with live metadata from Cinemeta. Use Search for everything else.</p>
      <Grid items={items} row={`browse-${kind}`} />
    </div>
  );
}

export function SearchPage({ initial }: { initial?: string }) {
  const [q, setQ] = useState(initial ?? "");
  const [freeOnly, setFreeOnly] = useState(false);
  const [type, setType] = useState<"all" | "movie" | "series" | "anime">("all");
  const [res, setRes] = useState<{ items: MediaItem[]; errors: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const subs = useApp((s) => s.settings.subscriptions);

  useEffect(() => input.current?.focus(), []);
  // Text typed on the iPhone remote lands here.
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<{ type: string; value?: string }>("remote://command", (c) => c.type === "text" && setQ((v) => v + (c.value ?? ""))).then((u) => (un = u));
    return () => un?.();
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setRes(null);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      searchAll(query, freeOnly)
        .then(setRes)
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(t);
  }, [q, freeOnly]);

  const items = (res?.items ?? []).filter((i) => type === "all" || i.type === type);
  return (
    <div className="pb-16 pl-10 pt-2">
      <input
        ref={input}
        data-nav-row="search-input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search movies, series, actors, directors, genres…"
        className="tv-focus w-[min(900px,90%)] rounded-2xl bg-ink-800 px-7 py-5 text-2xl text-white placeholder:text-white/35 outline-none"
        aria-label="Search"
      />
      <div className="mt-5 flex flex-wrap gap-3">
        {(["all", "movie", "series", "anime"] as const).map((t) => (
          <button key={t} data-nav-row="search-filters" onClick={() => setType(t)} className={`tv-focus rounded-full px-5 py-2 text-lg capitalize ${type === t ? "bg-white text-black" : "bg-white/10 text-white"}`}>{t === "all" ? "All" : t}</button>
        ))}
        <button data-nav-row="search-filters" onClick={() => setFreeOnly((v) => !v)} className={`tv-focus rounded-full px-5 py-2 text-lg ${freeOnly ? "bg-emerald-500 text-white" : "bg-white/10 text-white"}`}>Free only</button>
      </div>
      <div className="mt-8">
        {loading && <p className="text-lg text-white/50">Searching…</p>}
        {res && !loading && items.length === 0 && <p className="text-lg text-white/50">No results{freeOnly ? " with verified free availability" : ""}.</p>}
        <Grid items={items} row="search-results" badge={(i) => { const a = accessLabel(i, subs); return a.tone === "free" ? a.label : undefined; }} />
        {res?.errors.map((e) => <p key={e} className="mt-2 text-sm text-red-300/70">{e}</p>)}
      </div>
    </div>
  );
}

export function AppsPage() {
  const { settings, updateSettings, launchService } = useApp();
  const toggle = (id: string) =>
    updateSettings({ subscriptions: settings.subscriptions.includes(id) ? settings.subscriptions.filter((s) => s !== id) : [...settings.subscriptions, id] });
  return (
    <div className="pb-16 pl-10 pt-2 pr-10">
      <SectionTitle>Streaming Apps</SectionTitle>
      <p className="-mt-2 mb-6 max-w-[900px] text-lg text-white/50">Apps open in their official website (or app) so DRM, sign-in and 4K rules stay with the provider. MonitorOS never asks for your streaming passwords.</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
        {SUBSCRIPTION_SERVICES.map((s, idx) => {
          const mine = settings.subscriptions.includes(s.id);
          const row = `apps-${Math.floor(idx / 4)}`;
          return (
            <div key={s.id} className="rounded-2xl bg-ink-800 p-4">
              <button data-nav-row={row} onClick={() => void launchService(launchUrl(s), s.name)} className="tv-focus grid h-24 w-full place-items-center rounded-xl text-3xl font-extrabold" style={{ background: s.brand.accent ? `linear-gradient(120deg, ${s.brand.bg}, ${s.brand.accent})` : s.brand.bg, color: s.brand.fg }}>
                {s.name}
              </button>
              <div className="mt-3 flex items-center justify-between text-white/70">
                <span className="text-sm">{s.regions.includes("*") ? "Global" : s.regions.join(", ")}{s.drm ? " · DRM" : ""}</span>
                <button data-nav-row={row} onClick={() => toggle(s.id)} className={`tv-focus flex items-center gap-2 rounded-full px-4 py-1.5 text-sm ${mine ? "bg-accent text-white" : "bg-white/10"}`}>
                  {mine && <CheckIcon className="h-4 w-4" />} {mine ? "Subscribed" : "I subscribe"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FreePage() {
  const { items, loading, error } = useFreeItems();
  const launchService = useApp((s) => s.launchService);
  return (
    <div className="pb-16 pl-10 pt-2">
      <SectionTitle>Watch Free</SectionTitle>
      <p className="-mt-2 mb-6 max-w-[900px] text-lg text-white/50">Only sources with a stated right to stream. Each title shows how it is free: public domain, free with ads, or public broadcasting.</p>
      <div className="mb-10 flex flex-wrap gap-4 pr-10">
        {FREE_PROVIDERS.map((p) => (
          <button key={p.id} data-nav-row="free-providers" onClick={() => void launchService(p.web, p.name)} className="tv-focus w-[330px] rounded-2xl bg-ink-800 p-5 text-left text-white">
            <div className="flex items-center justify-between">
              <span className="text-xl font-bold">{p.name}</span>
              <span className={`rounded-full px-3 py-0.5 text-sm ${p.access === "free" ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}`}>{p.access === "free" ? "Free" : "Free with ads"}</span>
            </div>
            <p className="mt-2 text-white/60">{p.description}</p>
            <p className="mt-2 flex items-center gap-1 text-sm text-white/40">{p.integration === "integrated" ? "Plays in MonitorOS" : <>Opens official site <ExternalIcon className="h-3.5 w-3.5" /></>}</p>
          </button>
        ))}
      </div>
      <SectionTitle>Public-domain films · Internet Archive</SectionTitle>
      {loading && <p className="text-lg text-white/50">Loading…</p>}
      {error && <p className="text-lg text-red-300/80">Couldn't load Internet Archive: {error}</p>}
      <Grid items={items} row="free-grid" badge={() => "Public domain"} />
      <p className="mt-6 pr-10 text-sm text-white/35">Licence status is declared by each item's uploader on archive.org and re-checked before playback.</p>
    </div>
  );
}
