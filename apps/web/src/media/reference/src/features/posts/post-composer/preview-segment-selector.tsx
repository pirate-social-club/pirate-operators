import {
  IconButton,
  IconPause,
  IconPlay,
  Scrubber,
} from "../../../design-system.ts";
import { PostComposerField } from "./fields.tsx";
import {
  type ExcerptBounds,
  excerptLengthMs,
  formatExcerptTime,
  slideWindow,
  windowStartMax,
} from "./song-excerpt.ts";

/** Choose the song's start on the same track the author drags. */
export function PostComposerExcerptSelector(props: {
  bounds: ExcerptBounds;
  onChange: (bounds: ExcerptBounds) => void;
  onTogglePreview: () => void;
  readonly disabled?: boolean;
  readonly playing: boolean;
  readonly songDurationMs: number;
}) {
  const start = () => formatExcerptTime(props.bounds.startMs);
  const maxStart = () =>
    windowStartMax(excerptLengthMs(props.bounds), props.songDurationMs);

  return (
    <PostComposerField
      class="min-w-0 grid-cols-1"
      counter={<output class="tabular-nums">{start()}</output>}
      label="Song starts at"
      tone="muted"
    >
      <div class="flex min-w-0 items-center gap-3 rounded-[var(--radius-xl)] bg-card px-3 py-2">
        <IconButton
          active={props.playing}
          aria-label={props.playing ? "Pause the song" : "Play from here"}
          class="size-11 shrink-0 rounded-full border-0 bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={props.onTogglePreview}
        >
          {props.playing ? (
            <IconPause class="size-4" />
          ) : (
            <IconPlay class="size-4" filled />
          )}
        </IconButton>
        <Scrubber
          ariaLabel="Where the song starts"
          ariaValueText={`Starts at ${start()}`}
          class="min-h-11 min-w-0 flex-1"
          disabled={props.disabled}
          max={maxStart()}
          onChange={(value) =>
            props.onChange(
              slideWindow(props.bounds, value, props.songDurationMs),
            )
          }
          showThumb
          step={1_000}
          value={props.bounds.startMs}
          valueLabel={start()}
        />
      </div>
    </PostComposerField>
  );
}
