// Reference: pirate-web-solid c7cb8783, home-video-feed.tsx and the pinned
// VerticalFeed/MediaPost/VideoPlayer/MediaMore pure presentation components.
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  VerticalFeed,
  type VerticalFeedPlaceholderContext,
} from "@/patterns/engagement/vertical-feed/vertical-feed";
import { VideoPlayer } from "@/patterns/engagement/vertical-feed/video-player";
import { MediaMore } from "@/patterns/engagement/vertical-feed/media-more";
import { Button, Spinner } from "./reference-ui.ts";
import type { MediaClient, MediaFeedItem } from "./client.ts";

/** Reference frame/player/mute/song interaction. No admitted social counts
 * or author profile exist, so those rail rows are omitted without dummy data. */
export function MediaFeedCard(props: {
  item: MediaFeedItem;
  onSong: (key: string, revision: number) => void;
  context?: VerticalFeedPlaceholderContext;
}) {
  const [paused, setPaused] = createSignal(false),
    [started, setStarted] = createSignal(false),
    [muted, setMuted] = createSignal(true);
  const playing = () =>
    (props.context?.active() ?? true) &&
    !paused() &&
    (props.context?.autoplay() ?? started());
  return (
    <article
      class="relative flex h-[100dvh] w-full snap-start items-center justify-center bg-background md:h-screen md:gap-5"
      data-media-post={props.item.id}
    >
      <div class="relative h-full w-full overflow-hidden bg-background md:h-[90vh] md:max-h-[800px] md:w-[50.625vh] md:max-w-[450px] md:shrink-0 md:rounded-lg">
        <VideoPlayer
          videoUrl={props.item.playbackUrl}
          isPlaying={playing()}
          isMuted={props.context?.muted() ?? muted()}
          priorityLoad={props.context?.active() ?? true}
          onTogglePlay={() => {
            const wasPlaying = playing();
            props.context?.markUserInteracted();
            setStarted(true);
            setPaused(wasPlaying);
          }}
          onPlayFailed={() => setPaused(true)}
        />
        <MediaMore
          isMuted={props.context?.muted() ?? muted()}
          belowHeader
          onToggleMute={() => {
            props.context?.markUserInteracted();
            const next = !(props.context?.muted() ?? muted());
            setMuted(next);
            props.context?.reportMuteToggle(next);
          }}
        />
        <div class="pointer-events-none absolute bottom-[calc(5rem+env(safe-area-inset-bottom))] left-6 right-20 z-40 md:bottom-4">
          <button
            type="button"
            class="pointer-events-auto mt-1 block cursor-pointer text-sm leading-5 text-primary-foreground/70 hover:underline"
            onClick={() =>
              props.onSong(props.item.songKey, props.item.songRevision)
            }
          >
            {props.item.title}
          </button>
        </div>
      </div>
    </article>
  );
}
export function MediaFeed(props: {
  client: MediaClient;
  onSong: (key: string, revision: number) => void;
}) {
  const [items, setItems] = createSignal<MediaFeedItem[]>([]),
    [cursor, setCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false),
    [loaded, setLoaded] = createSignal(false),
    [error, setError] = createSignal(false),
    [muted, setMuted] = createSignal(true);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  async function load(more = false) {
    if (loading() || (more && !cursor())) return;
    setLoading(true);
    setError(false);
    try {
      let page = await props.client.feed(
          more ? (cursor() ?? undefined) : undefined,
        ),
        scanned = 1;
      while (!page.items.length && page.cursor && scanned++ < 4)
        page = await props.client.feed(page.cursor);
      if (disposed) return;
      setItems((previous) =>
        Array.from(
          new Map(
            [...(more ? previous : []), ...page.items].map((item) => [
              item.id,
              item,
            ]),
          ).values(),
        ),
      );
      setCursor(page.cursor);
      setLoaded(true);
    } catch {
      if (!disposed) setError(true);
    } finally {
      if (!disposed) setLoading(false);
    }
  }
  createEffect(
    () => props.client,
    () => {
      void load();
    },
  );
  return (
    <main
      class="h-[100dvh] bg-background md:h-screen"
      aria-label="Videos for you"
      data-video-feed-state={
        loading() && !loaded() ? "loading" : error() ? "error" : "ready"
      }
    >
      <Show
        when={loaded() || error()}
        fallback={
          <div class="grid h-full place-items-center">
            <Spinner label="Loading videos" />
          </div>
        }
      >
        <Show
          when={!error()}
          fallback={
            <div class="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <p>Couldn't load the feed.</p>
              <Button variant="secondary" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          }
        >
          <Show
            when={items().length}
            fallback={
              <div class="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
                <p class="text-lg font-semibold">Nothing here yet</p>
                <Show when={cursor()}>
                  <Button disabled={loading()} onClick={() => void load(true)}>
                    Load more
                  </Button>
                </Show>
              </div>
            }
          >
            <VerticalFeed
              posts={items().map((item) => ({
                id: item.id,
                placeholder: true as const,
              }))}
              autoplay
              forceAutoplay
              muted={muted()}
              onMuteToggle={(_id, value) => setMuted(value)}
              hasMore={cursor() !== null}
              loading={loading()}
              onEndReached={() => void load(true)}
              feedLabel="Videos for you"
              hasMobileFooter
              renderPlaceholder={(id, context) => {
                const item = items().find((candidate) => candidate.id === id);
                return (
                  <Show when={item}>
                    {(value) => (
                      <MediaFeedCard
                        item={value()}
                        context={context}
                        onSong={props.onSong}
                      />
                    )}
                  </Show>
                );
              }}
            />
          </Show>
        </Show>
      </Show>
    </main>
  );
}
