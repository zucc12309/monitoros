import { useEffect, useRef, useState } from "react";
import { FREE_PROVIDERS, SUBSCRIPTION_SERVICES } from "@monitoros/metadata";
import { Logo } from "../components/icons";
import { isTauri, libraryAddRoot, pickFolder, remoteStart, setAutostart } from "../lib/bridge";
import { useApp } from "../store/app";

const LANGS: [string, string][] = [["hi", "Hindi"], ["en", "English"], ["ta", "Tamil"], ["te", "Telugu"], ["ml", "Malayalam"], ["kn", "Kannada"], ["bn", "Bengali"], ["mr", "Marathi"], ["ja", "Japanese"]];

export function OnboardingPage() {
  const { settings, updateSettings, navigate, toast } = useApp();
  const [step, setStep] = useState(0);
  const primary = useRef<HTMLButtonElement>(null);
  // Each step re-renders the button row (Back/Skip appear), which can drop
  // focus; put it back on the primary action so OK on the remote keeps working.
  useEffect(() => primary.current?.focus(), [step]);
  const steps = ["Welcome", "Languages", "Subscriptions", "Free", "Library", "Remote", "Startup"];
  const next = () => (step < steps.length - 1 ? setStep(step + 1) : finish());
  const finish = () => {
    updateSettings({ onboarded: true });
    navigate({ name: "home" });
  };

  const chip = (on: boolean) => `tv-focus rounded-xl px-6 py-4 text-xl font-semibold ${on ? "bg-accent text-white" : "bg-ink-800 text-white/70"}`;

  return (
    <div className="flex h-full flex-col items-center justify-center px-16 text-center text-white">
      <div className="mb-8 flex gap-2">
        {steps.map((s, i) => <span key={s} className={`h-1.5 w-10 rounded-full ${i <= step ? "bg-accent" : "bg-white/15"}`} />)}
      </div>

      {step === 0 && (
        <>
          <Logo className="mb-6 h-20 w-32" />
          <h1 className="text-6xl font-extrabold">Welcome to MonitorOS</h1>
          <p className="mt-5 max-w-[47.5rem] text-2xl text-white/65">Your computer becomes a Smart TV — and stays your computer. Switch back to the desktop any time with the Desktop button or Ctrl/Cmd + Shift + M.</p>
        </>
      )}
      {step === 1 && (
        <>
          <h1 className="text-5xl font-bold">What do you watch in?</h1>
          <div className="mt-10 flex max-w-[62.5rem] flex-wrap justify-center gap-3">
            {LANGS.map(([code, name], i) => {
              const on = settings.languages.includes(code);
              return <button key={code} data-nav-row={`ob-lang-${Math.floor(i / 5)}`} className={chip(on)} onClick={() => updateSettings({ languages: on ? settings.languages.filter((l) => l !== code) : [...settings.languages, code] })}>{name}</button>;
            })}
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <h1 className="text-5xl font-bold">Which services do you subscribe to?</h1>
          <p className="mt-3 text-xl text-white/55">Used to sort sources and your app row. MonitorOS never asks for passwords — you sign in on each service's own site or app.</p>
          <div className="mt-10 flex max-w-[68.75rem] flex-wrap justify-center gap-3">
            {SUBSCRIPTION_SERVICES.map((s, i) => {
              const on = settings.subscriptions.includes(s.id);
              return <button key={s.id} data-nav-row={`ob-subs-${Math.floor(i / 5)}`} className={chip(on)} onClick={() => updateSettings({ subscriptions: on ? settings.subscriptions.filter((x) => x !== s.id) : [...settings.subscriptions, s.id] })}>{s.name}</button>;
            })}
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <h1 className="text-5xl font-bold">Free to watch</h1>
          <div className="mt-10 grid max-w-[62.5rem] grid-cols-2 gap-4 text-left">
            {FREE_PROVIDERS.map((p) => (
              <div key={p.id} className="rounded-2xl bg-ink-800 p-5">
                <div className="text-xl font-bold">{p.name}</div>
                <div className="text-white/55">{p.description}</div>
              </div>
            ))}
          </div>
          <p className="mt-6 text-lg text-white/45">Add Stremio-compatible add-ons later in Settings › Add-ons.</p>
        </>
      )}
      {step === 4 && (
        <>
          <h1 className="text-5xl font-bold">Your own videos</h1>
          <p className="mt-3 text-xl text-white/55">Pick a folder (Movies, an external drive or a NAS share). Nothing else is scanned.</p>
          <button data-nav-row="ob-lib" className="tv-focus mt-10 rounded-xl bg-white px-8 py-4 text-xl font-semibold text-black" onClick={() => void (async () => {
            if (!isTauri) return toast("Folder access needs the desktop app", "error");
            const p = await pickFolder();
            if (p) toast(`Found ${(await libraryAddRoot(p)).length} videos`);
          })()}>Choose a folder</button>
        </>
      )}
      {step === 5 && (
        <>
          <h1 className="text-5xl font-bold">Use your iPhone as a remote</h1>
          <p className="mt-3 max-w-[51.25rem] text-xl text-white/55">Starts a server on your home network only. Each phone needs your approval and a code from this screen.</p>
          <button data-nav-row="ob-remote" className="tv-focus mt-10 rounded-xl bg-white px-8 py-4 text-xl font-semibold text-black" onClick={() => void (isTauri ? remoteStart().then(() => { updateSettings({ remoteEnabled: true }); navigate({ name: "settings", section: "remote" }); updateSettings({ onboarded: true }); }) : Promise.resolve(toast("The remote needs the desktop app", "error")))}>Set up remote</button>
        </>
      )}
      {step === 6 && (
        <>
          <h1 className="text-5xl font-bold">Startup</h1>
          <div className="mt-10 flex flex-col gap-3">
            <button data-nav-row="ob-start-1" className={chip(settings.launchAtLogin)} onClick={() => void setAutostart(!settings.launchAtLogin).then((on) => updateSettings({ launchAtLogin: on })).catch(() => toast("Launch at login needs the desktop app", "error"))}>Open MonitorOS when I log in</button>
            <button data-nav-row="ob-start-2" className={chip(settings.defaultMode === "tv")} onClick={() => updateSettings({ defaultMode: settings.defaultMode === "tv" ? "desktop" : "tv" })}>Start in TV Mode</button>
          </div>
        </>
      )}

      <div className="mt-14 flex gap-4">
        {step > 0 && <button data-nav-row="ob-nav" className="tv-focus rounded-xl bg-white/10 px-8 py-4 text-xl" onClick={() => setStep(step - 1)}>Back</button>}
        <button ref={primary} data-nav-row="ob-nav" className="tv-focus rounded-xl bg-white px-10 py-4 text-xl font-semibold text-black" onClick={next}>{step === steps.length - 1 ? "Start watching" : step === 0 ? "Get started" : "Continue"}</button>
        {step > 0 && step < steps.length - 1 && <button data-nav-row="ob-nav" className="tv-focus rounded-xl px-6 py-4 text-xl text-white/60" onClick={next}>Skip</button>}
      </div>
    </div>
  );
}
