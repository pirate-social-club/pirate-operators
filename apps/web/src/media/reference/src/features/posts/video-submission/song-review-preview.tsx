import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { IconPlay, Type } from "../../../design-system.ts";
import { type ExcerptBounds } from "../post-composer/song-excerpt.ts";

/** The audio half of a local composed preview. Injected so a test can drive
 * the clock without a decoder, exactly as the guide playback is injected. */
export interface PreviewAudio {
  currentTime: number;
  readonly paused?: boolean;
  play: () => Promise<void>;
  pause: () => void;
  addEventListener?: (
    type: "waiting" | "playing",
    listener: () => void,
  ) => void;
  removeEventListener?: (
    type: "waiting" | "playing",
    listener: () => void,
  ) => void;
}

/** How far the video may drift from the song before it is pulled back. */
export const PREVIEW_MAX_DRIFT_SECONDS = 0.25;

/** A local preview of the video with the intended soundtrack.
 *
 * It plays the captured video (its own audio muted, because the song replaces
 * it) against the granted song audio started at the excerpt. The song is the
 * clock: the video is pulled back to it when it drifts, and when either player
 * stalls the other pauses rather than running on alone. This is a convenience,
 * not proof of the published result: the server renders the final master from
 * the canonical song samples, and the two can differ by a frame.
 */
export function SongReviewPreview(props: {
  readonly videoUrl?: string;
  readonly posterUrl?: string;
  readonly audioUrl: string;
  readonly bounds: ExcerptBounds;
  readonly createAudio?: (url: string) => PreviewAudio;
  readonly disabled?: boolean;
}) {
  const [playing, setPlaying] = createSignal(false);
  const [issue, setIssue] = createSignal<string>();
  let video: HTMLVideoElement | undefined;
  let audio: PreviewAudio | undefined;
  let frame: number | undefined;
  let starting = false;
  let playGeneration = 0;

  const stopWatching = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  const stop = () => {
    playGeneration += 1;
    starting = false;
    stopWatching();
    video?.pause();
    audio?.pause();
    setPlaying(false);
  };
  const detachAudio = () => {
    audio?.removeEventListener?.("waiting", onAudioWaiting);
    audio?.removeEventListener?.("playing", onAudioPlaying);
  };
  onCleanup(() => {
    detachAudio();
    stop();
  });
  createEffect(
    () => props.disabled,
    (disabled) => {
      if (disabled) stop();
    },
  );

  /** The video follows the song, never the other way around: a preview that
   * ran the two clocks independently would show the drift the author is
   * trying to judge. */
  const watch = () => {
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!playing() || !audio || !video) return;
      if (audio.currentTime * 1_000 >= props.bounds.endMs) {
        stop();
        return;
      }
      if (video.ended) {
        stop();
        setIssue("This video ended early.");
        return;
      }
      const expected =
        (audio.currentTime * 1_000 - props.bounds.startMs) / 1_000;
      if (Math.abs(video.currentTime - expected) > PREVIEW_MAX_DRIFT_SECONDS) {
        video.currentTime = Math.max(0, expected);
      }
      watch();
    });
  };

  const resumeBoth = async (intent: boolean) => {
    if (!intent || !video || !audio) return;
    const generation = playGeneration;
    try {
      await Promise.all([video.play(), audio.play()]);
      if (generation !== playGeneration || !playing()) return;
      starting = false;
      watch();
    } catch {
      if (generation !== playGeneration) return;
      stop();
      setIssue("This video won’t play. Try again.");
    }
  };

  const onVideoWaiting = () => {
    if (!playing() || starting) return;
    setIssue("The video stopped. Try again.");
    stop();
  };
  const onVideoPlaying = () => {
    if (!playing() || starting || !audio) return;
    setIssue(undefined);
    void audio.play().catch(() => undefined);
  };
  const onAudioWaiting = () => {
    if (!playing() || starting) return;
    setIssue("The song stopped. Try again.");
    stop();
  };
  const onAudioPlaying = () => {
    if (!playing() || starting || !video) return;
    setIssue(undefined);
    void video.play().catch(() => undefined);
  };

  const toggle = async () => {
    const element = video;
    if (!element || props.disabled) return;
    if (playing()) {
      stop();
      return;
    }
    setIssue(undefined);
    detachAudio();
    audio = props.createAudio
      ? props.createAudio(props.audioUrl)
      : new Audio(props.audioUrl);
    audio.addEventListener?.("waiting", onAudioWaiting);
    audio.addEventListener?.("playing", onAudioPlaying);
    audio.currentTime = props.bounds.startMs / 1_000;
    element.currentTime = 0;
    starting = true;
    setPlaying(true);
    // The intent is passed explicitly: a signal written in this same task is
    // not readable until its update has been applied.
    await resumeBoth(true);
  };

  return (
    <div class="relative h-full w-full">
      <video
        class="h-full w-full object-contain"
        muted
        playsinline
        poster={props.posterUrl}
        ref={(element) => {
          video = element;
        }}
        src={props.videoUrl}
        onWaiting={onVideoWaiting}
        onPlaying={onVideoPlaying}
      />
      <button
        class="absolute inset-0 grid cursor-pointer place-items-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
        aria-label={playing() ? "Pause video preview" : "Play video preview"}
        disabled={!props.videoUrl || props.disabled}
        onClick={() => void toggle()}
        type="button"
      >
        <Show when={!playing()}>
          <span class="grid size-16 place-items-center rounded-full bg-black/60 text-white">
            <IconPlay aria-hidden="true" class="size-7" />
          </span>
        </Show>
      </button>
      <Show when={issue()}>
        {(message) => (
          <Type
            as="p"
            variant="caption"
            class="pointer-events-none absolute inset-x-0 bottom-0 bg-black/75 p-3 text-white"
            role="alert"
          >
            {message()}
          </Type>
        )}
      </Show>
    </div>
  );
}
