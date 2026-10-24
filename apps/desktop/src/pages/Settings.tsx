import { useEffect, useState } from "react";
import type { ProviderHealth } from "@monitoros/contracts";
import { StremioAddonProvider, fetchManifest, type AddonInstallation } from "@monitoros/provider-sdk";
import { SUBSCRIPTION_SERVICES } from "@monitoros/metadata";
import { SectionTitle } from "../components/Chrome";
import { QrCode } from "../components/QrCode";
import {
  appInfo, audioOutputs, deviceRevoke, devicesList, displays, fetchJson, isTauri, mpvAudioDevices, remoteInfo, remoteStart, remoteStop, setAudioOutput, setAutostart, volumeGet, volumeSet,
  type AppInfo, type AudioDevice, type DisplayInfo, type PairedDevice, type RemoteInfo,
} from "../lib/bridge";
import { loadAddons, registry, saveAddons } from "../lib/catalog";
import { deviceCaps } from "../lib/playback";
import { useApp } from "../store/app";

const SECTIONS = ["subscriptions", "addons", "display", "remote", "playback", "startup", "diagnostics"] as const;
type Section = (typeof SECTIONS)[number];
const LABEL: Record<Section, string> = { subscriptions: "Subscriptions", addons: "Add-ons", display: "Display & Audio", remote: "iPhone Remote", playback: "Playback", startup: "Startup & Mode", diagnostics: "Diagnostics" };

const Btn = ({ row, onClick, children, primary }: { row: string; onClick: () => void; children: React.ReactNode; primary?: boolean }) => (
  <button data-nav-row={row} onClick={onClick} className={`tv-focus rounded-xl px-5 py-2.5 text-lg ${primary ? "bg-white font-semibold text-black" : "bg-white/10 text-white"}`}>{children}</button>
);

function Toggle({ row, label, value, onChange, hint }: { row: string; label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <button data-nav-row={row} onClick={() => onChange(!value)} className="tv-focus flex w-full max-w-[760px] items-center justify-between rounded-xl bg-ink-800 px-5 py-4 text-left text-white">
      <span>
        <span className="block text-lg">{label}</span>
        {hint && <span className="block text-sm text-white/45">{hint}</span>}
      </span>
      <span className={`h-7 w-12 rounded-full p-1 transition ${value ? "bg-accent" : "bg-white/20"}`}>
        <span className={`block h-5 w-5 rounded-full bg-white transition ${value ? "translate-x-5" : ""}`} />
      </span>
    </button>
  );
}

function Subscriptions() {
  const { settings, updateSettings } = useApp();
  return (
    <div className="flex flex-wrap gap-3">
      {SUBSCRIPTION_SERVICES.map((s, i) => {
        const on = settings.subscriptions.includes(s.id);
        return (
          <button key={s.id} data-nav-row={`subs-${Math.floor(i / 5)}`} onClick={() => updateSettings({ subscriptions: on ? settings.subscriptions.filter((x) => x !== s.id) : [...settings.subscriptions, s.id] })} className={`tv-focus rounded-xl px-6 py-4 text-lg font-semibold ${on ? "bg-accent text-white" : "bg-ink-800 text-white/70"}`}>
            {on ? "✓ " : ""}{s.name}
          </button>
        );
      })}
    </div>
  );
}

