import { useEffect, useState } from "react";
import { useApp, type Page } from "../store/app";
import { BellIcon, FolderIcon, GamepadIcon, GearIcon, GiftIcon, HomeIcon, Logo, MonitorIcon, PlayCircleIcon, SearchIcon, TvIcon } from "./icons";

const NAV: { label: string; page: Page }[] = [
  { label: "Home", page: { name: "home" } },
  { label: "Movies", page: { name: "browse", kind: "movie" } },
  { label: "Series", page: { name: "browse", kind: "series" } },
  { label: "Live TV", page: { name: "live" } },
  { label: "Apps", page: { name: "apps" } },
  { label: "Free", page: { name: "free" } },
  { label: "Library", page: { name: "library" } },
];

function samePage(a: Page, b: Page) {
  return a.name === b.name && (a.name !== "browse" || (b.name === "browse" && a.kind === b.kind));
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular-nums text-lg font-medium text-white/90">{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>;
}

export function TopNav() {
  const { page, navigate } = useApp();
  return (
    <header className="flex h-[88px] shrink-0 items-center gap-8 px-10">
      <div className="flex items-center gap-3">
        <Logo className="h-8 w-12" />
        <span className="text-[28px] font-bold tracking-tight text-white">MonitorOS</span>
      </div>
      <nav className="ml-6 flex items-center gap-1" aria-label="Primary">
        {NAV.map((n) => {
          const active = samePage(page, n.page);
          return (
            <button
              key={n.label}
              data-nav-row="topnav"
              onClick={() => navigate(n.page)}
              className={`tv-focus rounded-full px-6 py-2.5 text-[19px] font-medium transition ${active ? "bg-white/12 text-white" : "text-white/70 hover:text-white"}`}
            >
              {n.label}
            </button>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-5 text-white/85">
        <button data-nav-row="topnav" aria-label="Search" onClick={() => navigate({ name: "search" })} className="tv-focus rounded-full p-2.5">
          <SearchIcon className="h-7 w-7" />
        </button>
        <button data-nav-row="topnav" aria-label="Notifications" onClick={() => navigate({ name: "settings", section: "diagnostics" })} className="tv-focus rounded-full p-2.5">
          <BellIcon className="h-7 w-7" />
        </button>
        <button data-nav-row="topnav" aria-label="Settings" onClick={() => navigate({ name: "settings" })} className="tv-focus rounded-full p-2.5">
          <GearIcon className="h-7 w-7" />
        </button>
        <Clock />
      </div>
    </header>
  );
}

const RAIL: { label: string; icon: typeof HomeIcon; page: Page }[] = [
  { label: "Home", icon: HomeIcon, page: { name: "home" } },
  { label: "Live TV", icon: TvIcon, page: { name: "live" } },
  { label: "Free to watch", icon: PlayCircleIcon, page: { name: "free" } },
  { label: "Anime", icon: GamepadIcon, page: { name: "browse", kind: "anime" } },
  { label: "Apps", icon: GiftIcon, page: { name: "apps" } },
  { label: "Library", icon: FolderIcon, page: { name: "library" } },
];

export function Sidebar() {
  const { page, navigate, setMode, mode } = useApp();
  return (
    <aside className="flex w-[104px] shrink-0 flex-col items-center gap-3 bg-ink-900/80 py-6">
      <div className="mb-6 grid h-11 w-11 place-items-center rounded-full bg-gradient-to-br from-accent to-accent-pink shadow-lg shadow-accent/30">
        <span className="text-lg font-black text-white">M</span>
      </div>
      {RAIL.map(({ label, icon: Icon, page: p }) => {
        const active = samePage(page, p);
        return (
          <button
            key={label}
            data-nav-row="rail"
            data-nav-axis="y"
            aria-label={label}
            title={label}
            onClick={() => navigate(p)}
            className={`tv-focus grid h-[72px] w-[78px] place-items-center rounded-2xl transition ${active ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"}`}
          >
            <Icon className="h-8 w-8" />
          </button>
        );
      })}
      <button
        data-nav-row="rail"
        data-nav-axis="y"
        onClick={() => setMode("toggle")}
        aria-label={mode === "tv" ? "Switch to Desktop" : "Switch to TV"}
        className="tv-focus mt-auto flex flex-col items-center gap-2 rounded-2xl p-2 text-white/80"
      >
        <span className="grid h-16 w-16 place-items-center rounded-full bg-ink-700/80">
          <MonitorIcon className="h-8 w-8" />
        </span>
        <span className="text-[15px]">{mode === "tv" ? "Desktop" : "TV Mode"}</span>
      </button>
    </aside>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-8 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`rounded-full px-6 py-3 text-lg shadow-2xl backdrop-blur ${t.tone === "error" ? "bg-red-600/90 text-white" : "bg-white/15 text-white"}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between pr-10">
      <h2 className="text-[28px] font-bold tracking-tight text-white">{children}</h2>
      {action}
    </div>
  );
}
