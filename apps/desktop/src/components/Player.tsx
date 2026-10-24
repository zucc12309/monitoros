import { useEffect, useRef, useState } from "react";
import { reducePlayer, shouldPersist, type PlayerState } from "@monitoros/player";
import { listen, playerCommand, playerStop } from "../lib/bridge";
import { useApp, type NowPlaying } from "../store/app";

function fmt(sec: number) {
  if (!Number.isFinite(sec)) return "0:00";
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${m.toString().padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function useProgressSaver(np: NowPlaying) {
  const saveProgress = useApp((s) => s.saveProgress);
  const lastSaved = useRef(np.startSec);
  return (pos: number, dur: number, force = false) => {
    if (!dur || !shouldPersist(lastSaved.current, pos, force)) return;
    lastSaved.current = pos;
    saveProgress({
      mediaId: np.item.id,
      item: np.item,
      title: np.item.title,
      positionSec: pos,
      durationSec: dur,
      updatedAt: Date.now(),
      episode: np.episode,
      episodeLabel: np.episode ? `S${np.episode.season} E${np.episode.episode}` : undefined,
    });
  };
}

/** Native (mpv) session: mpv owns the window; we show a slim status bar and mirror progress. */
function NativeSession({ np }: { np: NowPlaying }) {
  const stopPlayback = useApp((s) => s.stopPlayback);
  const save = useProgressSaver(np);
  const [state, setState] = useState<PlayerState>({ status: "loading", sourceId: np.source.id });
  const dur = useRef(0);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<{ type: string; position?: number; duration?: number; paused?: boolean; buffering?: boolean; reason?: string }>("player://event", (e) => {
      setState((s) => {
        switch (e.type) {
          case "duration":
            dur.current = e.duration ?? 0;
            return reducePlayer(s, { type: "ready", durationSec: dur.current, startAt: np.startSec });
          case "time":
            save(e.position ?? 0, dur.current);
            return reducePlayer(s, { type: "time", positionSec: e.position ?? 0 });
          case "pause":
            return reducePlayer(s, { type: e.paused ? "pause" : "resume" });
          case "buffering":
            return e.buffering ? reducePlayer(s, { type: "buffering" }) : s;
          case "ended":
          case "exited":
            if ("positionSec" in s) save(s.positionSec, dur.current, true);
            stopPlayback();
            return reducePlayer(s, { type: "ended" });
          default:
            return s;
        }
      });
    }).then((u) => (un = u));
    return () => un?.();
  }, [np, save, stopPlayback]);

  const pos = "positionSec" in state ? state.positionSec : 0;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-6 bg-black/85 px-10 py-5 text-white backdrop-blur">
      <div className="min-w-0 flex-1">
        <div className="truncate text-xl font-semibold">Playing in native player · {np.item.title}</div>
        <div className="text-white/60">{state.status === "buffering" ? "Buffering…" : state.status === "loading" ? "Starting mpv…" : `${fmt(pos)} / ${fmt(dur.current)}`}</div>
      </div>
      <button data-nav-row="np" className="tv-focus rounded-lg bg-white/10 px-5 py-3" onClick={() => playerCommand({ type: "toggle-pause" })}>Play/Pause</button>
      <button data-nav-row="np" className="tv-focus rounded-lg bg-white/10 px-5 py-3" onClick={() => playerCommand({ type: "cycle-subtitles" })}>Subtitles</button>
      <button data-nav-row="np" className="tv-focus rounded-lg bg-white/10 px-5 py-3" onClick={() => playerCommand({ type: "cycle-audio" })}>Audio track</button>
      <button
        data-nav-row="np"
        className="tv-focus rounded-lg bg-red-500/80 px-5 py-3"
        onClick={() => {
          save(pos, dur.current, true);
          void playerStop().finally(stopPlayback);
        }}
      >
        Stop
      </button>
    </div>
  );
}