function Addons() {
  const { settings, updateSettings, toast } = useApp();
  const [installs, setInstalls] = useState<AddonInstallation[]>([]);
  const [url, setUrl] = useState("");
  const [health, setHealth] = useState<Map<string, ProviderHealth>>(new Map());
  useEffect(() => void loadAddons().then(setInstalls), []);

  const persist = async (next: AddonInstallation[]) => {
    setInstalls(next);
    await saveAddons(next);
  };

  const install = async () => {
    try {
      const { manifestUrl, manifest } = await fetchManifest(url, fetchJson);
      if (installs.some((i) => i.manifest.id === manifest.id)) return toast(`${manifest.name} is already installed`, "error");
      const inst: AddonInstallation = { manifestUrl, manifest, enabled: true, installedAt: Date.now(), provenance: "third-party-addon" };
      registry.register(new StremioAddonProvider(inst, fetchJson));
      await persist([...installs, inst]);
      setUrl("");
      toast(`Installed ${manifest.name} ${manifest.version}`);
    } catch (e) {
      toast(`Couldn't install: ${(e as Error).message}`, "error");
    }
  };

  return (
    <div className="max-w-[900px]">
      <p className="mb-4 text-lg text-white/55">Stremio-compatible add-ons are remote JSON services. MonitorOS validates each manifest, never runs add-on code, refuses redirects and private-network addresses, and drops torrent streams.</p>
      <div className="mb-6 flex gap-3">
        <input data-nav-row="addon-add" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://addon.example.com/manifest.json" className="tv-focus flex-1 rounded-xl bg-ink-800 px-5 py-3 text-lg text-white outline-none" aria-label="Add-on manifest URL" />
        <Btn row="addon-add" primary onClick={() => void install()}>Install</Btn>
      </div>
      <div className="flex flex-col gap-3">
        {installs.map((i, idx) => {
          const pid = `addon:${i.manifest.id}`;
          const h = health.get(pid);
          return (
            <div key={pid} className="flex items-center gap-4 rounded-xl bg-ink-800 px-5 py-4 text-white">
              <div className="min-w-0 flex-1">
                <div className="text-lg font-semibold">{i.manifest.name} <span className="text-sm text-white/40">v{i.manifest.version}</span></div>
                <div className="truncate text-sm text-white/45">{i.manifestUrl}</div>
                <div className="text-sm text-white/45">{i.manifest.resources.map((r) => (typeof r === "string" ? r : r.name)).join(", ")} · {h ? `${h.status}${h.latencyMs ? ` (${h.latencyMs} ms)` : ""}` : "not checked"}</div>
              </div>
              <Btn row={`addon-${idx}`} onClick={() => { registry.setEnabled(pid, !i.enabled); void persist(installs.map((x) => (x === i ? { ...x, enabled: !x.enabled } : x))); }}>{i.enabled ? "Disable" : "Enable"}</Btn>
              <Btn row={`addon-${idx}`} onClick={() => { registry.unregister(pid); void persist(installs.filter((x) => x !== i)); toast(`Removed ${i.manifest.name}`); }}>Remove</Btn>
            </div>
          );
        })}
        {!installs.length && <p className="text-white/40">No add-ons installed.</p>}
      </div>
      <div className="mt-6 flex flex-col gap-3">
        <Btn row="addon-health" onClick={() => void registry.checkHealth().then(setHealth)}>Check provider health</Btn>
        <Toggle row="addon-unverified" label="Show unverified add-on sources" value={settings.allowUnverified} onChange={(v) => updateSettings({ allowUnverified: v })} hint="Off by default. When on, add-on streams are listed but never auto-selected; you are responsible for having the right to watch them." />
      </div>
    </div>
  );
}

function DisplayAudio() {
  const { settings, updateSettings, toast } = useApp();
  const [ds, setDs] = useState<DisplayInfo[]>([]);
  const [outs, setOuts] = useState<AudioDevice[]>([]);
  const [mpvDevs, setMpvDevs] = useState<{ name: string; description: string }[]>([]);
  const [vol, setVol] = useState<number | null>(null);
  useEffect(() => {
    void displays().then(setDs).catch(() => {});
    void audioOutputs().then(setOuts).catch(() => {});
    void mpvAudioDevices().then(setMpvDevs).catch(() => {});
    if (isTauri) void volumeGet().then((v) => setVol(v.volume)).catch(() => {});
  }, []);
  if (!isTauri) return <p className="text-lg text-white/50">Display and audio controls are available in the desktop app.</p>;
  return (
    <div className="max-w-[900px] space-y-8 text-white">
      <div>
        <h3 className="mb-3 text-xl font-semibold">Displays</h3>
        {ds.map((d) => (
          <div key={d.id} className="mb-2 rounded-xl bg-ink-800 px-5 py-3">
            {d.name} — {d.width}×{d.height}{d.refreshHz ? ` @ ${d.refreshHz} Hz` : ""} · {d.connection ?? (d.external ? "External" : "Built-in")}{d.primary ? " · main" : ""}
          </div>
        ))}
      </div>
      <div>
        <h3 className="mb-3 text-xl font-semibold">System output</h3>
        <div className="flex flex-wrap gap-3">
          {outs.map((o) => (
            <Btn key={o.id} row="sys-audio" primary={o.defaultOutput} onClick={() => void setAudioOutput(o.id).then(() => toast(`Output: ${o.name}`)).catch((e) => toast(String(e), "error"))}>
              {o.name}{o.transport ? ` (${o.transport})` : ""}
            </Btn>
          ))}
        </div>
        {vol !== null && (
          <div className="mt-4 flex items-center gap-3">
            <Btn row="volume" onClick={() => { const v = Math.max(0, vol - 10); setVol(v); void volumeSet(v); }}>−</Btn>
            <span className="w-20 text-center text-xl tabular-nums">{vol}%</span>
            <Btn row="volume" onClick={() => { const v = Math.min(100, vol + 10); setVol(v); void volumeSet(v); }}>+</Btn>
          </div>
        )}
      </div>
      <div>
        <h3 className="mb-1 text-xl font-semibold">Playback output (mpv)</h3>
        <p className="mb-3 text-white/45">Send movie audio to HDMI or Bluetooth without changing the system default.</p>
        <div className="flex flex-wrap gap-3">
          <Btn row="mpv-audio" primary={!settings.audioDevice} onClick={() => updateSettings({ audioDevice: null })}>System default</Btn>
          {mpvDevs.filter((d) => d.name !== "auto").map((d) => (
            <Btn key={d.name} row="mpv-audio" primary={settings.audioDevice === d.name} onClick={() => updateSettings({ audioDevice: d.name })}>{d.description}</Btn>
          ))}
        </div>
      </div>
    </div>
  );
}

