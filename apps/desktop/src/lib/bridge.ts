/**
 * Single boundary between the UI and native code. Every call has a browser
 * fallback so the UI runs in `npm run dev` (no Tauri) for design work and
 * Playwright tests; native-only features report themselves unavailable
 * instead of pretending to work.
 */
import type { UrlPurpose, JsonFetcher } from "@monitoros/provider-sdk";
import { assertSafeUrl, browserJsonFetcher } from "@monitoros/provider-sdk";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => cb(e.payload));
}

// ---------- capabilities ----------
export interface AppInfo {
  version: string;
  os: string;
  arch: string;
  native: boolean;
  mpvPath: string | null;
  notes: string[];
  canSwitchAudioOutput: boolean;
  canSetVolume: boolean;
  chromiumAppWindow?: boolean;
}

export async function appInfo(): Promise<AppInfo> {
  if (isTauri) return invoke<AppInfo>("app_info");
  return { version: "0.1.0-web", os: navigator.platform, arch: "", native: false, mpvPath: null, notes: ["Running in a browser preview: native playback, remote, display and audio controls need the desktop app."], canSwitchAudioOutput: false, canSetVolume: false };
}

// ---------- network ----------
export const fetchJson: JsonFetcher = async (url: string, purpose: UrlPurpose, timeoutMs: number) => {
  assertSafeUrl(url, purpose);
  if (isTauri) return invoke("provider_fetch_json", { url, timeoutMs });
  return browserJsonFetcher(url, purpose, timeoutMs);
};