/** In-app <video> session with hls.js for HLS where the WebView lacks native support. */
function Html5Session({ np }: { np: NowPlaying }) {
  const ref = useRef<HTMLVideoElement>(null);
  const stopPlayback = useApp((s) => s.stopPlayback);
  const toast = useApp((s) => s.toast);
  const save = useProgressSaver(np);
  const [state, setState] = useState<PlayerState>({ status: "loading", sourceId: np.source.id });
  const [showUi, setShowUi] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const v = ref.current!;
    let hls: { destroy(): void } | undefined;
    const isHls = np.source.kind === "hls" || /\.m3u8(\?|$)/i.test(np.source.url);
    if (isHls && !v.canPlayType("application/vnd.apple.mpegurl")) {
      void import("hls.js").then(({ default: Hls }) => {
        if (!Hls.isSupported()) return setState((s) => reducePlayer(s, { type: "error", message: "HLS is not supported here", retryable: false }));
        const h = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 30 });
        h.loadSource(np.source.url);
        h.attachMedia(v);
        h.on(Hls.Events.ERROR, (_e, data) => data.fatal && setState((s) => reducePlayer(s, { type: "error", message: `Stream error: ${data.details}` })));
        hls = h;
      });
    } else {
      v.src = np.source.url;
    }
    return () => {
      hls?.destroy();
      v.removeAttribute("src");
      v.load();
    };
  }, [np]);

  const poke = () => {
    setShowUi(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowUi(false), 3500);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = ref.current;
      if (!v) return;
      poke();
      // On the error overlay, let OK activate the focused button; only Back exits.
      if (state.status === "error") {
        if (e.key === "Escape" || e.key === "Backspace") {
          e.preventDefault();
          stopPlayback();
        }
        return;
      }
      if (e.key === " " || e.key === "MediaPlayPause" || e.key === "Enter") {
        e.preventDefault();
        void (v.paused ? v.play() : v.pause());
      } else if (e.key === "ArrowRight") v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
      else if (e.key === "ArrowLeft") v.currentTime = Math.max(0, v.currentTime - 10);
      else if (e.key === "ArrowUp") v.volume = Math.min(1, v.volume + 0.1);
      else if (e.key === "ArrowDown") v.volume = Math.max(0, v.volume - 0.1);
      else if (e.key === "Escape" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        save(v.currentTime, v.duration, true);
        stopPlayback();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const pos = "positionSec" in state ? state.positionSec : 0;
  const dur = "durationSec" in state ? state.durationSec : 0;
  return (
    <div className="fixed inset-0 z-40 bg-black" onMouseMove={poke}>
      <video
        ref={ref}
        className="h-full w-full"
        autoPlay
        playsInline
        // CORS mode breaks redirecting CDNs (archive.org); only needed for cross-origin VTT tracks.
        crossOrigin={np.source.subtitles?.some((t) => t.format === "vtt") ? "anonymous" : undefined}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (np.startSec > 0) v.currentTime = np.startSec;
          setState((s) => reducePlayer(s, { type: "ready", durationSec: v.duration, startAt: np.startSec }));
        }}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          setState((s) => reducePlayer(s, { type: "time", positionSec: v.currentTime }));
          save(v.currentTime, v.duration);
        }}
        onPause={(e) => {
          save(e.currentTarget.currentTime, e.currentTarget.duration, true);
          setState((s) => reducePlayer(s, { type: "pause" }));
        }}
        onPlay={() => setState((s) => reducePlayer(s, { type: "resume" }))}
        onWaiting={() => setState((s) => reducePlayer(s, { type: "buffering" }))}
        onEnded={(e) => {
          save(e.currentTarget.duration, e.currentTarget.duration, true);
          setState((s) => reducePlayer(s, { type: "ended" }));
          toast(`Finished ${np.item.title}`);
          stopPlayback();
        }}
        onError={() => setState((s) => reducePlayer(s, { type: "error", message: "This source could not be played. Try another source or install mpv." }))}
      >
        {np.source.subtitles?.filter((t) => t.format === "vtt").map((t) => <track key={t.id} kind="subtitles" src={t.url} srcLang={t.lang} label={t.lang} />)}
      </video>
      {(state.status === "loading" || state.status === "buffering") && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="h-16 w-16 animate-spin rounded-full border-4 border-white/20 border-t-white" />
        </div>
      )}
      {state.status === "error" && (
        <div className="absolute inset-0 grid place-items-center bg-black/80 text-center text-white">
          <div>
            <p className="text-2xl">{state.message}</p>
            <button autoFocus className="tv-focus mt-6 rounded-xl bg-white px-8 py-3 text-xl text-black" onClick={stopPlayback}>Back</button>
          </div>
        </div>
      )}
      <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-12 pb-10 pt-24 text-white transition-opacity ${showUi ? "opacity-100" : "opacity-0"}`}>
        <div className="text-3xl font-bold">{np.item.title}</div>
        <div className="mt-1 text-white/60">{np.source.title} · {np.source.provenance.replace("-", " ")}</div>
        <div className="mt-5 flex items-center gap-4">
          <span className="tabular-nums">{fmt(pos)}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/20">
            <div className="h-full bg-accent" style={{ width: `${dur ? (pos / dur) * 100 : 0}%` }} />
          </div>
          <span className="tabular-nums">{fmt(dur)}</span>
        </div>
        <div className="mt-3 text-sm text-white/50">OK / Space: play-pause · ←/→: seek 10s · ↑/↓: volume · Back: exit</div>
      </div>
    </div>
  );
}

export function PlayerHost() {
  const np = useApp((s) => s.nowPlaying);
  if (!np) return null;
  return np.route === "mpv" ? <NativeSession np={np} /> : <Html5Session np={np} />;
}
