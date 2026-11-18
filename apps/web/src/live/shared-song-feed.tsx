import { For, Show, createSignal, onCleanup, onSettled } from "solid-js";
import { Button } from "../shell/design-system.ts";

const endpoint = "/api/public/shared-feed";
const digest = /^0x[0-9a-f]{64}$/;
type SharedSong = { communityId: string; postId: string; communityName: string; title: string };

function SharedSongList() {
  const [state, setState] = createSignal<{ songs: SharedSong[]; failed?: true }>();
  let pending: AbortController | undefined;
  let refreshTimer: number | undefined;

  async function read() {
    pending?.abort();
    window.clearTimeout(refreshTimer);
    setState(undefined);
    if (document.hidden) return;
    const controller = new AbortController();
    pending = controller;
    try {
      const response = await fetch(endpoint, {
        credentials: "omit", cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw new Error("shared_song_feed_unavailable");
      const feed = await response.json() as { schema?: unknown; songs?: unknown };
      if (feed.schema !== "pirate.shared-song-feed/1" || !Array.isArray(feed.songs))
        throw new Error("invalid_shared_song_feed");
      const songs = feed.songs.filter((song): song is SharedSong =>
        song && typeof song.communityId === "string" && digest.test(song.communityId) &&
        typeof song.postId === "string" && digest.test(song.postId) &&
        typeof song.communityName === "string" && typeof song.title === "string");
      if (!controller.signal.aborted) setState({ songs });
    } catch {
      if (!controller.signal.aborted) setState({ songs: [], failed: true });
    } finally {
      if (!controller.signal.aborted) refreshTimer = window.setTimeout(() => void read(), 15000);
    }
  }
  const recheck = () => void read();
  const suspend = () => {
    pending?.abort();
    window.clearTimeout(refreshTimer);
    setState(undefined);
  };
  let mounted = false;
  let disposed = false;
  onSettled(() => {
    if (mounted || disposed) return;
    mounted = true;
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("pageshow", recheck);
    window.addEventListener("pagehide", suspend);
    queueMicrotask(() => { if (!disposed) recheck(); });
  });
  onCleanup(() => {
    disposed = true;
    pending?.abort();
    window.clearTimeout(refreshTimer);
    document.removeEventListener("visibilitychange", recheck);
    window.removeEventListener("pageshow", recheck);
    window.removeEventListener("pagehide", suspend);
  });

  return (
    <Show when={state()} fallback={<p class="text-sm text-muted-foreground" role="status">Loading shared songs…</p>}>
      {(value) => (
        <Show when={value().songs.length} fallback={
          <p class="text-sm text-muted-foreground" role="status">
            {value().failed ? "Shared songs are temporarily unavailable." : "No shared songs are available."}
          </p>
        }>
          <ul class="divide-y">
            <For each={value().songs}>
              {(song) => (
                <li class="py-2">
                  <a class="block text-sm font-medium hover:underline"
                    href={[endpoint, song.communityId, song.postId, "open"].join("/")}>
                    {song.title}
                    <span class="ml-2 font-normal text-muted-foreground">{song.communityName}</span>
                  </a>
                </li>
              )}
            </For>
          </ul>
        </Show>
      )}
    </Show>
  );
}

export function SharedSongFeed() {
  const [open, setOpen] = createSignal(false);
  return (
    <section class="px-4 py-2" aria-label="Shared songs">
      <Button size="sm" variant="ghost" aria-expanded={open() ? "true" : "false"} onClick={() => { setOpen(value => !value); }}>
        Shared songs
      </Button>
      <Show when={open()}><SharedSongList /></Show>
    </section>
  );
}
