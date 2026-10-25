import { useEffect, useState } from "react";
import {
  graphicsInfo, graphicsRestoreDefaults, graphicsSet, pickTexturePack, textureFolderOpen, texturePackInspect, texturePackInstall, texturePackRemove, texturePackSetEnabled,
  type Backend, type GraphicsInfo, type GraphicsPreset, type GraphicsSettings, type PackPreview,
} from "../lib/bridge";
import { useApp } from "../store/app";

/** Wii native output is ~480p; each step is a multiple of it. */
const RES_LABEL: Record<number, string> = { 1: "Native (480p)", 2: "2× (≈ 720p)", 3: "3× (≈ 1080p)", 4: "4× (≈ 1440p)", 5: "5× (≈ 1800p)", 6: "6× (≈ 4K)", 7: "7×", 8: "8× (≈ 5K)" };
const PRESETS: { id: Exclude<GraphicsPreset, "custom">; title: string; blurb: string; tint: string }[] = [
  { id: "performance", title: "Performance", blurb: "Smoothest four-player split screen", tint: "from-emerald-500/25" },
  { id: "balanced", title: "Balanced", blurb: "Recommended: sharp and stable", tint: "from-accent/30" },
  { id: "ultra", title: "Ultra", blurb: "Very sharp, still light on your Mac", tint: "from-amber-500/25" },
  { id: "fourK", title: "4K", blurb: "Sharpest, for a 4K TV, one player", tint: "from-sky-500/25" },
];
const ASPECTS = [["auto", "Auto"], ["wide", "16:9"], ["standard", "4:3"], ["stretch", "Stretch to window"]] as const;
const SHADERS = [["hybrid", "Hybrid ubershaders (low stutter)"], ["skipDrawing", "Skip drawing until ready (lowest cost)"], ["synchronous", "Synchronous (may stutter)"]] as const;
const BACKEND_LABEL: Record<Backend, string> = { dolphinDefault: "Dolphin's choice", metal: "Metal", vulkan: "Vulkan", openGl: "OpenGL", d3d11: "Direct3D 11", d3d12: "Direct3D 12" };

