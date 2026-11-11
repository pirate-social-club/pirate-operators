// Independently owned source copy. src/features/posts/song-player/song-player.tsx @ c7cb87835a1858a1955c820b03d566365e6d42db
// Adapter differences: docs/v1-shell-owner-correction-20261111.md.
// Central controls/captured identity: docs/v1-shell-player-controls-20261111.md.
import { Show, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { Button, Type } from "../design-system.ts";
import { SongPlaybackControls } from "../player/playback-controls.tsx";
import { mediaFacts, seekMedia } from "../player/media-state.ts";
import type { SongPlaybackGrant } from "../playback-access.ts";

type PlayerGrant = Omit<SongPlaybackGrant, "expires_at" | "renew_after"> & {
  readonly expires_at?: number;
  readonly renew_after?: number;
};

/**
 * Playback grants are reusable bearer URLs valid for fifteen minutes, and a
 * community feed can replace its post components while a grant request is in
 * flight. Cache the latest grant per post so a remounted player resumes from
 * it instead of discarding access and refetching.
 */
const playbackGrants = new Map<string, PlayerGrant>();
const playbackGrantListeners = new Map<
  string,
  Set<(grant: PlayerGrant) => void>
>();
const PLAYBACK_GRANT_CACHE_LIMIT = 32;

function cachePlaybackGrant(postId: string, grant: PlayerGrant): void {
  playbackGrants.delete(postId);
  playbackGrants.set(postId, grant);
  while (playbackGrants.size > PLAYBACK_GRANT_CACHE_LIMIT) {
    const oldest = playbackGrants.keys().next().value;
    if (oldest === undefined) break;
    playbackGrants.delete(oldest);
  }
  // A request started by a component that has since been replaced still has
  // to reach its successor, which subscribed before the grant resolved.
  for (const listener of playbackGrantListeners.get(postId) ?? [])
    listener(grant);
}

function subscribePlaybackGrant(
  postId: string,
  listener: (grant: PlayerGrant) => void,
): () => void {
  const listeners =
    playbackGrantListeners.get(postId) ??
    new Set<(grant: PlayerGrant) => void>();
  listeners.add(listener);
  playbackGrantListeners.set(postId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) playbackGrantListeners.delete(postId);
  };
}

function cachedPlaybackGrant(
  postId: string,
  nowSeconds: number,
): PlayerGrant | undefined {
  const cached = playbackGrants.get(postId);
  return cached !== undefined &&
    (cached.renew_after === undefined || cached.renew_after > nowSeconds)
    ? cached
    : undefined;
}

