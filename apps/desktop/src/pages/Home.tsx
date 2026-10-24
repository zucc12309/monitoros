import type { MediaItem } from "@monitoros/contracts";
import { HOME_ROWS, SUBSCRIPTION_SERVICES, launchUrl } from "@monitoros/metadata";
import { AllAppsTile, AppTile, ContinueCard, Hero, PosterCard, Row } from "../components/Media";
import { SectionTitle } from "../components/Chrome";
import { useFreeItems, useTagItems } from "../lib/catalog";
import { findSources, startPlayback } from "../lib/playback";
import { useApp, type ProgressEntry } from "../store/app";

export function useOpenItem() {
  const navigate = useApp((s) => s.navigate);
  return (item: MediaItem) => navigate({ name: "detail", item });
}

/** Play immediately when an authorised source exists; otherwise show where to watch. */
export function usePlayItem() {
  const open = useOpenItem();
  const toast = useApp((s) => s.toast);
  return async (item: MediaItem) => {
    if (!item.availability.some((a) => a.access === "free" || a.access === "local")) return open(item);
    const { ranked } = await findSources(item);
    const best = ranked.find((r) => r.playable);
    if (best) await startPlayback(item, best.source);
    else {
      toast("No playable source found for this title right now", "error");
      open(item);
    }
  };
}

function TagRow({ title, tag, row }: { title: string; tag: string; row: string }) {
  const items = useTagItems(tag);
  const open = useOpenItem();
  return <Row title={title} items={items} row={row} onOpen={open} />;
}

function FreeRow() {
  const { items, error } = useFreeItems();
  const open = useOpenItem();
  return (
    <section className="mb-9">
      <SectionTitle>Free to Watch</SectionTitle>
      {error ? (
        <p className="text-lg text-white/50">Couldn't reach Internet Archive ({error}).</p>
      ) : (
        <div className="no-scrollbar -my-3 flex gap-5 overflow-x-auto py-3 pl-1 pr-10">
          {items.slice(0, 20).map((i) => (
            <PosterCard key={i.id} item={i} row="row-free" onOpen={open} badge="Free · Public domain" />
          ))}
          {!items.length && Array.from({ length: 7 }, (_, i) => <div key={i} className="h-[270px] w-[180px] shrink-0 animate-pulse rounded-xl bg-ink-800" />)}
        </div>
      )}
    </section>
  );
}

export function HomePage() {
  const { progress, watchlist, settings, navigate, launchService } = useApp();
  const heroItems = useTagItems("hero", 5);
  const open = useOpenItem();
  const play = usePlayItem();
  const resume = (e: ProgressEntry) => void play(e.item);
  const apps = settings.subscriptions.length ? SUBSCRIPTION_SERVICES.filter((s) => settings.subscriptions.includes(s.id)) : SUBSCRIPTION_SERVICES.slice(0, 7);
  const inProgress = progress.filter((p) => p.durationSec > 0 && p.positionSec < p.durationSec - 60);

  return (
    <div className="pb-16 pl-10">
      <Hero items={heroItems} onPlay={(i) => void play(i)} onOpen={open} />
      <div className="mt-9">
        {HOME_ROWS.map((r) => {
          switch (r.kind) {
            case "continue":
              return inProgress.length ? (
                <section key={r.id} className="mb-9">
                  <SectionTitle>{r.title}</SectionTitle>
                  <div className="no-scrollbar -my-3 flex gap-6 overflow-x-auto py-3 pl-1 pr-10">
                    {inProgress.map((p) => (
                      <ContinueCard key={p.mediaId} entry={p} row="row-continue" onResume={resume} />
                    ))}
                  </div>
                </section>
              ) : null;
            case "apps":
              return (
                <section key={r.id} className="mb-9">
                  <SectionTitle>{r.title}</SectionTitle>
                  <div className="no-scrollbar -my-3 flex gap-5 overflow-x-auto py-3 pl-1 pr-10">
                    {apps.map((s) => (
                      <AppTile key={s.id} service={s} row="row-apps" onOpen={(svc) => void launchService(launchUrl(svc), svc.name)} />
                    ))}
                    <AllAppsTile row="row-apps" onOpen={() => navigate({ name: "apps" })} />
                  </div>
                </section>
              );
            case "free":
              return <FreeRow key={r.id} />;
            case "media":
              return <TagRow key={r.id} title={r.title} tag={r.tag!} row={`row-${r.id}`} />;
            case "watchlist":
              return watchlist.length ? <Row key={r.id} title={r.title} items={watchlist} row="row-watchlist" onOpen={open} variant="poster" /> : null;
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}
