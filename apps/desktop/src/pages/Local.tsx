import { useEffect, useState } from "react";
import type { MediaItem, PlaybackSource } from "@monitoros/contracts";
import { channelToItem, parseM3U, type Channel } from "@monitoros/metadata";
import { paletteFor } from "@monitoros/provider-sdk";
import { SectionTitle } from "../components/Chrome";
import { FolderIcon, PlayIcon } from "../components/icons";
import { fetchText, isTauri, libraryAddRoot, libraryItems, libraryRemoveRoot, libraryRescan, libraryRoots, pickFolder, type LibraryItem } from "../lib/bridge";
import { startPlayback } from "../lib/playback";
import { useApp } from "../store/app";

function localToItem(l: LibraryItem): MediaItem {
  const title = l.season ? `${l.title} S${l.season}E${l.episode}` : l.title;
  return {
    id: `local:${l.id}`,
    ids: { local: l.id },
    type: "local",
    title,
    year: l.year,
    genres: [],
    languages: [],
    artwork: { palette: paletteFor(l.title) },
    availability: [{ providerId: "local", access: "local", source: "local-scan" }],
  };
}

export function LibraryPage() {
  const toast = useApp((s) => s.toast);
  const [roots, setRoots] = useState<string[]>([]);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setRoots(await libraryRoots());
    setItems(await libraryItems());
  };
  useEffect(() => void refresh(), []);

  const add = async () => {
    const path = await pickFolder();
    if (!path) return;
    setBusy(true);
    try {
      const found = await libraryAddRoot(path);
      toast(`Found ${found.length} videos in ${path.split(/[\\/]/).pop()}`);
      await refresh();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const play = (l: LibraryItem) => {
    const source: PlaybackSource = { id: `local#${l.id}`, providerId: "local", kind: "local-file", url: l.path, title: l.path.split(/[\\/]/).pop() ?? l.title, access: "local", provenance: "user-provided", drm: false };
    void startPlayback(localToItem(l), source);
  };

  if (!isTauri) {
    return (
      <div className="pl-10 pt-2 pr-10 text-lg text-white/60">
        <SectionTitle>Local Library</SectionTitle>
        Local files play through the native player, which is available in the MonitorOS desktop app (not the browser preview).
      </div>
    );
  }

  return (
    <div className="pb-16 pl-10 pt-2 pr-10">
      <SectionTitle
        action={
          <div className="flex gap-3">
            <button data-nav-row="lib-actions" onClick={() => void add()} disabled={busy} className="tv-focus flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-lg font-semibold text-black">
              <FolderIcon className="h-5 w-5" /> {busy ? "Scanning…" : "Add folder"}
            </button>
            {roots.length > 0 && (
              <button data-nav-row="lib-actions" onClick={() => void libraryRescan().then(refresh)} className="tv-focus rounded-xl bg-white/10 px-5 py-3 text-lg text-white">Rescan</button>
            )}
          </div>
        }
      >
        Local Library
      </SectionTitle>
      <p className="-mt-2 mb-5 text-lg text-white/50">MonitorOS only scans folders you add here — USB drives, external disks and mounted network shares (SMB/NAS) all work.</p>
      <div className="mb-8 flex flex-wrap gap-3">
        {roots.map((r) => (
          <span key={r} className="flex items-center gap-3 rounded-full bg-ink-800 py-2 pl-5 pr-2 text-white/80">
            {r}
            <button data-nav-row="lib-roots" onClick={() => void libraryRemoveRoot(r).then(refresh)} className="tv-focus rounded-full bg-white/10 px-3 py-1 text-sm">Remove</button>
          </span>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="text-lg text-white/40">No videos yet.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(22.5rem,1fr))] gap-4">
          {items.map((l, idx) => (
            <button key={l.id} data-nav-row={`lib-${Math.floor(idx / 4)}`} onClick={() => play(l)} className="tv-focus flex items-center gap-4 rounded-xl bg-ink-800 p-4 text-left text-white">
              <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg" style={{ background: `linear-gradient(135deg, ${paletteFor(l.title).join(",")})` }}>
                <PlayIcon className="h-6 w-6" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-lg font-semibold">{l.title}{l.season ? ` · S${l.season}E${l.episode}` : ""}</span>
                <span className="block truncate text-sm text-white/45">{l.year ?? ""} {(l.sizeBytes / 1e9).toFixed(1)} GB{l.subtitles.length ? ` · ${l.subtitles.length} subtitle file(s)` : ""}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LivePage() {
  const { settings, updateSettings, toast } = useApp();
  const [channels, setChannels] = useState<{ playlist: string; channels: Channel[] }[]>([]);
  const [url, setUrl] = useState("");
  const [allowLan, setAllowLan] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all(
      settings.iptvPlaylists.map(async (p) => {
        try {
          return { playlist: p.name, channels: parseM3U(await fetchText(p.url, p.allowLan), { allowPrivateNetwork: p.allowLan }).channels.map((c) => ({ ...c, id: `${p.id}:${c.id}` })) };
        } catch (e) {
          toast(`${p.name}: ${(e as Error).message}`, "error");
          return { playlist: p.name, channels: [] };
        }
      }),
    ).then((r) => alive && setChannels(r));
    return () => {
      alive = false;
    };
  }, [settings.iptvPlaylists, toast]);

  const add = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const id = Math.random().toString(36).slice(2, 8);
    updateSettings({ iptvPlaylists: [...settings.iptvPlaylists, { id, name: new URL(trimmed).hostname, url: trimmed, allowLan }] });
    setUrl("");
  };

  const play = (c: Channel, playlistId: string) => {
    const item = channelToItem(c, playlistId);
    void startPlayback(item, { id: c.id, providerId: `iptv:${playlistId}`, kind: /\.m3u8/i.test(c.url) ? "hls" : "direct", url: c.url, title: c.name, access: "unknown", provenance: "user-provided", drm: false });
  };

  return (
    <div className="pb-16 pl-10 pt-2 pr-10">
      <SectionTitle>Live TV</SectionTitle>
      <p className="-mt-2 mb-5 max-w-[56.25rem] text-lg text-white/50">Add M3U playlists you are authorised to use (your IPTV provider, Jellyfin/Plex Live TV, or a public broadcaster's official feed). For DD channels, WAVES opens from Free.</p>
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <input data-nav-row="live-add" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/playlist.m3u" className="tv-focus w-[35rem] rounded-xl bg-ink-800 px-5 py-3 text-lg text-white outline-none" aria-label="Playlist URL" />
        <label className="flex items-center gap-2 text-white/70">
          <input data-nav-row="live-add" type="checkbox" checked={allowLan} onChange={(e) => setAllowLan(e.target.checked)} className="tv-focus h-5 w-5" /> On my home network
        </label>
        <button data-nav-row="live-add" onClick={add} className="tv-focus rounded-xl bg-white px-5 py-3 text-lg font-semibold text-black">Add playlist</button>
      </div>
      {settings.iptvPlaylists.length === 0 && <p className="text-lg text-white/40">No playlists yet.</p>}
      {channels.map((group, gi) => {
        const pl = settings.iptvPlaylists[gi]!;
        return (
          <section key={pl.id} className="mb-8">
            <div className="mb-3 flex items-center gap-4">
              <h3 className="text-2xl font-bold text-white">{group.playlist}</h3>
              <span className="text-white/40">{group.channels.length} channels</span>
              <button data-nav-row={`live-pl-${gi}`} onClick={() => updateSettings({ iptvPlaylists: settings.iptvPlaylists.filter((p) => p.id !== pl.id) })} className="tv-focus rounded-full bg-white/10 px-3 py-1 text-sm text-white">Remove</button>
            </div>
            <div className="no-scrollbar flex gap-4 overflow-x-auto py-2">
              {group.channels.slice(0, 200).map((c) => (
                <button key={c.id} data-nav-row={`live-ch-${gi}`} onClick={() => play(c, pl.id)} className="tv-focus flex h-28 w-52 shrink-0 flex-col items-center justify-center gap-2 rounded-xl bg-ink-800 p-3 text-white">
                  {c.logo ? <img src={c.logo} alt="" className="max-h-12 max-w-[80%] object-contain" referrerPolicy="no-referrer" /> : null}
                  <span className="line-clamp-1 text-base">{c.name}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