export interface SongPlayerProps {
  readonly postId: string;
  readonly title: string;
  readonly readAccess: (postId: string) => Promise<SongPlaybackGrant>;
  readonly now?: () => number;
  /**
   * Compact mode retains the centralized controls inside the authored card.
   * Hidden media remains present; native controls never render.
   */
  readonly compact?: boolean;
  /** Targeted private detail owns its grant for this mount only. */
  readonly cacheAccess?: boolean;
}
/** Remount on actual post/access-port identity changes; stale mounts dispose. */
export function SongPlayer(props: SongPlayerProps) {
  const identity = createMemo(() => ({
    postId: props.postId,
    reader: props.readAccess,
    cache: props.cacheAccess,
  }));
  return (
    <Show when={identity()} keyed>
      {(scope) => (
        <SongPlayerInstance
          {...props}
          postId={scope.postId}
          readAccess={scope.reader}
          cacheAccess={scope.cache}
        />
      )}
    </Show>
  );
}
function SongPlayerInstance(props: SongPlayerProps) {
  const postId = untrack(() => props.postId);
  const reader = untrack(() => props.readAccess);
  const cacheAccess = untrack(() => props.cacheAccess);
  let audio: HTMLAudioElement | undefined;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resumeAt = 0;
  let shouldResume = false;
  const [busy, setBusy] = createSignal(false);
  const [playing, setPlaying] = createSignal(false);
  const [waiting, setWaiting] = createSignal(false);
  const [position, setPosition] = createSignal<number>();
  const [duration, setDuration] = createSignal<number>();
  const updateFacts = () => {
    if (!audio || disposed) return;
    const facts = mediaFacts(audio);
    setPosition(facts.position);
    setDuration(facts.duration);
  };
  const [issue, setIssue] = createSignal<string>();
  const now = () => Math.floor((props.now?.() ?? Date.now()) / 1000);
  const [grant, setGrant] = createSignal<PlayerGrant | undefined>(
    untrack(() =>
      cacheAccess === false ? undefined : cachedPlaybackGrant(postId, now()),
    ),
  );
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  onCleanup(() => {
    disposed = true;
    clearTimer();
    audio?.pause();
    audio?.removeAttribute("src");
    audio?.load();
  });
  onCleanup(
    subscribePlaybackGrant(postId, (next) => {
      if (!disposed && cacheAccess !== false) setGrant(next);
    }),
  );
  const renew = async (start: boolean): Promise<void> => {
    if (busy() || disposed) return;
    clearTimer();
    const retrying = issue() !== undefined;
    setIssue(undefined);
    const cached =
      cacheAccess === false ? undefined : cachedPlaybackGrant(postId, now());
    if (cached !== undefined) {
      // A still-valid grant must not pause playback on a retry. Reuse the
      // element, or let the freshly rendered one resume on metadata.
      resumeAt = audio?.currentTime ?? 0;
      shouldResume = start;
      setWaiting(start);
      if (grant() !== cached) setGrant(cached);
      if (retrying && audio) {
        audio.load();
        return;
      }
      if (start && audio !== undefined && audio.readyState > 0) {
        shouldResume = false;
        void audio.play().catch(() => {
          if (!disposed) {
            setWaiting(false);
            setIssue("Press play to start the song.");
          }
        });
      }
      return;
    }
    setBusy(true);
    resumeAt = audio?.currentTime ?? 0;
    const previousSource = audio?.currentSrc || audio?.src;
    shouldResume = start;
    audio?.pause();
    setWaiting(start);
    try {
      const response = await reader(postId);
      const next: PlayerGrant = {
        ...response,
        expires_at:
          response.expires_at === undefined
            ? undefined
            : Number(response.expires_at),
        renew_after:
          response.renew_after === undefined
            ? undefined
            : Number(response.renew_after),
      };
      const url = new URL(next.playback_url);
      if (
        (url.protocol !== "https:" &&
          !(url.protocol === "http:" && url.origin === location.origin)) ||
        url.username ||
        url.password ||
        ((next.expires_at !== undefined || next.renew_after !== undefined) &&
          (!Number.isFinite(next.expires_at) ||
            !Number.isFinite(next.renew_after) ||
            next.renew_after! <= now() ||
            next.expires_at! <= next.renew_after!))
      )
        throw new Error("Invalid playback grant");
      // Cache before the disposal check so a replaced component still leaves
      // reusable access for the one that follows it.
      if (cacheAccess !== false) cachePlaybackGrant(postId, next);
      if (disposed) return;
      setGrant(next);
      // A public community endpoint has no rotating grant URL. Retrying a
      // failed element at the same URL must reload it before ready() resumes.
      if (audio && previousSource === next.playback_url) audio.load();
    } catch {
      if (!disposed) {
        shouldResume = false;
        setWaiting(false);
        setPlaying(false);
        setGrant(undefined);
        setIssue("This song could not be played. Try again.");
      }
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  const schedule = () => {
    clearTimer();
    const current = grant();
    if (!current || disposed || current.renew_after === undefined) return;
    if (now() >= current.renew_after) {
      void renew(true);
      return;
    }
    timer = setTimeout(
      () => {
        if (audio && !audio.paused) void renew(true);
      },
      Math.max(1, (current.renew_after - now()) * 1000),
    );
  };
  const ready = () => {
    if (!audio || disposed) return;
    updateFacts();
    if (Number.isFinite(audio.duration))
      audio.currentTime = Math.min(resumeAt, Math.max(0, audio.duration));
    if (shouldResume) {
      shouldResume = false;
      void audio.play().catch(() => {
        if (!disposed) {
          setWaiting(false);
          setIssue("Press play to start the song.");
        }
      });
    }
  };
  const play = () => {
    if (!audio || disposed || busy()) return;
    const current = grant();
    if (
      !current ||
      issue() ||
      (current.renew_after !== undefined && current.renew_after <= now())
    ) {
      void renew(true);
      return;
    }
    void audio.play().catch(() => {
      if (!disposed) {
        setWaiting(false);
        setIssue("Press play to start the song.");
      }
    });
  };
  const seek = (ms: number) => {
    if (!audio || disposed) return;
    try {
      if (seekMedia(audio, ms)) {
        resumeAt = audio.currentTime;
        updateFacts();
      }
    } catch {
      setIssue("This position could not be reached. Try again.");
    }
  };
  return (
    <div
      class={props.compact ? "w-full min-w-0" : "flex min-w-0 flex-col gap-2"}
      data-song-player={postId}
    >
      <SongPlaybackControls
        title={props.title}
        playing={playing()}
        buffering={busy() || waiting()}
        position={position()}
        duration={duration()}
        canSeek={duration() !== undefined && grant() !== undefined}
        onPlay={play}
        onPause={() => audio?.pause()}
        onSeek={seek}
      />
      <audio
        hidden
        aria-label={"Audio for " + props.title}
        preload="metadata"
        ref={audio}
        src={grant()?.playback_url}
        onLoadedMetadata={ready}
        onDurationChange={updateFacts}
        onTimeUpdate={updateFacts}
        onPlaying={() => {
          if (!disposed) {
            setPlaying(true);
            setWaiting(false);
            updateFacts();
            schedule();
          }
        }}
        onPlay={(event) => {
          if (disposed) return;
          for (const media of document.querySelectorAll<HTMLMediaElement>(
            "audio, video",
          ))
            if (media !== event.currentTarget) media.pause();
        }}
        onWaiting={() => {
          if (!disposed && audio && !audio.paused) setWaiting(true);
        }}
        onStalled={() => {
          if (!disposed && audio && !audio.paused) setWaiting(true);
        }}
        onPause={() => {
          if (!disposed) {
            setPlaying(false);
            setWaiting(false);
            clearTimer();
            updateFacts();
          }
        }}
        onEnded={() => {
          if (!disposed) {
            setPlaying(false);
            setWaiting(false);
            clearTimer();
            updateFacts();
          }
        }}
        onSeeked={updateFacts}
        onEmptied={() => {
          if (!disposed) {
            setPlaying(false);
            setWaiting(shouldResume);
            setPosition(undefined);
            setDuration(undefined);
          }
        }}
        onError={() => {
          if (!disposed) {
            shouldResume = false;
            clearTimer();
            setPlaying(false);
            setWaiting(false);
            setIssue("Audio could not be loaded. Retry playback.");
          }
        }}
      />
      <Show when={issue()}>
        {(message) => (
          <Type role="status" variant="caption">
            {message()}
          </Type>
        )}
      </Show>
      <Show when={issue()}>
        <Button
          disabled={busy()}
          onClick={() => void renew(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          Retry playback
        </Button>
      </Show>
    </div>
  );
}
