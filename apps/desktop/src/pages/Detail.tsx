import { useEffect, useMemo, useState } from "react";
import type { MediaItem } from "@monitoros/contracts";
import { SUBSCRIPTION_SERVICES, accessLabel, launchUrl } from "@monitoros/metadata";
import type { RankedSource } from "@monitoros/provider-sdk";
import { cinemeta } from "../lib/catalog";
import { findSources, startPlayback } from "../lib/playback";
import { useApp } from "../store/app";
import { CheckIcon, ExternalIcon, PlayIcon, PlusIcon } from "../components/icons";

export function DetailPage({ item: initial }: { item: MediaItem }) {
  const { watchlist, toggleWatchlist, settings, navigate, launchService } = useApp();
  const [item, setItem] = useState(initial);
  const [sources, setSources] = useState<RankedSource[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [season, setSeason] = useState(1);

  useEffect(() => {
    let alive = true;
    setItem(initial);
    // Catalog cards can omit episode lists; fetch details for any IMDb title, not just seeds.
    if (initial.ids.imdb) void cinemeta.details(initial).then(full => { if (alive) setItem(full); }).catch(() => {});
    return () => { alive = false; };
  }, [initial]);

  useEffect(() => {
    let alive = true;
    setSources(null);
    findSources(item, item.type !== "movie" && item.episodes?.length ? { season, episode: 1 } : undefined)
      .then((r) => {
        if (!alive) return;
        setSources(r.ranked);
        setErrors(r.errors);
      })
      .catch(() => alive && setSources([]));
    return () => {
      alive = false;
    };
  }, [item, season]);

  const inList = watchlist.some((w) => w.id === item.id);
  const access = accessLabel(item, settings.subscriptions);
  const playable = sources?.filter((s) => s.playable) ?? [];
  const blocked = sources?.filter((s) => !s.playable) ?? [];
  const seasons = useMemo(() => [...new Set(item.episodes?.map((e) => e.season) ?? [])], [item.episodes]);
  const myServices = SUBSCRIPTION_SERVICES.filter((s) => settings.subscriptions.includes(s.id));
  const otherServices = SUBSCRIPTION_SERVICES.filter((s) => !settings.subscriptions.includes(s.id));

  return (
    <div className="relative min-h-full pb-16">
      <div className="absolute inset-x-0 top-0 h-[35rem] overflow-hidden">
        {item.artwork.backdrop && <img src={item.artwork.backdrop} alt="" className="h-full w-full object-cover opacity-60" referrerPolicy="no-referrer" />}
        <div className="absolute inset-0 bg-gradient-to-r from-ink-950 via-ink-950/70 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950 to-transparent" />
      </div>
      <div className="relative max-w-[68.75rem] px-14 pt-20">
        {item.artwork.logo ? <img src={item.artwork.logo} alt={item.title} className="max-h-36 max-w-[32.5rem] object-contain" referrerPolicy="no-referrer" /> : <h1 className="text-6xl font-extrabold text-white">{item.title}</h1>}
        <div className="mt-5 flex flex-wrap items-center gap-3 text-xl text-white/80">
          {item.year && <span>{item.year}</span>}
          {item.runtimeMinutes && <span>· {item.runtimeMinutes} min</span>}
          {item.seasons && <span>· {item.seasons} seasons</span>}
          {item.genres.slice(0, 3).map((g) => <span key={g} className="rounded-full bg-white/10 px-3 py-0.5 text-base">{g}</span>)}
          {item.rating && <span className="font-semibold text-amber-400">★ {item.rating.value.toFixed(1)} <span className="text-sm text-white/60">{item.rating.source}</span></span>}
          <span className={`rounded-full px-3 py-0.5 text-base ${access.tone === "free" ? "bg-emerald-500/20 text-emerald-300" : access.tone === "unknown" ? "bg-white/10 text-white/60" : "bg-accent/20 text-accent-soft"}`}>{access.label}</span>
        </div>
        {item.description && <p className="mt-5 line-clamp-4 max-w-[53.75rem] text-[1.3125rem] leading-relaxed text-white/85">{item.description}</p>}
        {!!item.cast?.length && <p className="mt-3 text-lg text-white/55">Starring {item.cast.slice(0, 4).join(", ")}</p>}
        {!!item.directors?.length && <p className="text-lg text-white/55">Directed by {item.directors.join(", ")}</p>}

        <div className="mt-8 flex gap-4">
          {playable[0] && (
            <button data-nav-row="detail-actions" autoFocus onClick={() => void startPlayback(item, playable[0]!.source)} className="tv-focus flex items-center gap-3 rounded-xl bg-white px-8 py-4 text-[1.375rem] font-semibold text-black">
              <PlayIcon className="h-6 w-6" /> Play
            </button>
          )}
          <button data-nav-row="detail-actions" autoFocus={!playable[0]} onClick={() => toggleWatchlist(item)} className="tv-focus flex items-center gap-3 rounded-xl border border-white/30 bg-black/30 px-8 py-4 text-[1.375rem] text-white">
            {inList ? <CheckIcon className="h-6 w-6" /> : <PlusIcon className="h-6 w-6" />} {inList ? "In Watchlist" : "Watchlist"}
          </button>
        </div>

        {seasons.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-3 text-2xl font-bold text-white">Episodes</h2>
            <div className="mb-4 flex gap-2">
              {seasons.map((s) => (
                <button key={s} data-nav-row="seasons" onClick={() => setSeason(s)} className={`tv-focus rounded-full px-5 py-2 text-lg ${s === season ? "bg-white text-black" : "bg-white/10 text-white"}`}>Season {s}</button>
              ))}
            </div>
            <div className="no-scrollbar flex gap-4 overflow-x-auto py-2">
              {item.episodes!.filter((e) => e.season === season).map((e) => (
                <div key={e.id} className="w-[16.25rem] shrink-0 rounded-xl bg-ink-800 p-3 text-white/85">
                  <div className="text-sm text-white/50">E{e.episode}</div>
                  <div className="line-clamp-2 text-lg">{e.title || `Episode ${e.episode}`}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-10">
          <h2 className="text-2xl font-bold text-white">Where to watch</h2>
          <p className="mt-1 max-w-[51.25rem] text-lg text-white/55">
            MonitorOS doesn't guess which service carries a title in your region. Open one of your services to find it there — you stay signed in through its official site or app.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {[...myServices, ...otherServices].map((s) => (
              <button key={s.id} data-nav-row="where" onClick={() => void launchService(launchUrl(s, item), s.name)} className={`tv-focus flex items-center gap-2 rounded-xl px-5 py-3 text-lg font-semibold ${myServices.includes(s) ? "bg-white/15 text-white" : "bg-white/5 text-white/60"}`}>
                {s.name} <ExternalIcon className="h-4 w-4" />
              </button>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-2xl font-bold text-white">Sources</h2>
          {sources === null && <p className="mt-2 text-lg text-white/50">Checking providers…</p>}
          {sources?.length === 0 && <p className="mt-2 text-lg text-white/50">No free or add-on sources for this title. {settings.allowUnverified ? "" : "Unverified add-on sources are hidden (Settings › Add-ons)."}</p>}
          <div className="mt-3 flex flex-col gap-2">
            {playable.map((r) => (
              <button key={r.source.id} data-nav-row={`src-${r.source.id}`} onClick={() => void startPlayback(item, r.source)} className="tv-focus flex items-center justify-between rounded-xl bg-ink-800 px-5 py-4 text-left text-white">
                <span className="text-lg">{r.source.title}</span>
                <span className="text-white/50">{r.reasons.join(" · ")}</span>
              </button>
            ))}
            {blocked.map((r) => (
              <div key={r.source.id} className="flex items-center justify-between rounded-xl bg-ink-900 px-5 py-4 text-white/40">
                <span>{r.source.title}</span>
                <span>{r.blockedReason}</span>
              </div>
            ))}
            {errors.map((e) => <p key={e} className="text-sm text-red-300/70">{e}</p>)}
          </div>
        </section>
        <button data-nav-row="detail-back" onClick={() => navigate({ name: "home" })} className="tv-focus mt-10 rounded-xl bg-white/10 px-6 py-3 text-lg text-white">Back to Home</button>
      </div>
    </div>
  );
}