/** Text fetch for user-authorised playlists. LAN hosts only when the user ticked "home network". */
export async function fetchText(url: string, allowPrivateNetwork: boolean): Promise<string> {
  assertSafeUrl(url, "stream", { allowHttp: allowPrivateNetwork, allowPrivateNetwork });
  if (isTauri) return invoke<string>("provider_fetch_text", { url, allowPrivateNetwork });
  const res = await fetch(url, { redirect: "error", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function openExternal(url: string): Promise<void> {
  const safe = assertSafeUrl(url, "external").toString();
  if (isTauri) return invoke("open_external", { url: safe });
  window.open(safe, "_blank", "noopener,noreferrer");
}

/** How streaming services open. See src-tauri/src/services.rs for the trade-offs. */
export type ServiceOpenMode = "app-window" | "in-app" | "browser";

export async function openService(url: string, mode: ServiceOpenMode): Promise<string> {
  const safe = assertSafeUrl(url, "external").toString();
  if (isTauri) return invoke<string>("open_service", { url: safe, mode });
  window.open(safe, "_blank", "noopener,noreferrer");
  return "browser";
}

export const closeService = () => (isTauri ? invoke<boolean>("close_service") : Promise.resolve(false));

// ---------- mode ----------
export type Mode = "tv" | "desktop";
export async function setMode(mode: Mode): Promise<void> {
  if (isTauri) return invoke("set_mode", { mode });
  if (mode === "tv") await document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
}

// ---------- native player ----------
export interface NativePlayRequest {
  url: string;
  title: string;
  startSec?: number;
  subtitleUrls?: string[];
  audioDevice?: string;
  localPath?: boolean;
}
export const playNative = (req: NativePlayRequest) => invoke<void>("player_play", { req });
export type NativePlayerCommand =
  | { type: "toggle-pause" }
  | { type: "seek-relative"; seconds: number }
  | { type: "set-volume"; percent: number }
  | { type: "toggle-mute" }
  | { type: "cycle-subtitles" }
  | { type: "cycle-audio" }
  | { type: "set-speed"; speed: number }
  | { type: "toggle-fullscreen" };
export const playerCommand = (cmd: NativePlayerCommand) => invoke<unknown>("player_command", { cmd });
export const playerStop = () => invoke<void>("player_stop");

// ---------- persistence (SQLite in Tauri, localStorage in the browser) ----------
const LS = "monitoros:";
function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(LS + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key: string, value: unknown) {
  try {
    localStorage.setItem(LS + key, JSON.stringify(value));
  } catch {
    /* quota or private mode: state stays in memory */
  }
}

export async function loadState<T>(key: string, fallback: T): Promise<T> {
  if (isTauri) return ((await invoke<T | null>("store_get", { key })) ?? fallback) as T;
  return lsGet(key, fallback);
}

export async function saveState(key: string, value: unknown): Promise<void> {
  if (isTauri) return invoke("store_set", { key, value });
  lsSet(key, value);
}

// ---------- local library ----------
export interface LibraryItem {
  id: string;
  path: string;
  root: string;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  sizeBytes: number;
  subtitles: string[];
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ directory: true, multiple: false, title: "Choose a media folder" });
  return typeof res === "string" ? res : null;
}
export const libraryAddRoot = (path: string) => invoke<LibraryItem[]>("library_add_root", { path });
export const libraryRemoveRoot = (path: string) => invoke<void>("library_remove_root", { path });
export const libraryRoots = () => (isTauri ? invoke<string[]>("library_roots") : Promise.resolve([]));
export const libraryItems = () => (isTauri ? invoke<LibraryItem[]>("library_items") : Promise.resolve([]));
export const libraryRescan = () => invoke<LibraryItem[]>("library_rescan");

// ---------- system ----------
export interface DisplayInfo { id: string; name: string; width: number; height: number; refreshHz?: number; primary: boolean; external: boolean; connection?: string }
export interface AudioDevice { id: string; name: string; transport?: string; defaultOutput: boolean }
export const displays = () => (isTauri ? invoke<DisplayInfo[]>("displays") : Promise.resolve([]));
export const audioOutputs = () => (isTauri ? invoke<AudioDevice[]>("audio_outputs") : Promise.resolve([]));
export const mpvAudioDevices = () => (isTauri ? invoke<{ name: string; description: string }[]>("mpv_audio_devices") : Promise.resolve([]));
export const setAudioOutput = (id: string) => invoke<void>("set_audio_output", { id });
export const volumeGet = () => invoke<{ volume: number; muted: boolean }>("volume_get");
export const volumeSet = (percent: number) => invoke<void>("volume_set", { percent });
export const muteSet = (muted: boolean) => invoke<void>("mute_set", { muted });

export async function setAutostart(enabled: boolean): Promise<boolean> {
  if (!isTauri) return false;
  const m = await import("@tauri-apps/plugin-autostart");
  if (enabled) await m.enable();
  else await m.disable();
  return m.isEnabled();
}

// ---------- remote ----------
export interface RemoteInfo { running: boolean; url: string | null; bindIp: string | null }
export interface PendingPairing { requestId: string; deviceName: string; code: string; createdMs: number; approved: boolean }
export interface PairedDevice { id: string; name: string; pairedMs: number; expiresMs: number; lastSeenMs: number }
export const remoteInfo = () => (isTauri ? invoke<RemoteInfo>("remote_info") : Promise.resolve({ running: false, url: null, bindIp: null }));
export const remoteStart = () => invoke<RemoteInfo>("remote_start");
export const remoteStop = () => invoke<void>("remote_stop");
export const pairingApprove = (requestId: string) => invoke<void>("pairing_approve", { requestId });
export const pairingDeny = (requestId: string) => invoke<void>("pairing_deny", { requestId });
export const devicesList = () => (isTauri ? invoke<PairedDevice[]>("devices_list") : Promise.resolve([]));
export const deviceRevoke = (id: string) => invoke<void>("device_revoke", { id });
export const pushRemoteStatus = (status: unknown) => (isTauri ? invoke<void>("remote_status", { status }) : Promise.resolve());

// ---------- games ----------
export interface GamePlayerInfo { player: number; status: "empty" | "connected" | "reserved"; deviceId?: string; deviceName?: string }
export interface GameInfo { dolphinVersion: string | null; dolphinError: string | null; gameFile: string | null; gameId: string | null; region: string | null; running: boolean; players: GamePlayerInfo[]; error: string | null }
export const gameInfo = () => (isTauri ? invoke<GameInfo>("game_info") : Promise.resolve<GameInfo>({ dolphinVersion: null, dolphinError: "Games need the MonitorOS app", gameFile: null, gameId: null, region: null, running: false, players: [0, 1, 2, 3].map((player) => ({ player, status: "empty" })), error: null }));
export async function pickGameFile(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, title: "Choose a Wii or GameCube game", filters: [{ name: "Wii / GameCube games", extensions: ["rvz", "iso", "wbfs", "gcz", "wia", "ciso", "gcm"] }] });
  return typeof res === "string" ? res : null;
}
export const gameSetFile = (path: string) => invoke<void>("game_set_file", { path });
export const gameLaunch = () => invoke<void>("game_launch");
export const gameStop = () => invoke<void>("game_stop");
export const gameRemovePlayer = (player: number) => invoke<void>("game_remove_player", { player });
export async function pickDolphin(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, title: "Locate Dolphin (Dolphin.app or Dolphin.exe)" });
  return typeof res === "string" ? res : null;
}
export const gameSetDolphin = (path: string) => invoke<string>("game_set_dolphin", { path });

