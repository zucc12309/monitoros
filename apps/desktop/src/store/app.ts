import { create } from "zustand";
import type { MediaItem, PlaybackSource, WatchProgress } from "@monitoros/contracts";
import { loadState, saveState, setMode as nativeSetMode, pushRemoteStatus, openService, type Mode, type ServiceOpenMode } from "../lib/bridge";

export type Page =
  | { name: "home" }
  | { name: "browse"; kind: "movie" | "series" | "anime" }
  | { name: "live" }
  | { name: "apps" }
  | { name: "free" }
  | { name: "library" }
  | { name: "search"; query?: string }
  | { name: "detail"; item: MediaItem }
  | { name: "settings"; section?: string }
  | { name: "onboarding" };

export interface Settings {
  onboarded: boolean;
  region: string;
  languages: string[];
  subscriptions: string[];
  preferFree: boolean;
  allowUnverified: boolean;
  defaultMode: Mode;
  launchAtLogin: boolean;
  audioDevice: string | null; // mpv audio device for playback
  maxQuality: "720p" | "1080p" | "2160p";
  hwdec: "auto-safe" | "no";
  iptvPlaylists: { id: string; name: string; url: string; allowLan: boolean }[];
  remoteEnabled: boolean;
  serviceOpenMode: ServiceOpenMode;
  /** Let the paired remote send keys/mouse to other apps when they're in front. */
  remoteControlsOtherApps: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  region: "IN",
  languages: ["hi", "en"],
  subscriptions: [],
  preferFree: false,
  allowUnverified: false,
  defaultMode: "tv",
  launchAtLogin: false,
  audioDevice: null,
  maxQuality: "1080p",
  hwdec: "auto-safe",
  iptvPlaylists: [],
  remoteEnabled: false,
  serviceOpenMode: "in-app",
  remoteControlsOtherApps: true,
};

export interface ProgressEntry extends WatchProgress {
  title: string;
  item: MediaItem;
  episodeLabel?: string;
}

export interface NowPlaying {
  item: MediaItem;
  source: PlaybackSource;
  route: "mpv" | "html5";
  startSec: number;
  episode?: { season: number; episode: number };
}

interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

interface AppState {
  ready: boolean;
  mode: Mode;
  page: Page;
  history: Page[];
  settings: Settings;
  watchlist: MediaItem[];
  progress: ProgressEntry[];
  nowPlaying: NowPlaying | null;
  toasts: Toast[];
  init(): Promise<void>;
  navigate(page: Page): void;
  back(): boolean;
  setMode(mode: Mode | "toggle"): Promise<void>;
  updateSettings(patch: Partial<Settings>): void;
  toggleWatchlist(item: MediaItem): void;
  saveProgress(entry: ProgressEntry): void;
  play(np: NowPlaying): void;
  stopPlayback(): void;
  toast(text: string, tone?: Toast["tone"]): void;
  launchService(url: string, name: string): Promise<void>;
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  mode: "tv",
  page: { name: "home" },
  history: [],
  settings: DEFAULT_SETTINGS,
  watchlist: [],
  progress: [],
  nowPlaying: null,
  toasts: [],

  async init() {
    const [settings, watchlist, progress] = await Promise.all([
      loadState<Settings>("settings", DEFAULT_SETTINGS),
      loadState<MediaItem[]>("watchlist", []),
      loadState<ProgressEntry[]>("progress", []),
    ]);
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    set({ settings: merged, watchlist, progress, ready: true, mode: merged.defaultMode, page: merged.onboarded ? { name: "home" } : { name: "onboarding" } });
  },

  navigate(page) {
    set((s) => ({ history: [...s.history.slice(-30), s.page], page }));
  },

  back() {
    const h = get().history;
    if (!h.length) return false;
    set({ page: h[h.length - 1]!, history: h.slice(0, -1) });
    return true;
  },

  async setMode(target) {
    const mode = target === "toggle" ? (get().mode === "tv" ? "desktop" : "tv") : target;
    set({ mode });
    void pushRemoteStatus({ mode });
    try {
      await nativeSetMode(mode);
    } catch (e) {
      get().toast(`Couldn't switch mode: ${(e as Error).message ?? e}`, "error");
    }
  },

  updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void saveState("settings", settings);
  },

  toggleWatchlist(item) {
    const exists = get().watchlist.some((w) => w.id === item.id);
    const watchlist = exists ? get().watchlist.filter((w) => w.id !== item.id) : [item, ...get().watchlist].slice(0, 500);
    set({ watchlist });
    void saveState("watchlist", watchlist);
    get().toast(exists ? `Removed “${item.title}” from your watchlist` : `Added “${item.title}” to your watchlist`);
  },

  saveProgress(entry) {
    const progress = [entry, ...get().progress.filter((p) => p.mediaId !== entry.mediaId)].slice(0, 50);
    set({ progress });
    void saveState("progress", progress);
  },

  play(np) {
    set({ nowPlaying: np });
    void pushRemoteStatus({ mode: get().mode, nowPlaying: { title: np.item.title, positionSec: np.startSec, durationSec: 0, paused: false } });
  },

  stopPlayback() {
    set({ nowPlaying: null });
    void pushRemoteStatus({ mode: get().mode, nowPlaying: null });
  },

  async launchService(url, name) {
    try {
      const how = await openService(url, get().settings.serviceOpenMode);
      const hint =
        how === "browser"
          ? "in your browser"
          : how === "in-app"
            ? "— use ← MonitorOS (top-left) to come back. If video won't play, choose “Chrome app window” in Settings › Playback"
            : "— press Home on the remote or Ctrl/Cmd+Shift+M to come back";
      get().toast(`Opening ${name} ${hint}`);
    } catch (e) {
      get().toast(`Couldn't open ${name}: ${(e as Error).message ?? e}`, "error");
    }
  },

  toast(text, tone = "info") {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3500);
  },
}));
