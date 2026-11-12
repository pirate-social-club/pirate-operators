// Independent Solid adaptation of centralized SongPostContent controls:
// post-card-song-content.tsx @ dca054847b3d48237780dcf834b7924c5fede0af.
// Original MediaControlButton/Scrubber primitives: exact c7cb8783 package.
import { Show } from "solid-js";
import {
  IconPause,
  IconPlay,
  MediaControlButton,
  Scrubber,
  Spinner,
} from "../design-system.ts";
import { timeLabel } from "./media-state.ts";
const controlClass =
  "relative border-transparent bg-transparent shadow-none before:absolute before:inset-0 before:rounded-full before:bg-primary before:shadow-sm hover:bg-transparent hover:before:bg-primary/90";
export function SongPlaybackControls(props: {
  title: string;
  playing: boolean;
  buffering: boolean;
  position?: number;
  duration?: number;
  canSeek: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (ms: number) => void;
}) {
  const durationMs = () =>
    props.duration !== undefined ? props.duration * 1000 : 100;
  const progressMs = () =>
    props.position !== undefined
      ? Math.min(
          props.position * 1000,
          props.duration !== undefined
            ? props.duration * 1000
            : props.position * 1000,
        )
      : 0;
  return (
    <div class="col-span-full row-start-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] grid-rows-[2.75rem_auto] gap-x-3 sm:col-span-1 sm:col-start-2 sm:self-start">
      <div class="row-start-1 flex shrink-0 items-center">
        <MediaControlButton
          aria-label={
            props.buffering
              ? `Loading ${props.title}`
              : `${props.playing ? "Pause" : "Play"} ${props.title}`
          }
          class={controlClass}
          onClick={() => (props.playing ? props.onPause() : props.onPlay())}
          size="lg"
          disabled={props.buffering}
        >
          <Show
            when={!props.buffering}
            fallback={<Spinner class="relative z-10 size-5" />}
          >
            <Show
              when={props.playing}
              fallback={<IconPlay class="relative z-10 size-5" filled />}
            >
              <IconPause class="relative z-10 size-5" filled />
            </Show>
          </Show>
        </MediaControlButton>
      </div>
      <div
        class="col-start-2 row-start-1 flex min-w-0 items-center"
        data-post-card-interactive="true"
      >
        <Scrubber
          ariaLabel={`Track position for ${props.title}`}
          ariaValueText={`${timeLabel(props.position)} / ${timeLabel(props.duration)}`}
          class="h-full opacity-100"
          disabled={!props.canSeek}
          max={durationMs()}
          onChange={(next) => props.onSeek(Math.min(next, durationMs()))}
          showThumb
          showValueBubble
          step={1000}
          value={progressMs()}
          valueLabel={timeLabel(props.position)}
        />
      </div>
      <div
        class="col-start-2 row-start-2 flex items-center justify-between tabular-nums text-muted-foreground text-base leading-tight"
        data-song-time
      >
        <span>{timeLabel(props.position)}</span>
        <span>{timeLabel(props.duration)}</span>
      </div>
    </div>
  );
}