function Remote() {
  const toast = useApp((s) => s.toast);
  const updateSettings = useApp((s) => s.updateSettings);
  const controlsOtherApps = useApp((s) => s.settings.remoteControlsOtherApps);
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const refresh = () => {
    void remoteInfo().then(setInfo);
    void devicesList().then(setDevices);
  };
  useEffect(refresh, []);
  if (!isTauri) return <p className="text-lg text-white/50">The iPhone remote server runs in the desktop app.</p>;
  return (
    <div className="max-w-[900px] text-white">
      <p className="mb-4 text-lg text-white/55">Your iPhone must be on the same Wi-Fi. The server listens only on this computer's private LAN address and every phone needs your approval plus the code shown on the TV.</p>
      {info?.running ? (
        <div className="flex items-start gap-8">
          {info.url && <QrCode text={info.url} size={200} />}
          <div>
            <p className="text-white/60">On your iPhone, open</p>
            <p className="text-3xl font-bold">{info.url}</p>
            <p className="mt-2 text-white/50">then tap Share › Add to Home Screen.</p>
            <div className="mt-5"><Btn row="remote-ctl" onClick={() => void remoteStop().then(() => { updateSettings({ remoteEnabled: false }); refresh(); })}>Stop remote server</Btn></div>
          </div>
        </div>
      ) : (
        <Btn row="remote-ctl" primary onClick={() => void remoteStart().then(() => { updateSettings({ remoteEnabled: true }); refresh(); }).catch((e) => toast(String(e), "error"))}>Start remote server</Btn>
      )}
      <div className="mt-8">
        <Toggle
          row="remote-other-apps"
          label="Remote controls other apps"
          value={controlsOtherApps}
          onChange={(v) => updateSettings({ remoteControlsOtherApps: v })}
          hint="When another app is in front (Chrome, Apple TV, VLC…), the D-pad, OK, Back and play/pause become real key presses and the touchpad moves the mouse. Home always returns to MonitorOS. macOS asks once for Accessibility permission."
        />
      </div>
      <h3 className="mb-3 mt-8 text-xl font-semibold">Paired devices</h3>
      {devices.map((d) => (
        <div key={d.id} className="mb-2 flex items-center justify-between rounded-xl bg-ink-800 px-5 py-3">
          <span>{d.name} <span className="text-sm text-white/40">· last seen {new Date(d.lastSeenMs).toLocaleString()}</span></span>
          <Btn row="devices" onClick={() => void deviceRevoke(d.id).then(refresh)}>Revoke</Btn>
        </div>
      ))}
      {!devices.length && <p className="text-white/40">None yet.</p>}
    </div>
  );
}

const OPEN_MODES: { id: "app-window" | "in-app" | "browser"; label: string; hint: string }[] = [
  { id: "in-app", label: "Inside MonitorOS (default)", hint: "Full screen inside MonitorOS with a ← MonitorOS button. Sign in once per service. Some services may refuse to play protected video here — if so, use the Chrome app window." },
  { id: "app-window", label: "Chrome/Edge app window", hint: "Your installed Chrome/Edge/Brave, full screen without tabs or address bar. Keeps your existing sign-ins and full DRM support." },
  { id: "browser", label: "Default browser tab", hint: "Opens a normal tab in your default browser." },
];

