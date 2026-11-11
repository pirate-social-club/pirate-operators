import { IconPlay } from "../../design-system.ts";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { attachPlayback } from "./playback-engine.ts";
import type { PlaybackGrant } from "./playback-engine.ts";
import { privateAccessLost } from "../../client.ts";
import { VideoDeliveryPending } from "./video-delivery-pending.tsx";
import type { VideoDeliveryState } from "./delivery-state.ts";

/** Grants live only in this mounted player; neither SSR nor feed caches hold them. */
export function VideoPlayer(props: {
  readonly postId: string;
  readonly onAccessLost?: () => void;
  readonly state: VideoDeliveryState;
  readonly mint: (
    postId: string,
    signal: AbortSignal,
  ) => Promise<PlaybackGrant>;
  readonly attach?: typeof attachPlayback;
  /** Test/review seam; production reads the cookie-authorized poster route. */
  readonly posterPath?: (postId: string) => string;
  /**
   * Feed policy for the active row. False keeps the player paused (the row is
   * not active, a panel is open or autoplay is off); true plays once the media
   * is ready and the row is visible.
   */
  readonly autoplay?: boolean;
  /** Controlled audio state from the feed. */
  readonly muted?: boolean;
  /**
   * Called on an explicit play tap so the feed can unmute. Media `play` events
   * do not call it: automatic playback is not a user interaction.
   */
  readonly onUserInteraction?: () => void;
  /**
   * Inline fills the width of a post page. Card fills a fixed 9:16 frame in a
   * feed card: the poster covers it, native controls appear only while
   * playing, and delivery messages sit over the frame instead of below it.
   */
  readonly layout?: "inline" | "card";
  /**
   * Who starts playback. "policy" (the default) lets the host's `autoplay`
   * play or hold the media, as the vertical feed does. "manual" never starts
   * or holds it automatically: only the viewer's play tap starts it, a grant
   * renewal keeps whatever the viewer chose (playing or paused), and leaving
   * the viewport ends the play intent so returning shows the play control.
   */
  readonly activation?: "policy" | "manual";
}) {
  const card = () => props.layout === "card";
  const manual = () => props.activation === "manual";
  const posterPath = (postId: string) => props.posterPath?.(postId);
  let host!: HTMLElement;
  let video!: HTMLVideoElement;
  let detach: (() => void) | undefined;
  let abort: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let position = 0;
  let resume = false;
  let lastMint = 0;
  let lastPost = props.postId;
  let appliedDelivery = "";
  const [visible, setVisible] = createSignal(false, { ownedWrite: true });
  const [foreground, setForeground] = createSignal(true, { ownedWrite: true });
  const [status, setStatus] = createSignal<
    "idle" | "loading" | "ready" | "unavailable"
  >("idle", { ownedWrite: true });
  const [poster, setPoster] = createSignal<string | undefined>(undefined, {
    ownedWrite: true,
  });
  // Playing is driven by the media element's own events, so the paused overlay
  // reflects real playback and never a request that was refused.
  const [playing, setPlaying] = createSignal(false, { ownedWrite: true });
  function rememberPlayback() {
    if (!video || !detach || video.readyState < HTMLMediaElement.HAVE_METADATA)
      return;
    if (Number.isFinite(video.currentTime)) position = video.currentTime;
    resume = !video.paused;
  }
  function stop() {
    rememberPlayback();
    generation++;
    abort?.abort();
    abort = undefined;
    clearTimeout(timer);
    clearTimeout(expiryTimer);
    clearTimeout(requestTimer);
    if (video) {
      video.pause();
      detach?.();
      detach = undefined;
      video.removeAttribute("src");
      video.load();
    }
    setPlaying(false);
    setPoster(undefined);
  }
  function fail() {
    stop();
    setStatus("unavailable");
  }
  async function attach(grant: PlaybackGrant, expected: number) {
    const cleanup = await (props.attach ?? attachPlayback)({
      video,
      url: grant.url,
      position,
      resume,
      signal: abort!.signal,
      onFailure: () => {
        if (generation === expected) fail();
      },
    });
    if (generation !== expected) cleanup();
    else detach = cleanup;
  }
  async function acquire() {
    const expected = generation;
    rememberPlayback();
    abort?.abort();
    detach?.();
    detach = undefined;
    abort = new AbortController();
    clearTimeout(timer);
    clearTimeout(expiryTimer);
    clearTimeout(requestTimer);
    lastMint = Date.now();
    setStatus("loading");
    requestTimer = setTimeout(() => {
      if (generation === expected) fail();
    }, 10_000);
    try {
      const grant = await props.mint(props.postId, abort.signal);
      if (generation !== expected || abort.signal.aborted) return;
      clearTimeout(requestTimer);
      if (
        !Number.isSafeInteger(grant.expiresAt) ||
        !Number.isSafeInteger(grant.renewAt) ||
        grant.expiresAt <= Date.now() ||
        grant.renewAt >= grant.expiresAt ||
        grant.renewAt <= Date.now()
      )
        throw new Error("dance_playback_grant_invalid");
      const granted = new URL(grant.url, window.location.origin);
      if (
        !["https:", "http:"].includes(granted.protocol) ||
        granted.username ||
        granted.password ||
        (granted.protocol === "http:" &&
          granted.origin !== window.location.origin)
      )
        throw new Error("dance_playback_grant_invalid");
      if (props.state.thumbnail === "ready")
        setPoster(posterPath(props.postId));
      // Expiry still stops buffered playback if a renewal request hangs.
      expiryTimer = setTimeout(
        () => {
          if (generation === expected) fail();
        },
        Math.max(0, grant.expiresAt - Date.now()),
      );
      await attach(grant, expected);
      if (generation !== expected) return;
      timer = setTimeout(
        () => {
          if (generation === expected) void renew(grant.expiresAt);
        },
        Math.max(1, grant.renewAt - Date.now()),
      );
    } catch (error) {
      if (generation === expected) {
        fail();
        if (privateAccessLost(error)) props.onAccessLost?.();
      }
    }
  }
  async function renew(previousExpiry: number) {
    // Preserve the previous expiry fence while the access endpoint is pending.
    const expected = generation;
    const deadline = setTimeout(
      () => {
        if (generation === expected) fail();
      },
      Math.max(0, previousExpiry - Date.now()),
    );
    try {
      await acquire();
    } finally {
      clearTimeout(deadline);
    }
  }
  createEffect(
    () => true,
    () => {
      setForeground(document.visibilityState !== "hidden");
      const change = () => setForeground(document.visibilityState !== "hidden");
      document.addEventListener("visibilitychange", change);
      if (typeof IntersectionObserver === "undefined") {
        setVisible(true);
        onCleanup(() =>
          document.removeEventListener("visibilitychange", change),
        );
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
        { threshold: 0.25 },
      );
      observer.observe(host);
      onCleanup(() => {
        observer.disconnect();
        document.removeEventListener("visibilitychange", change);
      });
    },
  );
  createEffect(
    () =>
      [visible(), foreground(), props.postId, props.state.playback] as const,
    ([inView, inForeground, _id, state]) => {
      // A refreshed delivery object with the same values keeps the grant.
      const key = `${inView}:${inForeground}:${_id}:${state}`;
      if (key === appliedDelivery) return;
      appliedDelivery = key;
      stop();
      setStatus("idle");
      if (lastPost !== _id) {
        lastPost = _id;
        position = 0;
        resume = false;
      }
      // A manual player never restarts by itself after leaving the viewport.
      if (manual()) resume = false;
      if (inView && inForeground && state === "ready") void acquire();
    },
  );
  createEffect(
    () =>
      [
        visible(),
        foreground(),
        props.postId,
        props.state.thumbnail,
        props.state.playback,
      ] as const,
    ([inView, inForeground, id, thumbnail]) => {
      setPoster(
        inView && inForeground && thumbnail === "ready"
          ? posterPath(id)
          : undefined,
      );
    },
  );
  // Active-row playback policy. The feed owns whether this row should play;
  // the activation is delegated to the play intent, not to `canplay` alone.
  // Muting the software decoder still lets `currentTime` advance.
  createEffect(
    () =>
      [
        props.autoplay !== false,
        props.muted === true,
        status(),
        visible(),
        foreground(),
      ] as const,
    ([autoplay, muted, playbackStatus, inView, inForeground]) => {
      if (video === undefined) return;
      if (video.muted !== muted) video.muted = muted;
      // Manual playback belongs to the viewer: status changes such as a grant
      // renewal must neither start it nor pause it.
      if (manual()) return;
      if (autoplay && playbackStatus === "ready" && inView && inForeground) {
        resume = true;
        if (video.paused) {
          const started = video.play();
          if (started !== undefined) void started.catch(() => {});
        }
        return;
      }
      if (!autoplay) {
        resume = false;
        if (!video.paused) video.pause();
      }
    },
  );
  onCleanup(stop);
  const overlay = "absolute inset-x-3 bottom-3 text-sm text-white";
  // In a feed every card holds a player, so the card form is a labelled group,
  // not one more "Published video" landmark among identical ones.
  return (
    <section
      ref={host}
      aria-label="Published video"
      role={card() ? "group" : undefined}
      class={card() ? "relative size-full" : "relative"}
      data-video-player-playing={playing()}
      data-video-player-state={status()}
    >
      <Show
        when={props.state.playback === "ready"}
        fallback={
          <Show
            when={card()}
            fallback={
              <>
                <VideoDeliveryPending
                  state={props.state}
                  showThumbnailMessage={false}
                />
                <Show when={poster()}>
                  {(src) => (
                    <img
                      src={src()}
                      alt="Video thumbnail"
                      onError={() => setPoster(undefined)}
                    />
                  )}
                </Show>
                <Show when={!poster()}>
                  <p>
                    {props.state.thumbnail === "pending"
                      ? "Thumbnail is being prepared."
                      : props.state.thumbnail === "ready"
                        ? "Thumbnail could not be loaded yet."
                        : "Thumbnail is unavailable."}
                  </p>
                </Show>
              </>
            }
          >
            <Show when={poster()}>
              {(src) => (
                <img
                  src={src()}
                  alt="Video thumbnail"
                  class="absolute inset-0 size-full object-cover"
                  onError={() => setPoster(undefined)}
                />
              )}
            </Show>
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45 p-4 text-center text-sm text-white">
              <VideoDeliveryPending
                state={props.state}
                showThumbnailMessage={false}
              />
            </div>
          </Show>
        }
      >
        <video
          ref={video}
          controls={!card() || playing()}
          playsinline
          preload="metadata"
          crossorigin="anonymous"
          muted={props.muted === true}
          poster={poster()}
          class={
            card()
              ? "size-full bg-black object-cover"
              : "max-h-[80dvh] w-full bg-black object-contain"
          }
          onCanPlay={() => {
            if (abort && !abort.signal.aborted) setStatus("ready");
          }}
          onError={() => {
            if (status() === "ready" || status() === "loading") fail();
          }}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
        />
        <Show when={status() === "ready" && !playing()}>
          <button
            aria-label="Play video"
            class={
              card()
                ? "absolute inset-0 m-auto grid size-14 place-items-center rounded-full bg-black/45 text-white"
                : "absolute inset-0 m-auto grid size-16 place-items-center rounded-full bg-black/60 text-white shadow-lg"
            }
            data-video-player-play
            onClick={() => {
              // An explicit play affordance: this is the interaction that unlocks
              // the feed gate. Muting alone never does.
              props.onUserInteraction?.();
              const started = video.play();
              if (started !== undefined) void started.catch(() => {});
            }}
            type="button"
          >
            <IconPlay class={card() ? "ml-0.5 size-6" : "ml-1 size-8"} />
          </button>
        </Show>
        <Show when={status() === "loading"}>
          <p class={card() ? overlay : undefined} role="status">
            Preparing playback…
          </p>
        </Show>
        <Show when={status() === "unavailable"}>
          <div
            class={
              card()
                ? "absolute inset-0 flex flex-col items-center justify-center gap-2 overflow-y-auto bg-black/70 p-4 text-center text-sm text-white"
                : "contents"
            }
          >
            <p role="status">
              Playback is unavailable. Your access may have changed, or delivery
              needs attention.
            </p>
            <button
              class={card() ? "underline underline-offset-4" : undefined}
              type="button"
              onClick={() => {
                if (
                  visible() &&
                  foreground() &&
                  Date.now() - lastMint >= 10_000
                )
                  void acquire();
              }}
            >
              Try playback again
            </button>
          </div>
        </Show>
      </Show>
    </section>
  );
}
