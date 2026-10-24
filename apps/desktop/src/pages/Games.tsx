import { useEffect, useState } from "react";
import { SectionTitle } from "../components/Chrome";
import { gameInfo, gameLaunch, gameRemovePlayer, gameSetFile, gameStop, pickGameFile, type GameInfo } from "../lib/bridge";
import { useApp } from "../store/app";

const COLOURS = ["#3b82f6", "#ef4444", "#22c55e", "#eab308"];

/**
 * Local multiplayer through Dolphin. Phones paired as remotes tap
 * "🎮 Controller" to take a player slot; MonitorOS feeds them to Dolphin.
 * MonitorOS never downloads games: the player picks a game file they own.
 */
export function GamesPage() {
  const { toast, navigate } = useApp();
  const [info, setInfo] = useState<GameInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => gameInfo().then((i) => alive && setInfo(i)).catch(() => {});
    void load();
    const t = window.setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      setInfo(await gameInfo());
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const choose = () =>
    run(async () => {
      const path = await pickGameFile();
      if (path) await gameSetFile(path);
    });

  if (!info) return null;
  const joined = info.players.filter((p) => p.status !== "empty").length;

  return (
    <div className="pb-16 pl-10 pr-10 pt-2">
      <SectionTitle>Games</SectionTitle>
      <p className="-mt-2 mb-6 max-w-[56.25rem] text-lg text-white/50">
        Up to four phones become controllers. On each phone open the MonitorOS remote and tap <b className="text-white/80">🎮 Controller</b>. Games run in Dolphin, using a game file you own.
      </p>

      <div className="mb-8 grid max-w-[75rem] grid-cols-4 gap-4">
        {info.players.map((p) => (
          <div key={p.player} className="flex h-40 flex-col justify-between rounded-2xl bg-ink-800 p-5" style={{ boxShadow: p.status === "connected" ? `inset 0 0 0 3px ${COLOURS[p.player]}` : undefined }}>
            <span className="text-xl font-bold" style={{ color: COLOURS[p.player] }}>Player {p.player + 1}</span>
            <span className="truncate text-lg text-white/80">
              {p.status === "empty" ? <span className="text-white/35">Waiting for a phone…</span> : p.deviceName}
              {p.status === "reserved" && <span className="ml-2 text-sm text-amber-300">reconnecting</span>}
            </span>
            {p.status !== "empty" ? (
              <button data-nav-row="game-players" onClick={() => run(() => gameRemovePlayer(p.player))} className="tv-focus self-start rounded-full bg-white/10 px-3 py-1 text-sm text-white">Remove</button>
            ) : (
              <span className="h-7" />
            )}
          </div>
        ))}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <button data-nav-row="game-actions" data-nav-default disabled={busy || !info.gameFile || !!info.dolphinError} onClick={() => run(info.running ? gameStop : gameLaunch)} className="tv-focus rounded-xl bg-white px-6 py-3 text-lg font-semibold text-black disabled:opacity-40">
          {info.running ? "Stop game" : joined ? `Play with ${joined} player${joined > 1 ? "s" : ""}` : "Play"}
        </button>
        <button data-nav-row="game-actions" disabled={busy} onClick={choose} className="tv-focus rounded-xl bg-white/10 px-5 py-3 text-lg text-white">
          {info.gameFile ? "Change game" : "Choose game file"}
        </button>
        <button data-nav-row="game-actions" onClick={() => navigate({ name: "settings", section: "remote" })} className="tv-focus rounded-xl bg-white/10 px-5 py-3 text-lg text-white">Pair a phone</button>
      </div>

      <dl className="grid max-w-[56.25rem] grid-cols-[12rem_1fr] gap-y-2 text-lg">
        <dt className="text-white/45">Game</dt>
        <dd className="truncate text-white/85">{info.gameFile ?? "None chosen"}</dd>
        <dt className="text-white/45">Dolphin</dt>
        <dd className={info.dolphinError ? "text-amber-300" : "text-white/85"}>{info.dolphinError ?? `Version ${info.dolphinVersion}`}</dd>
        {info.error && (
          <>
            <dt className="text-white/45">Controllers</dt>
            <dd className="text-amber-300">{info.error}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
