import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { MediaClient, MediaFeedItem } from "./client.ts";
import styles from "./media.module.css";

export function MediaFeedCard(props: {
  item: MediaFeedItem;
  onSong: (key: string, revision: number) => void;
}) {
  const [failed, setFailed] = createSignal(false);
  let video: HTMLVideoElement | undefined;
  return (
    <article class={styles.card} aria-label={`Video for ${props.item.title}`}>
      <video
        ref={video}
        class={styles.video}
        controls
        playsinline
        preload="metadata"
        src={props.item.playbackUrl}
        aria-label={`Song clip: ${props.item.title}`}
        onError={() => setFailed(true)}
        onLoadedData={() => setFailed(false)}
      />
      <Show when={failed()}>
        <p role="alert">
          This clip is unavailable.{" "}
          <button
            type="button"
            onClick={() => {
              setFailed(false);
              video?.load();
            }}
          >
            Try playback again
          </button>
        </p>
      </Show>
      <div class={styles.details}>
        <button
          type="button"
          onClick={() =>
            props.onSong(props.item.songKey, props.item.songRevision)
          }
        >
          {props.item.title}
        </button>
        <span>{Math.round(props.item.durationMs / 1000)} seconds</span>
      </div>
    </article>
  );
}
/** Shell supplies real API data and the existing song route callback. */
export function MediaFeed(props: {
  client: MediaClient;
  onSong: (key: string, revision: number) => void;
}) {
  const [items, setItems] = createSignal<MediaFeedItem[]>([]),
    [cursor, setCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false),
    [loaded, setLoaded] = createSignal(false),
    [error, setError] = createSignal("");
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  async function load(more = false) {
    if (loading()) return;
    setLoading(true);
    setError("");
    try {
      const page = await props.client.feed(
        more ? (cursor() ?? undefined) : undefined,
      );
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
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Videos could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }
  createEffect(
    () => props.client,
    () => {
      void load();
    },
  );
  return (
    <section
      class={styles.feed}
      aria-label="Community videos"
      aria-busy={loading() ? "true" : "false"}
    >
      <h2>Community videos</h2>
      <Show when={error()}>
        <p role="alert">
          {error()}{" "}
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      </Show>
      <Show when={loaded() && !items().length}>
        <p>No public videos yet.</p>
      </Show>
      <For each={items()}>
        {(item) => <MediaFeedCard item={item} onSong={props.onSong} />}
      </For>
      <Show when={loading()}>
        <p role="status">Loading videos…</p>
      </Show>
      <Show when={cursor()}>
        <button
          type="button"
          disabled={loading()}
          onClick={() => void load(true)}
        >
          Load more videos
        </button>
      </Show>
    </section>
  );
}
