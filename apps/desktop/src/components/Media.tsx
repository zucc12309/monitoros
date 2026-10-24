import { useEffect, useRef, useState } from "react";
import type { MediaItem, SubscriptionService } from "@monitoros/contracts";
import { progressFraction, remainingLabel } from "@monitoros/player";
import { useApp, type ProgressEntry } from "../store/app";
import { CheckIcon, GridIcon, PlayIcon, PlusIcon } from "./icons";
import { SectionTitle } from "./Chrome";

function Art({ item, prefer, className = "" }: { item: MediaItem; prefer: "backdrop" | "poster"; className?: string }) {
  const [failed, setFailed] = useState(false);
  const src = prefer === "backdrop" ? (item.artwork.backdrop ?? item.artwork.poster) : (item.artwork.poster ?? item.artwork.backdrop);
  const [a, b] = item.artwork.palette;
  if (!src || failed) {
    return (
      <div className={`flex items-end p-4 ${className}`} style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}>
        <span className="line-clamp-2 text-xl font-extrabold uppercase leading-tight tracking-wide text-white drop-shadow">{item.title}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      onLoad={(e) => e.currentTarget.classList.remove("opacity-0")}
      className={`object-cover opacity-0 transition-opacity duration-500 ${className}`}
      referrerPolicy="no-referrer"
    />
  );
}

/** Landscape card with logo overlay, like the "Trending" row. */
export function MediaCard({ item, row, onOpen }: { item: MediaItem; row: string; onOpen: (i: MediaItem) => void }) {
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <button data-nav-row={row} onClick={() => onOpen(item)} className="tv-focus card group relative h-[11.25rem] w-[18.125rem] shrink-0 overflow-hidden rounded-xl bg-ink-800 text-left" aria-label={`${item.title}${item.year ? ` (${item.year})` : ""}`}>
      <Art item={item} prefer="backdrop" className="absolute inset-0 h-full w-full" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex h-20 items-end justify-center p-3">
        {item.artwork.logo && !logoFailed ? (
          <img src={item.artwork.logo} alt="" onError={() => setLogoFailed(true)} className="max-h-16 max-w-[85%] object-contain drop-shadow-xl" referrerPolicy="no-referrer" />
        ) : (
          (item.artwork.backdrop || item.artwork.poster) && <span className="line-clamp-2 text-center text-xl font-extrabold uppercase tracking-wide text-white drop-shadow-lg">{item.title}</span>
        )}
      </div>
    </button>
  );
}

export function PosterCard({ item, row, onOpen, badge }: { item: MediaItem; row: string; onOpen: (i: MediaItem) => void; badge?: string }) {
  return (
    <button data-nav-row={row} onClick={() => onOpen(item)} className="tv-focus card relative w-[11.25rem] shrink-0 text-left" aria-label={item.title}>
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-ink-800">
        <Art item={item} prefer="poster" className="h-full w-full" />
        {badge && <span className="absolute left-2 top-2 rounded-md bg-emerald-500/90 px-2 py-0.5 text-xs font-semibold text-white">{badge}</span>}
      </div>
      <div className="mt-2 line-clamp-1 text-base font-medium text-white/90">{item.title}</div>
      <div className="text-sm text-white/50">{item.year ?? ""}</div>
    </button>
  );
}

export function Row({ title, items, row, onOpen, variant = "card", empty }: { title: string; items: MediaItem[]; row: string; onOpen: (i: MediaItem) => void; variant?: "card" | "poster"; empty?: React.ReactNode }) {
  return (
    <section className="mb-9">
      <SectionTitle>{title}</SectionTitle>
      {items.length === 0 ? (
        empty ?? <SkeletonRow variant={variant} />
      ) : (
        <div className="no-scrollbar -my-3 flex gap-5 overflow-x-auto py-3 pl-1 pr-10">
          {items.map((i) => (variant === "card" ? <MediaCard key={i.id} item={i} row={row} onOpen={onOpen} /> : <PosterCard key={i.id} item={i} row={row} onOpen={onOpen} />))}
        </div>
      )}
    </section>
  );
}