// ---------- graphics & HD textures ----------
export type GraphicsPreset = "performance" | "balanced" | "ultra" | "custom";
export type Backend = "dolphinDefault" | "metal" | "vulkan" | "openGl" | "d3d11" | "d3d12";
export interface GraphicsSettings {
  internalResolution: number;
  anisotropy: number;
  aspect: "auto" | "wide" | "standard" | "stretch";
  msaa: number;
  shaders: "synchronous" | "hybrid" | "skipDrawing";
  vsync: boolean;
  prefetchTextures: boolean;
  backend: Backend;
  fullscreen: boolean;
}
export interface EffectiveSetting { label: string; requested: string; effective: string; overriddenBy: string | null }
export interface PackManifest { name: string; version: string | null; authors: string | null; packId: string; source: string; textures: number; bytes: number; installedMs: number }
export interface PackStatus { manifest: PackManifest | null; folder: string; enabled: boolean; discoverable: boolean; filesPresent: number; otherFolders: string[] }
export interface InstallJob { done: number; total: number; finished: boolean; error: string | null }
export interface GraphicsInfo {
  gameId: string | null;
  region: string;
  marioKartWii: boolean;
  running: boolean;
  dolphinError: string | null;
  userDir: string | null;
  texturesFolder: string | null;
  preset: GraphicsPreset;
  settings: GraphicsSettings;
  presets: [GraphicsPreset, GraphicsSettings][];
  backends: Backend[];
  effective: EffectiveSetting[];
  pack: PackStatus | null;
  confirmedLoaded: number | null;
  job: InstallJob | null;
}
export interface PackPreview {
  source: string;
  archive: boolean;
  name: string;
  version: string | null;
  authors: string | null;
  packId: string;
  root: string;
  textures: number;
  textureBytes: number;
  regions: string;
  compatible: boolean | null;
  gameId: string | null;
  instructions: { file: string; text: string }[];
  warnings: string[];
}
export const graphicsInfo = () => invoke<GraphicsInfo>("graphics_info");
export const graphicsSet = (preset: GraphicsPreset, custom?: GraphicsSettings) => invoke<void>("graphics_set", { preset, custom: custom ?? null });
export const graphicsRestoreDefaults = () => invoke<void>("graphics_restore_defaults");
/** A ZIP or an extracted folder (two pickers: the OS dialog can't do both at once). */
export async function pickTexturePack(folder: boolean): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = folder
    ? await open({ directory: true, multiple: false, title: "Choose the extracted texture pack folder" })
    : await open({ multiple: false, title: "Choose the downloaded texture pack", filters: [{ name: "Texture pack", extensions: ["zip", "7z", "rar"] }] });
  return typeof res === "string" ? res : null;
}
export const texturePackInspect = (path: string) => invoke<PackPreview>("texture_pack_inspect", { path });
export const texturePackInstall = (path: string) => invoke<void>("texture_pack_install", { path });
export const texturePackSetEnabled = (enabled: boolean) => invoke<void>("texture_pack_set_enabled", { enabled });
export const texturePackRemove = () => invoke<void>("texture_pack_remove");
export const textureFolderOpen = () => invoke<void>("texture_folder_open");