const mb = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.round(b / (1 << 20))} MB`);
const next = <T,>(list: readonly T[], v: T) => list[(list.indexOf(v) + 1) % list.length]!;

/** Turns Dolphin's raw config values into words. */
function human(label: string, v: string): string {
  const on = v === "True" ? "On" : v === "False" ? "Off" : null;
  if (on) return on;
  switch (label) {
    case "Internal resolution": return RES_LABEL[Number(v)] ?? `${v}×`;
    case "Anisotropic filtering": return `${2 ** Number(v)}×`;
    case "Aspect ratio": return ["Auto", "16:9", "4:3", "Stretch"][Number(v)] ?? v;
    case "Anti-aliasing": return Number(v) <= 1 ? "Off" : `${v}× MSAA`;
    case "Edge smoothing (FXAA)": return v === "FXAA" ? "On" : v || "Off";
    case "Shader compilation": return ["Synchronous", "Synchronous ubershaders", "Hybrid ubershaders", "Skip drawing"][Number(v)] ?? v;
    default: return v;
  }
}

function Row({ label, value, hint, onClick, disabled }: { label: string; value: string; hint?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button data-nav-row={`gfx-${label}`} disabled={disabled} onClick={onClick} className="tv-focus flex w-full items-center justify-between gap-6 rounded-xl bg-ink-800 px-5 py-3.5 text-left text-white disabled:opacity-40">
      <span>
        <span className="block text-lg">{label}</span>
        {hint && <span className="block text-sm text-white/45">{hint}</span>}
      </span>
      <span className="shrink-0 rounded-lg bg-white/10 px-3 py-1 text-lg font-semibold">{value}</span>
    </button>
  );
}

function Step({ n, title, state, detail }: { n: number; title: string; state: "done" | "todo" | "warn"; detail: string }) {
  const tone = state === "done" ? "bg-emerald-500 text-black" : state === "warn" ? "bg-amber-400 text-black" : "bg-white/10 text-white/50";
  return (
    <div className="flex flex-1 flex-col gap-2 rounded-2xl bg-ink-800 p-4">
      <span className={`flex h-8 w-8 items-center justify-center rounded-full text-base font-bold ${tone}`}>{state === "done" ? "✓" : state === "warn" ? "!" : n}</span>
      <span className="text-lg font-semibold text-white">{title}</span>
      <span className="text-sm leading-snug text-white/55">{detail}</span>
    </div>
  );
}

export function GameGraphicsPage() {
  const { toast, navigate } = useApp();
  const [info, setInfo] = useState<GraphicsInfo | null>(null);
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showReadme, setShowReadme] = useState(false);

  const load = () => graphicsInfo().then(setInfo).catch((e) => toast(String(e), "error"));
  useEffect(() => {
    void load();
    const t = window.setInterval(load, 1500);
    return () => clearInterval(t);
  }, []);

  const run = async (f: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await f();
      if (ok) toast(ok);
      await load();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  if (!info) return null;
  const s = info.settings;
  const custom = (patch: Partial<GraphicsSettings>) => run(() => graphicsSet("custom", { ...s, ...patch }));
  const pack = info.pack;
  const m = pack?.manifest ?? null;
  const job = info.job;
  const installing = !!job && !job.finished;
  const aa = info.effective.find((e) => e.label === "Anti-aliasing");
  const choose = (folder: boolean) =>
    run(async () => {
      const path = await pickTexturePack(folder);
      if (path) setPreview(await texturePackInspect(path));
    });

  // The four states are separate claims, each with its own evidence.
  const installedOk = !!m && pack!.filesPresent === m.textures;
  const steps = [
    { title: "Imported", state: m || preview || installing ? "done" : "todo", detail: m ? `${m.name}${m.version ? ` ${m.version}` : ""} passed the safety checks` : installing ? "Passed the safety checks" : preview ? "Checked: review it below" : "Choose your downloaded pack" },
    { title: "Installed", state: installedOk ? "done" : m ? "warn" : "todo", detail: m ? `${pack!.filesPresent} of ${m.textures} textures in Dolphin's folder` : "Copied into Dolphin's Load/Textures" },
    { title: "Enabled in Dolphin", state: pack?.discoverable ? "done" : m ? "warn" : "todo", detail: pack?.discoverable ? `Dolphin's lookup finds it for ${info.gameId}, and HD textures are switched on at launch` : m ? "Switched off: the game uses its original textures" : "Load Custom Textures, for this game only" },
    { title: "Confirmed loading", state: info.confirmedLoaded ? "done" : "todo", detail: info.confirmedLoaded ? `Dolphin's log shows ${info.confirmedLoaded} HD textures loaded this session` : pack?.discoverable ? "Not confirmed yet: start the game and race; MonitorOS reads Dolphin's log" : "Needs the steps before it" },
  ] as const;

  return (
    <div className="pb-20">
      <div className="relative overflow-hidden px-10 pb-8 pt-6">
        <div className="absolute inset-0 bg-gradient-to-br from-red-600/30 via-ink-950 to-blue-600/25" />
        <div className="relative">
          <button data-nav-row="gfx-top" onClick={() => navigate({ name: "games" })} className="tv-focus mb-4 rounded-full bg-white/10 px-4 py-1.5 text-base text-white">‹ Games</button>
          <h1 className="text-5xl font-extrabold tracking-tight text-white">{info.marioKartWii ? "Mario Kart Wii" : info.gameId ?? "No game chosen"}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-base">
            <span className="rounded-full bg-white/15 px-3 py-0.5 font-semibold text-white">Graphics &amp; Enhancements</span>
            {info.gameId && <span className="rounded-full bg-white/10 px-3 py-0.5 text-white/80">{info.gameId}</span>}
            <span className="rounded-full bg-white/10 px-3 py-0.5 text-white/80">{info.region}</span>
            {info.running && <span className="rounded-full bg-amber-400/20 px-3 py-0.5 text-amber-300">Playing now: changes apply next launch</span>}
          </div>
          {info.dolphinError && <p className="mt-3 text-lg text-amber-300">{info.dolphinError}</p>}
        </div>
      </div>

      <div className="max-w-[75rem] px-10">
        <h2 className="mb-3 text-2xl font-bold text-white">Graphics preset</h2>
        <div className="mb-3 grid grid-cols-5 gap-4">
          {PRESETS.map((p) => {
            const ps = info.presets.find(([id]) => id === p.id)?.[1];
            const on = info.preset === p.id;
            return (
              <button key={p.id} data-nav-row="gfx-presets" data-nav-default={on || undefined} disabled={busy} onClick={() => run(() => graphicsSet(p.id), `${p.title} preset saved`)} className={`tv-focus relative flex h-44 flex-col justify-between overflow-hidden rounded-2xl bg-gradient-to-br ${p.tint} to-ink-800 p-5 text-left ${on ? "ring-4 ring-white" : ""}`}>
                {on && <span className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white text-lg font-bold text-black">✓</span>}
                <span>
                  <span className="block text-2xl font-bold text-white">{p.title}</span>
                  <span className="block text-base text-white/60">{p.blurb}</span>
                </span>
                {ps && <span className="text-base text-white/80">{RES_LABEL[ps.internalResolution]} · {ps.anisotropy}× filtering{ps.fxaa ? " · FXAA" : ""}</span>}
              </button>
            );
          })}
          <button data-nav-row="gfx-presets" disabled={busy} onClick={() => run(() => graphicsSet("custom", s))} className={`tv-focus flex h-44 flex-col justify-between rounded-2xl bg-ink-800 p-5 text-left ${info.preset === "custom" ? "ring-4 ring-white" : ""}`}>
            <span>
              <span className="block text-2xl font-bold text-white">Custom</span>
              <span className="block text-base text-white/60">Your own settings below</span>
            </span>
            <span className="text-base text-white/80">{RES_LABEL[s.internalResolution]}</span>
          </button>
        </div>
        <p className="mb-10 text-base text-white/45">Presets are passed to Dolphin each time MonitorOS starts the game. Your Dolphin settings files and controller setup are never changed, and the game&apos;s own required settings still win.</p>

        <h2 className="mb-3 text-2xl font-bold text-white">HD texture pack</h2>
        <div className="mb-4 flex gap-3">
          {steps.map((st, i) => <Step key={st.title} n={i + 1} title={st.title} state={st.state} detail={st.detail} />)}
        </div>

        {m && (
          <div className="mb-4 rounded-2xl bg-ink-800 p-5 text-white">
            <div className="text-xl font-semibold">{m.name} {m.version && <span className="text-white/50">v{m.version}</span>}</div>
            <div className="text-base text-white/55">{m.authors ? `By ${m.authors} · ` : ""}{m.textures} textures · {mb(m.bytes)} · for {m.packId} ({m.packId.length === 3 ? "all regions" : "this region only"})</div>
            <div className="mt-1 truncate text-sm text-white/40">{pack!.folder}</div>
          </div>
        )}

        {installing && (
          <div className="mb-4 rounded-2xl bg-ink-800 p-5">
            <div className="mb-2 text-lg text-white">Installing… {job.done} / {job.total || "?"} textures</div>
            <div className="h-3 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-accent transition-all" style={{ width: `${job.total ? (100 * job.done) / job.total : 2}%` }} /></div>
          </div>
        )}
        {job?.finished && job.error && <p className="mb-4 rounded-xl bg-red-500/15 px-5 py-3 text-lg text-red-300">Install failed and nothing was changed: {job.error}</p>}

        {preview && !installing && (
          <div className="mb-4 rounded-2xl border border-white/15 bg-ink-850 p-6 text-white">
            <div className="text-sm uppercase tracking-wider text-white/45">Import preview</div>
            <div className="mt-1 text-2xl font-bold">{preview.name} {preview.version && <span className="text-white/50">v{preview.version}</span>}</div>
            {preview.authors && <div className="text-base text-white/55">By {preview.authors}</div>}
            <dl className="mt-4 grid grid-cols-[14rem_1fr] gap-y-1.5 text-lg">
              <dt className="text-white/45">Textures</dt><dd>{preview.textures} Dolphin textures</dd>
              <dt className="text-white/45">Disk space needed</dt><dd>{mb(preview.textureBytes)}</dd>
              <dt className="text-white/45">Matches game ID</dt><dd>{preview.packId} · {preview.regions}</dd>
              <dt className="text-white/45">Your game</dt>
              <dd className={preview.compatible === false ? "text-red-300" : "text-emerald-300"}>{preview.gameId ? `${preview.gameId}: ${preview.compatible ? "compatible" : "not compatible"}` : "Choose your game file first"}</dd>
              <dt className="text-white/45">Pack folder</dt><dd className="truncate">{preview.root}</dd>
              <dt className="text-white/45">Source</dt><dd className="truncate text-white/70">{preview.source} (kept as is)</dd>
            </dl>
            {preview.warnings.length > 0 && (
              <ul className="mt-4 list-disc space-y-1 pl-6 text-base text-amber-200/90">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            )}
            {preview.instructions.length > 0 && (
              <button data-nav-row="gfx-preview" onClick={() => setShowReadme(!showReadme)} className="tv-focus mt-4 rounded-lg bg-white/10 px-4 py-1.5 text-base">{showReadme ? "Hide" : "Show"} the pack&apos;s readme ({preview.instructions.length} files)</button>
            )}
            {showReadme && preview.instructions.map((i) => (
              <div key={i.file} className="mt-3"><div className="text-sm text-white/45">{i.file}</div><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-sm text-white/75">{i.text}</pre></div>
            ))}
            <div className="mt-5 flex gap-3">
              <button data-nav-row="gfx-preview-go" data-nav-default disabled={busy || info.running || preview.compatible === false} onClick={() => run(async () => { await texturePackInstall(preview.source); setPreview(null); })} className="tv-focus rounded-xl bg-white px-6 py-3 text-lg font-semibold text-black disabled:opacity-40">{m ? "Replace installed pack" : "Install"}</button>
              <button data-nav-row="gfx-preview-go" onClick={() => setPreview(null)} className="tv-focus rounded-xl bg-white/10 px-5 py-3 text-lg text-white">Cancel</button>
            </div>
          </div>
        )}

        <div className="mb-10 flex flex-wrap gap-3">
          <button data-nav-row="gfx-pack" disabled={busy || installing || info.running} onClick={() => choose(false)} className="tv-focus rounded-xl bg-white px-5 py-3 text-lg font-semibold text-black disabled:opacity-40">{m ? "Replace with a ZIP…" : "Import ZIP…"}</button>
          <button data-nav-row="gfx-pack" disabled={busy || installing || info.running} onClick={() => choose(true)} className="tv-focus rounded-xl bg-white/10 px-5 py-3 text-lg text-white disabled:opacity-40">Import extracted folder…</button>
          {m && <button data-nav-row="gfx-pack" disabled={busy || info.running} onClick={() => run(() => texturePackSetEnabled(!pack!.enabled), pack!.enabled ? "HD textures off: original textures restored" : "HD textures on")} className="tv-focus rounded-xl bg-white/10 px-5 py-3 text-lg text-white disabled:opacity-40">{pack!.enabled ? "Turn HD textures off" : "Turn HD textures on"}</button>}
          <button data-nav-row="gfx-pack" disabled={!info.userDir} onClick={() => run(textureFolderOpen)} className="tv-focus rounded-xl bg-white/10 px-5 py-3 text-lg text-white disabled:opacity-40">Open texture folder</button>
          {m && (confirmRemove
            ? <button data-nav-row="gfx-pack" onClick={() => run(async () => { await texturePackRemove(); setConfirmRemove(false); }, "Removed MonitorOS's copy; your download is untouched")} className="tv-focus rounded-xl bg-red-500/80 px-5 py-3 text-lg font-semibold text-white">Confirm: delete installed copy ({mb(m.bytes)})</button>
            : <button data-nav-row="gfx-pack" disabled={info.running} onClick={() => setConfirmRemove(true)} className="tv-focus rounded-xl bg-white/10 px-5 py-3 text-lg text-white/70 disabled:opacity-40">Remove…</button>)}
        </div>

        <h2 className="mb-3 text-2xl font-bold text-white">Advanced settings</h2>
        <p className="mb-3 text-base text-white/45">Changing any of these switches to Custom.</p>
        <div className="mb-4 grid grid-cols-2 gap-3">
          <Row label="Internal resolution" value={RES_LABEL[s.internalResolution] ?? ""} hint="Higher is sharper and uses more GPU" onClick={() => custom({ internalResolution: (s.internalResolution % 6) + 1 })} />
          <Row label="Anisotropic filtering" value={`${s.anisotropy}×`} hint="Sharper textures at angles" onClick={() => custom({ anisotropy: next([1, 2, 4, 8, 16], s.anisotropy) })} />
          <Row label="Aspect ratio" value={ASPECTS.find(([v]) => v === s.aspect)?.[1] ?? ""} onClick={() => custom({ aspect: next(ASPECTS.map(([v]) => v), s.aspect) })} />
          <Row label="Anti-aliasing" value={s.msaa <= 1 ? "Off" : `${s.msaa}× MSAA`} hint={aa?.overriddenBy ? `Mario Kart Wii needs it off (${aa.overriddenBy})` : "Smooths jagged edges"} onClick={() => custom({ msaa: next([1, 2, 4, 8], s.msaa) })} />
          <Row label="Edge smoothing (FXAA)" value={s.fxaa ? "On" : "Off"} hint="Smooths jagged edges; works where anti-aliasing can't" onClick={() => custom({ fxaa: !s.fxaa })} />
          <Row label="Shader compilation" value={SHADERS.find(([v]) => v === s.shaders)?.[1].split(" (")[0] ?? ""} hint={SHADERS.find(([v]) => v === s.shaders)?.[1].split(" (")[1]?.replace(")", "")} onClick={() => custom({ shaders: next(SHADERS.map(([v]) => v), s.shaders) })} />
          <Row label="V-Sync" value={s.vsync ? "On" : "Off"} hint="Stops tearing; off can lower latency" onClick={() => custom({ vsync: !s.vsync })} />
          <Row label="Prefetch HD textures" value={s.prefetchTextures ? "On" : "Off"} hint="Loads the whole pack into memory at start" onClick={() => custom({ prefetchTextures: !s.prefetchTextures })} />
          <Row label="Graphics backend" value={BACKEND_LABEL[s.backend]} onClick={() => custom({ backend: next(info.backends, s.backend) })} />
          <Row label="Full screen" value={s.fullscreen ? "On" : "Off"} onClick={() => custom({ fullscreen: !s.fullscreen })} />
          <Row label="Restore defaults" value="Balanced" hint="Resets MonitorOS's graphics settings for this game" disabled={busy} onClick={() => run(graphicsRestoreDefaults, "Graphics restored to Balanced")} />
        </div>

        <h2 className="mb-3 mt-8 text-2xl font-bold text-white">What Dolphin will use</h2>
        <div className="mb-10 overflow-hidden rounded-2xl bg-ink-800">
          {info.effective.map((e) => (
            <div key={e.label} className="flex items-center justify-between border-b border-white/5 px-5 py-2.5 text-lg last:border-0">
              <span className="text-white/60">{e.label}</span>
              <span className="text-right">
                <span className={e.overriddenBy ? "text-amber-300" : "text-white"}>{human(e.label, e.effective)}</span>
                {e.overriddenBy && <span className="block text-sm text-white/45">Set by {e.overriddenBy} (asked for {human(e.label, e.requested)})</span>}
              </span>
            </div>
          ))}
          {!info.effective.length && <p className="px-5 py-4 text-white/45">Dolphin isn&apos;t available.</p>}
        </div>

        <h2 className="mb-3 text-2xl font-bold text-white">Troubleshooting</h2>
        <ul className="space-y-2 text-lg">
          <Check ok={!info.dolphinError} text={info.dolphinError ?? `Dolphin found; its user folder is ${info.userDir}`} />
          <Check ok={!!info.gameId} text={info.gameId ? `Game ID ${info.gameId} (${info.region}) read from your game file` : "Couldn't read a game ID: choose the game file on the Games page"} />
          {info.gameId && !info.marioKartWii && <Check ok={false} text="This isn't Mario Kart Wii, so the HD Remaster pack won't apply to it" />}
          {m && <Check ok={installedOk} text={installedOk ? "Every installed texture is present" : `Only ${pack!.filesPresent} of ${m.textures} textures are present: import the pack again`} />}
          {m && <Check ok={!!pack!.discoverable || !pack!.enabled} text={pack!.discoverable ? "Dolphin's folder rules find the pack for this game" : pack!.enabled ? "Dolphin's folder rules don't find the pack for this game ID" : "The pack is switched off"} />}
          {pack?.otherFolders.map((f) => <Check key={f} ok={false} text={`Dolphin also loads textures from ${f} (not managed by MonitorOS). Move it out of Load/Textures if textures look mixed.`} />)}
          {pack?.discoverable && !info.confirmedLoaded && <Check ok={false} text="Loading not confirmed yet. Start the game from MonitorOS; Dolphin's log is checked while you play." />}
          <li className="pt-2 text-base text-white/45">Manual install instead: copy the pack&apos;s <b>RMC</b> folder into {info.texturesFolder ?? "Dolphin's Load/Textures folder"} and turn on Graphics › Advanced › Load Custom Textures in Dolphin.</li>
        </ul>
      </div>
    </div>
  );
}

function Check({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className="flex gap-3 text-white/80">
      <span className={ok ? "text-emerald-400" : "text-amber-300"}>{ok ? "✓" : "!"}</span>
      <span>{text}</span>
    </li>
  );
}