export function SkeletonRow({ variant = "card" }: { variant?: "card" | "poster" }) {
  return (
    <div className="flex gap-5 overflow-hidden" aria-hidden>
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className={`shrink-0 animate-pulse rounded-xl bg-ink-800 ${variant === "card" ? "h-[11.25rem] w-[18.125rem]" : "h-[16.875rem] w-[11.25rem]"}`} />
      ))}
    </div>
  );
}

export function ContinueCard({ entry, row, onResume }: { entry: ProgressEntry; row: string; onResume: (e: ProgressEntry) => void }) {
  return (
    <button data-nav-row={row} onClick={() => onResume(entry)} className="tv-focus card flex h-[5.75rem] w-[34.6875rem] shrink-0 items-center gap-6 overflow-hidden rounded-xl bg-ink-800/90 pr-6 text-left">
      <Art item={entry.item} prefer="backdrop" className="h-full w-[9.875rem] shrink-0 rounded-l-xl" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <span className="truncate text-[1.375rem] font-semibold text-white">{entry.title}</span>
          {entry.episodeLabel && <span className="shrink-0 text-lg text-white/60">{entry.episodeLabel}</span>}
        </div>
        <div className="mt-3 flex items-center gap-5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/15">
            <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-soft" style={{ width: `${Math.round(progressFraction(entry) * 100)}%` }} />
          </div>
          <span className="shrink-0 text-base text-white/70">{remainingLabel(entry)}</span>
        </div>
      </div>
    </button>
  );
}

/** A service's official logo; falls back to nothing if the image is missing or too small to look sharp. */
export function BrandLogo({ service, className = "h-12 w-12" }: { service: SubscriptionService; className?: string }) {
  const [ok, setOk] = useState(true);
  const logo = service.logo;
  if (!logo || !ok) return null;
  if ("svgPath" in logo) {
    return (
      <svg viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-hidden>
        <path d={logo.svgPath} fill={logo.color} />
      </svg>
    );
  }
  return (
    <img
      src={logo.src}
      alt=""
      aria-hidden
      referrerPolicy="no-referrer"
      className={`shrink-0 rounded-xl object-contain ${className}`}
      onError={() => setOk(false)}
      onLoad={(e) => {
        const img = e.currentTarget;
        // Bitmaps under 48 px would look blurry on a TV: show the name only.
        if (!img.src.endsWith(".svg") && img.naturalWidth > 0 && img.naturalWidth < 48) setOk(false);
      }}
    />
  );
}

export const brandBackground = ({ bg, accent }: SubscriptionService["brand"]) => (accent ? `linear-gradient(120deg, ${bg}, ${accent})` : bg);

export function AppTile({ service, row, onOpen }: { service: SubscriptionService; row: string; onOpen: (s: SubscriptionService) => void }) {
  return (
    <button
      data-nav-row={row}
      onClick={() => onOpen(service)}
      aria-label={`Open ${service.name}`}
      className="tv-focus card flex h-[5.25rem] min-w-[13rem] shrink-0 items-center justify-center gap-3 whitespace-nowrap rounded-xl px-6 text-[1.375rem] font-extrabold tracking-tight"
      style={{ background: brandBackground(service.brand), color: service.brand.fg }}
    >
      <BrandLogo service={service} className="h-12 w-12" />
      <span>{service.name}</span>
    </button>
  );
}

export function AllAppsTile({ row, onOpen }: { row: string; onOpen: () => void }) {
  return (
    <button data-nav-row={row} onClick={onOpen} className="tv-focus card flex h-[5.25rem] w-[8.75rem] shrink-0 flex-col items-center justify-center gap-1 rounded-xl bg-ink-800 text-white/90">
      <GridIcon className="h-8 w-8" />
      <span className="text-lg">Apps</span>
    </button>
  );
}

