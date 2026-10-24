import { useEffect, useRef, useState } from "react";
import type { RemoteCommand } from "@monitoros/contracts";
import { Sidebar, Toasts, TopNav } from "./components/Chrome";
import { PlayerHost } from "./components/Player";
import { keyToIntent, move, restoreFocus, setFocusPage, type NavIntent } from "./lib/focus";
import { isTauri, listen, pairingApprove, pairingDeny, playerCommand, remoteStart, type PendingPairing } from "./lib/bridge";
import { loadAddons } from "./lib/catalog";
import { useApp, type Page } from "./store/app";
import { HomePage } from "./pages/Home";
import { DetailPage } from "./pages/Detail";
import { AppsPage, BrowsePage, FreePage, SearchPage } from "./pages/Discover";
import { LibraryPage, LivePage } from "./pages/Local";
import { SettingsPage } from "./pages/Settings";
import { GamesPage } from "./pages/Games";
import { OnboardingPage } from "./pages/Onboarding";

function pageKey(p: Page): string {
  return p.name === "browse" ? `browse-${p.kind}` : p.name === "detail" ? `detail-${p.item.id}` : p.name;
}

function PageView({ page }: { page: Page }) {
  switch (page.name) {
    case "home":
      return <HomePage />;
    case "browse":
      return <BrowsePage kind={page.kind} />;
    case "detail":
      return <DetailPage item={page.item} />;
    case "search":
      return <SearchPage initial={page.query} />;
    case "apps":
      return <AppsPage />;
    case "free":
      return <FreePage />;
    case "live":
      return <LivePage />;
    case "library":
      return <LibraryPage />;
    case "games":
      return <GamesPage />;
    case "settings":
      return <SettingsPage section={page.section} />;
    case "onboarding":
      return <OnboardingPage />;
  }
}

function PairingDialog() {
  const [pending, setPending] = useState<PendingPairing | null>(null);
  const toast = useApp((s) => s.toast);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<{ type: string; request?: PendingPairing; device?: { name: string }; name?: string }>("remote://event", (e) => {
      if (e.type === "pairing-requested" && e.request) setPending(e.request);
      if (e.type === "device-paired" && e.device) toast(`${e.device.name} is paired`);
      if (e.type === "device-connected" && e.name) toast(`${e.name} connected`);
    }).then((u) => (un = u));
    return () => un?.();
  }, [toast]);
  if (!pending) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur" role="dialog" aria-modal aria-label="Pair a remote">
      <div className="w-[40rem] rounded-3xl bg-ink-850 p-10 text-center text-white shadow-2xl">
        <p className="text-xl text-white/60">“{pending.deviceName}” wants to control this TV</p>
        {pending.approved ? (
          <>
            <p className="mt-6 text-lg text-white/60">Enter this code on your phone</p>
            <p className="mt-2 font-mono text-7xl font-bold tracking-[0.3em]">{pending.code}</p>
            <button autoFocus data-nav-row="pair" onClick={() => setPending(null)} className="tv-focus mt-8 rounded-xl bg-white/10 px-8 py-3 text-xl">Done</button>
          </>
        ) : (
          <div className="mt-8 flex justify-center gap-4">
            <button autoFocus data-nav-row="pair" onClick={() => void pairingApprove(pending.requestId).then(() => setPending({ ...pending, approved: true }))} className="tv-focus rounded-xl bg-white px-8 py-4 text-xl font-semibold text-black">Allow</button>
            <button data-nav-row="pair" onClick={() => void pairingDeny(pending.requestId).then(() => setPending(null))} className="tv-focus rounded-xl bg-white/10 px-8 py-4 text-xl">Deny</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function App() {
  const { ready, page, mode, nowPlaying, init, back, navigate } = useApp();
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    void init().then(() => {
      void loadAddons();
      const s = useApp.getState().settings;
      if (isTauri && s.remoteEnabled) void remoteStart().catch(() => {});
      if (isTauri && s.defaultMode === "tv") void useApp.getState().setMode("tv");
    });
  }, [init]);

  // Focus restoration per page.
  useEffect(() => {
    setFocusPage(pageKey(page));
    main.current?.scrollTo({ top: 0 });
    const t = setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) restoreFocus();
    }, 60);
    return () => clearTimeout(t);
  }, [page]);

  // Return focus to where it was after playback ends.
  useEffect(() => {
    if (!nowPlaying) setTimeout(() => restoreFocus(), 50);
  }, [nowPlaying]);

  const handleIntent = (intent: NavIntent) => {
    const np = useApp.getState().nowPlaying;
    if (np?.route === "html5") return; // the html5 player handles its own keys
    switch (intent) {
      case "up":
      case "down":
      case "left":
      case "right":
        move(intent);
        break;
      case "ok":
        (document.activeElement as HTMLElement | null)?.click();
        break;
      case "back":
        if (!back()) navigate({ name: "home" });
        break;
      case "home":
        navigate({ name: "home" });
        break;
      case "search":
        navigate({ name: "search" });
        break;
      case "play-pause":
        if (np?.route === "mpv") void playerCommand({ type: "toggle-pause" });
        break;
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const intent = keyToIntent(e);
      if (!intent || !useApp.getState().ready) return;
      const typing = e.target instanceof HTMLInputElement && e.target.type !== "checkbox";
      // Inside text fields keep native editing; only Up/Down/Escape navigate away.
      if (typing && !["up", "down", "back"].includes(intent)) return;
      if (typing && intent === "back" && (e.target as HTMLInputElement).value) return;
      if (intent === "ok" && !typing) return; // native button activation already fires click
      e.preventDefault();
      handleIntent(intent);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // iPhone remote commands from Rust (mode and volume are handled natively there).
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<RemoteCommand>("remote://command", async (c) => {
      const np = useApp.getState().nowPlaying;
      switch (c.type) {
        case "nav":
          if (np?.route === "html5") {
            const key = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", ok: "Enter", back: "Escape" }[c.key as string];
            if (key) window.dispatchEvent(new KeyboardEvent("keydown", { key }));
          } else handleIntent(c.key);
          break;
        case "media":
          if (np?.route === "mpv" && c.action === "play-pause") void playerCommand({ type: "toggle-pause" });
          else if (np?.route === "html5") window.dispatchEvent(new KeyboardEvent("keydown", { key: c.action === "stop" ? "Escape" : " " }));
          break;
        case "seek":
          if (np?.route === "mpv") void playerCommand({ type: "seek-relative", seconds: c.deltaSec });
          else if (np?.route === "html5") window.dispatchEvent(new KeyboardEvent("keydown", { key: c.deltaSec < 0 ? "ArrowLeft" : "ArrowRight" }));
          break;
        case "text":
          if (useApp.getState().page.name !== "search") navigate({ name: "search", query: c.value });
          break;
      }
    }).then((u) => (un = u));
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return <div className="h-screen bg-ink-950" />;
  const showChrome = page.name !== "onboarding";
  return (
    <div className={`flex h-screen overflow-hidden bg-ink-950 font-sans text-white ${mode === "tv" ? "tv-mode" : ""}`}>
      {showChrome && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        {showChrome && <TopNav />}
        <main data-nav-region="main" ref={main} className="no-scrollbar min-h-0 flex-1 overflow-y-auto" key={pageKey(page)}>
          <PageView page={page} />
        </main>
      </div>
      <PlayerHost />
      <PairingDialog />
      <Toasts />
    </div>
  );
}