function Playback() {
  const { settings, updateSettings } = useApp();
  return (
    <div className="max-w-[760px] space-y-3 text-white">
      <h3 className="text-xl font-semibold">Open streaming apps in</h3>
      {OPEN_MODES.map((m) => (
        <button key={m.id} data-nav-row={`open-${m.id}`} onClick={() => updateSettings({ serviceOpenMode: m.id })} className={`tv-focus block w-full rounded-xl px-5 py-4 text-left ${settings.serviceOpenMode === m.id ? "bg-accent/30 ring-1 ring-accent" : "bg-ink-800"}`}>
          <span className="block text-lg">{settings.serviceOpenMode === m.id ? "● " : "○ "}{m.label}</span>
          <span className="block text-sm text-white/50">{m.hint}</span>
        </button>
      ))}
      <h3 className="pt-4 text-xl font-semibold">Quality</h3>
      <div className="flex gap-3">
        {(["720p", "1080p", "2160p"] as const).map((q) => (
          <Btn key={q} row="quality" primary={settings.maxQuality === q} onClick={() => updateSettings({ maxQuality: q })}>Max {q}</Btn>
        ))}
      </div>
      <Toggle row="hwdec" label="Hardware decoding" value={settings.hwdec === "auto-safe"} onChange={(v) => updateSettings({ hwdec: v ? "auto-safe" : "no" })} hint="Turn off if video shows artefacts with older GPU drivers." />
      <Toggle row="prefer-free" label="Prefer free sources" value={settings.preferFree} onChange={(v) => updateSettings({ preferFree: v })} />
    </div>
  );
}

function Startup() {
  const { settings, updateSettings, toast } = useApp();
  return (
    <div className="max-w-[760px] space-y-3 text-white">
      <Toggle row="autostart" label="Open MonitorOS when I log in" value={settings.launchAtLogin} onChange={(v) => void setAutostart(v).then((on) => updateSettings({ launchAtLogin: on })).catch((e) => toast(String(e), "error"))} hint={isTauri ? "Adds a login item. Nothing else on your system is changed." : "Desktop app only."} />
      <Toggle row="default-mode" label="Start in TV Mode (full screen)" value={settings.defaultMode === "tv"} onChange={(v) => updateSettings({ defaultMode: v ? "tv" : "desktop" })} hint="Recovery: Ctrl/Cmd + Shift + M always switches back to Desktop Mode." />
    </div>
  );
}

function Diagnostics() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [caps, setCaps] = useState<Awaited<ReturnType<typeof deviceCaps>> | null>(null);
  const [health, setHealth] = useState<Map<string, ProviderHealth> | null>(null);
  useEffect(() => {
    void appInfo().then(setInfo);
    void deviceCaps().then(setCaps);
    void registry.checkHealth().then(setHealth);
  }, []);
  const line = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between border-b border-white/5 py-2"><span className="text-white/55">{k}</span><span>{v}</span></div>
  );
  return (
    <div className="max-w-[760px] text-lg text-white">
      {info && (
        <>
          {line("Version", info.version)}
          {line("Platform", `${info.os} ${info.arch}`)}
          {line("Native player (mpv)", info.mpvPath ?? "not found — install mpv for MKV/HEVC/local files")}
          {line("System audio switching", info.canSwitchAudioOutput ? "available" : "per-playback only")}
        </>
      )}
      {caps && line("WebView codecs", Object.entries(caps.html5Codecs).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(", ") + (caps.hlsNative ? ", HLS" : ""))}
      {health && [...health].map(([id, h]) => line(`Provider ${id}`, `${h.status}${h.latencyMs ? ` · ${h.latencyMs} ms` : ""}${h.message ? ` · ${h.message}` : ""}`))}
      {info?.notes.map((n) => <p key={n} className="mt-3 text-base text-white/50">{n}</p>)}
    </div>
  );
}

export function SettingsPage({ section }: { section?: string }) {
  const [active, setActive] = useState<Section>((SECTIONS as readonly string[]).includes(section ?? "") ? (section as Section) : "subscriptions");
  return (
    <div className="flex gap-10 pb-16 pl-10 pt-2">
      <nav className="flex w-64 shrink-0 flex-col gap-1">
        {SECTIONS.map((s) => (
          <button key={s} data-nav-row={`settings-nav-${s}`} onClick={() => setActive(s)} onFocus={() => setActive(s)} className={`tv-focus rounded-xl px-5 py-3 text-left text-lg ${active === s ? "bg-white/12 text-white" : "text-white/60"}`}>{LABEL[s]}</button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 pr-10">
        <SectionTitle>{LABEL[active]}</SectionTitle>
        {active === "subscriptions" && <Subscriptions />}
        {active === "addons" && <Addons />}
        {active === "display" && <DisplayAudio />}
        {active === "remote" && <Remote />}
        {active === "playback" && <Playback />}
        {active === "startup" && <Startup />}
        {active === "diagnostics" && <Diagnostics />}
      </div>
    </div>
  );
}