/** Rotating hero banner. Pauses while any hero button has focus. */
export function Hero({ items, onPlay, onOpen }: { items: MediaItem[]; onPlay: (i: MediaItem) => void; onOpen: (i: MediaItem) => void }) {
  const [idx, setIdx] = useState(0);
  const focused = useRef(false);
  const { watchlist, toggleWatchlist } = useApp();
  useEffect(() => {
    const t = setInterval(() => !focused.current && setIdx((i) => (i + 1) % Math.max(1, items.length)), 9000);
    return () => clearInterval(t);
  }, [items.length]);
  const item = items[idx % Math.max(1, items.length)];
  if (!item) return <div className="mr-10 h-[30rem] animate-pulse rounded-3xl bg-ink-800" />;
  const inList = watchlist.some((w) => w.id === item.id);
  const meta = [item.tags?.includes("trending") ? "Trending" : null, item.year, item.genres[0]?.toLowerCase()].filter(Boolean);
  return (
    <section
      className="relative mr-10 h-[30rem] overflow-hidden rounded-3xl bg-ink-800"
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      aria-roledescription="carousel"
    >
      {/* Blurred, dimmed copy fills the banner; the real image sits on the
          right at its own 16:9 shape so nothing is cropped on any screen. */}
      <Art key={`${item.id}-fill`} item={item} prefer="backdrop" className="absolute inset-0 h-full w-full scale-110 blur-2xl brightness-50" />
      <div
        className="absolute inset-y-0 right-0 aspect-video h-full max-w-full"
        style={{ maskImage: "linear-gradient(to right, transparent, #000 30%)", WebkitMaskImage: "linear-gradient(to right, transparent, #000 30%)" }}
      >
        <Art key={item.id} item={item} prefer="backdrop" className="h-full w-full animate-[fadein_.6s_ease]" />
      </div>
      <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/35 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" />
      <div className="relative flex h-full max-w-[45rem] flex-col justify-center pl-20">
        <h1 className="text-[4rem] font-extrabold leading-[1.05] tracking-tight text-white drop-shadow-lg">{item.title}</h1>
        <div className="mt-3 flex items-center gap-3 text-[1.375rem] text-white/85">
          {meta.map((m, i) => (
            <span key={i} className="flex items-center gap-3">
              {i > 0 && <span className="text-white/50">•</span>}
              {m}
            </span>
          ))}
          {item.rating && (
            <span className="flex items-center gap-2">
              <span className="text-white/50">•</span>
              <span className="font-bold text-amber-400">{item.rating.value.toFixed(1)}</span>
              <span className="rounded bg-amber-400 px-1.5 text-xs font-extrabold text-black">{item.rating.source}</span>
            </span>
          )}
        </div>
        {item.description && <p className="mt-4 line-clamp-2 text-[1.3125rem] leading-snug text-white/80">{item.description}</p>}
        <div className="mt-7 flex gap-4">
          <button data-nav-row="hero" data-nav-default onClick={() => onPlay(item)} className="tv-focus whitespace-nowrap flex items-center gap-3 rounded-xl bg-white px-8 py-4 text-[1.375rem] font-semibold text-black">
            <PlayIcon className="h-6 w-6" /> Watch Now
          </button>
          <button data-nav-row="hero" onClick={() => toggleWatchlist(item)} className="tv-focus whitespace-nowrap flex items-center gap-3 rounded-xl border border-white/30 bg-black/30 px-8 py-4 text-[1.375rem] font-medium text-white backdrop-blur">
            {inList ? <CheckIcon className="h-6 w-6" /> : <PlusIcon className="h-6 w-6" />} Watchlist
          </button>
          <button data-nav-row="hero" onClick={() => onOpen(item)} className="tv-focus whitespace-nowrap rounded-xl px-5 py-4 text-[1.25rem] text-white/80">
            More info
          </button>
        </div>
      </div>
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 gap-2.5">
        {items.map((_, i) => (
          <span key={i} className={`h-2.5 rounded-full transition-all ${i === idx ? "w-6 bg-white" : "w-2.5 bg-white/45"}`} />
        ))}
      </div>
    </section>
  );
}
