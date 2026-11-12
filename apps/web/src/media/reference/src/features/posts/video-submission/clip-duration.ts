import {
  excerptLengthMs,
  formatExcerptTime,
  MAX_EXCERPT_MS,
  MIN_EXCERPT_MS,
  type ExcerptBounds,
} from "../post-composer/song-excerpt.ts";

/** Recording is stopped past the excerpt's end. The server renders the master
 * at the excerpt's exact length, so a take that ends a frame early is refused
 * (`source_video_too_short`); a discarded tail costs nothing and absorbs
 * timer and encoder rounding. It also has to cover the leading offset that is
 * trimmed away when the take is aligned to the guide, so it is larger than
 * the maximum compensable offset. */
export const CAPTURE_TAIL_GUARD_MS = 1_250;

/** A clip longer than the excerpt by less than this is treated as equal, so
 * ordinary frame rounding does not produce a trimming notice. */
export const TRIM_NOTICE_EPSILON_MS = 500;

/** One frame at the server master's 30 fps. The render cuts
 * `ceil(excerpt / frame)` frames, so a source video whose length merely equals
 * the excerpt can be one frame short; the guard requires the extra frame. */
export const SERVER_FRAME_MS = 1_000 / 30;

/** The longest container a guided take can have: the maximum excerpt plus the
 * tail guard, with room for rounding. The aligned artifact keeps the captured
 * audio untrimmed, so its container can last the full recorded length and
 * admission of a guided take uses this bound, not the chosen-file bound. */
export const GUIDED_TAKE_MAX_DURATION_SECONDS = 181.5;

/** The longest clip a song video accepts: the longest excerpt plus the tail a
 * guided take records past it, with the rounding allowance. Anything longer is
 * refused rather than silently cut. */
export const MAX_CLIP_MS =
  MAX_EXCERPT_MS + CAPTURE_TAIL_GUARD_MS + TRIM_NOTICE_EPSILON_MS;

/** How much of the song a clip of this length can carry: the render needs one
 * frame of video beyond the interval. */
export function songLengthForClip(
  clipDurationMs: number | null | undefined,
): number | null {
  if (
    clipDurationMs === null ||
    clipDurationMs === undefined ||
    !Number.isFinite(clipDurationMs) ||
    clipDurationMs <= 0
  )
    return null;
  return Math.floor(clipDurationMs - SERVER_FRAME_MS);
}

/** How a measured clip's length relates to the chosen excerpt. The server
 * still measures and cuts; this is the local answer that stops an impossible
 * combination from being uploaded just to fail in processing. */
export type ClipFit =
  | { readonly kind: "exact" }
  | {
      readonly kind: "trims";
      readonly clipDurationMs: number;
      readonly discardedMs: number;
    }
  | {
      readonly kind: "too_short";
      readonly clipDurationMs: number;
      readonly shortfallMs: number;
    }
  | { readonly kind: "too_long"; readonly clipDurationMs: number }
  | { readonly kind: "unmeasured" };

/** A clip the render can use: at least as long as the excerpt, so its opening
 * frames cover the whole interval. A shorter clip cannot be stretched, and
 * retrying the same bytes cannot change that. */
export function fitClipToExcerpt(
  clipDurationMs: number | null | undefined,
  excerpt: ExcerptBounds | null | undefined,
): ClipFit {
  if (!excerpt) return { kind: "unmeasured" };
  const excerptMs = excerptLengthMs(excerpt);
  if (
    clipDurationMs === null ||
    clipDurationMs === undefined ||
    !Number.isFinite(clipDurationMs) ||
    clipDurationMs <= 0 ||
    !Number.isInteger(excerpt.startMs) ||
    !Number.isInteger(excerpt.endMs) ||
    !Number.isInteger(excerptMs) ||
    excerptMs <= 0
  ) {
    return { kind: "unmeasured" };
  }
  const clip = Math.round(clipDurationMs);
  if (clip > MAX_CLIP_MS) return { kind: "too_long", clipDurationMs: clip };
  // The render needs ceil(excerpt/frame) whole frames from the source, so the
  // video must cover the excerpt plus at least one frame.
  if (clip < excerptMs + SERVER_FRAME_MS) {
    return {
      kind: "too_short",
      clipDurationMs: clip,
      shortfallMs: Math.ceil(excerptMs + SERVER_FRAME_MS - clip),
    };
  }
  const discardedMs = clip - excerptMs;
  return discardedMs > TRIM_NOTICE_EPSILON_MS
    ? { kind: "trims", clipDurationMs: clip, discardedMs }
    : { kind: "exact" };
}

/** How long a guided recording runs: the excerpt plus its tail guard. */
export function captureStopAfterMs(excerpt: ExcerptBounds): number {
  return excerptLengthMs(excerpt) + CAPTURE_TAIL_GUARD_MS;
}

/** What the author is told about the measured clip, in every state. Nothing is
 * said while unmeasured, because the server's own measurement still decides. */
export function clipFitMessage(fit: ClipFit): string | undefined {
  switch (fit.kind) {
    case "exact":
    case "unmeasured":
      return undefined;
    case "trims":
      return `This ${formatExcerptTime(fit.clipDurationMs)} clip will be trimmed to the excerpt when the song is applied.`;
    case "too_short":
      return fit.clipDurationMs < MIN_EXCERPT_MS + SERVER_FRAME_MS
        ? "Videos need to be at least 3 seconds long."
        : `This clip lasts ${formatExcerptTime(fit.clipDurationMs)}, but the song part is ${formatExcerptTime(fit.clipDurationMs + fit.shortfallMs)}. Record again or choose another video.`;
    case "too_long":
      return `Videos can be up to 15 seconds. This one lasts ${formatExcerptTime(fit.clipDurationMs)}, so choose a shorter one.`;
  }
}
