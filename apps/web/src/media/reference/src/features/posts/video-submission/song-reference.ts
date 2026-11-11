import { ServiceRefusal as ApiClientError } from "../../../service-refusal.ts";
import {
  type ExcerptBounds,
  formatExcerptTime,
} from "../post-composer/song-excerpt.ts";
import { VideoContractError, type SongVideoSelection } from "./contracts.ts";
export type SongIntervalPreflightResponse =
  | {
      readonly state: "measuring";
      readonly song_post_id: string;
      readonly retry_after_ms: number;
    }
  | { readonly state: "unavailable"; readonly song_post_id: string }
  | {
      readonly state: "ready";
      readonly song_post_id: string;
      readonly audio_revision: number;
      readonly canonical_duration_samples: number;
      readonly interval_policy: {
        readonly min_clip_duration_samples: number;
        readonly max_clip_duration_samples: number;
        readonly policy_revision?: number;
        readonly sample_rate_hz?: 48000;
      };
      readonly interval:
        | null
        | { readonly accepted: true }
        | {
            readonly accepted: false;
            readonly reason:
              | "invalid_interval"
              | "interval_too_short"
              | "interval_too_long"
              | "canonical_song_interval_uncovered";
          };
    };
export interface PostCommunitiesCommunityIdSongVideoIntervalPreflightsInput {
  readonly path: { readonly communityId: string };
  readonly body: {
    readonly song_post_id: string;
    readonly interval?: SongInterval;
  };
}
/** Spec 013 §5A song-backed video, as the composer sees it.
 *
 * The server owns every fact that decides whether a video can be posted to a
 * song: the song's audio revision, its canonical length in 48 kHz samples, the
 * interval policy, the owner's permission and the verdict on an interval. The
 * composer asks through the preflight, shows the answer, and sends exactly the
 * interval the author retained. Reservation revalidates all of it, so a ready
 * preflight is advice and never a promise.
 */

type ReadyPreflight = Extract<
  SongIntervalPreflightResponse,
  { state: "ready" }
>;
export type SongIntervalRefusal = Extract<
  NonNullable<ReadyPreflight["interval"]>,
  { accepted: false }
>["reason"];
type SongReasonCode =
  | "song_not_published"
  | "song_audio_revision_missing"
  | "derivative_video_blocked"
  | "derivative_video_owner_only";

/** Every `reason_code` the server gives when it refuses a song-backed video,
 * from preflight or reservation. Anything else is not a song refusal. */
const REFUSALS = [
  "invalid_interval",
  "interval_too_short",
  "interval_too_long",
  "canonical_song_interval_uncovered",
] as const satisfies readonly SongIntervalRefusal[];
const INELIGIBLE = [
  "song_not_found",
  "age_restricted",
  "song_owner_policy_unavailable",
  "derivative_video_blocked",
  "derivative_video_owner_only",
] as const;
const SONG_REFUSAL_CODES = [
  "capability_unavailable",
  "canonical_timing_pending",
  "canonical_timing_unavailable",
  "song_audio_revision_changed",
  ...REFUSALS,
  ...INELIGIBLE,
] as const;
export type SongVideoIneligibility = (typeof INELIGIBLE)[number];
export type SongRefusalCode = (typeof SONG_REFUSAL_CODES)[number];
/** A song-backed reservation can also fail on the client, when the server's
 * echo does not match what was sent. */
export type SongRejectionCode = SongRefusalCode | "song_reference_mismatch";

/** 48 kHz: one whole millisecond is exactly 48 samples. */
export const SAMPLES_PER_MS = 48;

/** Whole milliseconds to samples. Exact, or refused: nothing is rounded. */
export function samplesFromMs(milliseconds: number): number {
  const samples = milliseconds * SAMPLES_PER_MS;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    !Number.isSafeInteger(samples)
  ) {
    throw new VideoContractError(
      "Excerpt bounds must be whole, non-negative milliseconds",
    );
  }
  return samples;
}

/** The interval the server takes: half-open, start and length in samples. */
export interface SongInterval {
  readonly clip_start_samples: number;
  readonly clip_duration_samples: number;
}

export function intervalFromExcerpt(bounds: ExcerptBounds): SongInterval {
  const start = samplesFromMs(bounds.startMs);
  const end = samplesFromMs(bounds.endMs);
  if (end <= start)
    throw new VideoContractError("An excerpt must end after it starts");
  return { clip_start_samples: start, clip_duration_samples: end - start };
}

/** The last whole millisecond at or before a sample. A canonical length that
 * is not a multiple of 48 loses its final partial millisecond here, so a
 * selection bounded by it can never run past the song's last sample. */
export function msAtOrBefore(samples: number): number {
  return Math.floor(samples / SAMPLES_PER_MS);
}

/** The first whole millisecond at or after a sample, for lower limits. */
export function msAtOrAfter(samples: number): number {
  return Math.ceil(samples / SAMPLES_PER_MS);
}

/** The server's timing for a song, in the units the selector works in. */
export interface CanonicalSongTiming {
  readonly songPostId: string;
  readonly audioRevision: number;
  readonly durationMs: number;
  readonly minExcerptMs: number;
  readonly maxExcerptMs: number;
}

export function canonicalTiming(
  response: SongIntervalPreflightResponse,
): CanonicalSongTiming | null {
  if (response.state !== "ready") return null;
  return {
    songPostId: response.song_post_id,
    audioRevision: response.audio_revision,
    durationMs: msAtOrBefore(response.canonical_duration_samples),
    minExcerptMs: msAtOrAfter(
      response.interval_policy.min_clip_duration_samples,
    ),
    maxExcerptMs: msAtOrBefore(
      response.interval_policy.max_clip_duration_samples,
    ),
  };
}

export type SongIntervalPreflight = (
  input: PostCommunitiesCommunityIdSongVideoIntervalPreflightsInput,
  signal?: AbortSignal,
) => Promise<SongIntervalPreflightResponse>;

/** Where a retained excerpt stands with the server. Only `ready` lets a
 * publication name the song; any other retained state blocks publishing. */
export type SongPlanState =
  | { readonly kind: "none" }
  | { readonly kind: "checking" }
  | { readonly kind: "not_available" }
  | { readonly kind: "measuring"; readonly retryAfterMs: number }
  | { readonly kind: "timing_unavailable" }
  | { readonly kind: "refused"; readonly reason: SongIntervalRefusal }
  | { readonly kind: "ineligible"; readonly reasonCode: SongVideoIneligibility }
  | { readonly kind: "failed"; readonly retryable: boolean }
  | { readonly kind: "ready"; readonly selection: SongVideoSelection };

/** The author's soundtrack choice, tracked apart from the server's verdict on
 * it. Once a song is chosen it stays this video's intent — including while a
 * fresh preflight answer is pending or the author switches songs — until the
 * author explicitly chooses another song. */
export type SongChoice =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "song"; songPostId: string }>;

const DEFAULT_MEASURING_RETRY_MS = 2_000;

/** The song refusal a declared API error names, when it names one. */
export function songRefusalCode(
  error: ApiClientError,
): SongRefusalCode | undefined {
  const reason = error.details?.reason_code;
  return SONG_REFUSAL_CODES.find((code) => code === reason);
}

const refusalOf = (code: SongRefusalCode | undefined) =>
  REFUSALS.find((reason) => reason === code);
const ineligibilityOf = (code: SongRefusalCode | undefined) =>
  INELIGIBLE.find((reason) => reason === code);

/** The server's answer to an interval, as a plan state. */
export function songPlanFromPreflight(
  response: SongIntervalPreflightResponse,
  sent: { readonly songPostId: string; readonly bounds: ExcerptBounds },
): SongPlanState {
  switch (response.state) {
    case "measuring":
      return { kind: "measuring", retryAfterMs: response.retry_after_ms };
    case "unavailable":
      return { kind: "timing_unavailable" };
    case "ready": {
      // An interval was sent, so a verdict is owed. Its absence is a server
      // fault and is not read as acceptance.
      if (response.interval === null)
        return { kind: "failed", retryable: true };
      if (!response.interval.accepted)
        return { kind: "refused", reason: response.interval.reason };
      const interval = intervalFromExcerpt(sent.bounds);
      return {
        kind: "ready",
        selection: {
          songPostId: sent.songPostId,
          audioRevision: response.audio_revision,
          clipStartSamples: interval.clip_start_samples,
          clipDurationSamples: interval.clip_duration_samples,
          // A pasted link is a library choice. A feed origin is only named when
          // the composer genuinely came from a feed post, which it does not yet.
          selectedFrom: { kind: "library" },
        },
      };
    }
  }
}

/** A declared refusal from preflight or reservation, as a plan state. An
 * undeclared failure is `failed`, and its caller says so without this. */
export function songPlanFromError(error: ApiClientError): SongPlanState {
  const reason = songRefusalCode(error);
  if (reason === "capability_unavailable") return { kind: "not_available" };
  const refusal = refusalOf(reason);
  if (refusal) return { kind: "refused", reason: refusal };
  const ineligibility = ineligibilityOf(reason);
  if (ineligibility) return { kind: "ineligible", reasonCode: ineligibility };
  if (reason === "canonical_timing_pending") {
    return {
      kind: "measuring",
      retryAfterMs: error.retryAfterSeconds
        ? error.retryAfterSeconds * 1_000
        : DEFAULT_MEASURING_RETRY_MS,
    };
  }
  if (reason === "canonical_timing_unavailable")
    return { kind: "timing_unavailable" };
  return { kind: "failed", retryable: error.retryable };
}

/** Reservation refusals that no replay of the same command can change. A
 * conflict usually names an existing operation and is replayed; these name a
 * fact about the song instead. */
export function isDefinitiveSongRefusal(error: ApiClientError): boolean {
  const reason = songRefusalCode(error);
  return (
    reason === "song_audio_revision_changed" ||
    reason === "canonical_timing_unavailable"
  );
}

const SONG_BLOCKED =
  "Publishing waits until the excerpt is accepted; choose another part of the song or a different song.";

function refusalText(reason: SongIntervalRefusal): string {
  switch (reason) {
    case "invalid_interval":
      return "The server couldn’t read this excerpt’s bounds. Adjust it and retain it again.";
    case "interval_too_short":
      return "This excerpt is shorter than the server allows. Lengthen it and retain it again.";
    case "interval_too_long":
      return "This excerpt is longer than the server allows. Shorten it and retain it again.";
    case "canonical_song_interval_uncovered":
      return "This excerpt runs past the end of the song’s audio. Move or shorten it and retain it again.";
  }
}

function ineligibleText(reason: SongVideoIneligibility): string {
  switch (reason) {
    case "song_not_found":
      return "That song isn’t available to post a video to.";
    case "age_restricted":
      return "That song is age restricted for this account, so a video can’t be posted to it.";
    case "song_owner_policy_unavailable":
      return "This song’s owner settings couldn’t be read, so a video can’t be posted to it yet.";
    case "derivative_video_blocked":
      return "This song’s owner doesn’t allow videos to be posted to it.";
    case "derivative_video_owner_only":
      return "Only this song’s owner can post videos to it.";
  }
}

/** The excerpt's span as the author chose it, from the samples that will be sent. */
export function selectionSpan(selection: SongVideoSelection): string {
  const start = selection.clipStartSamples / SAMPLES_PER_MS;
  const end =
    (selection.clipStartSamples + selection.clipDurationSamples) /
    SAMPLES_PER_MS;
  return `${formatExcerptTime(start)} to ${formatExcerptTime(end)}`;
}

/** What publishing will do, in every state. Only `ready` carries the song into
 * a publication, and even then as the server's decision; any other state
 * blocks publishing, because every video uses a song. */
export function songPlanText(state: SongPlanState): string {
  switch (state.kind) {
    case "none":
      return "Retain an excerpt to ask whether this video can be posted to the song. Every video uses a song, so publishing waits for it.";
    case "checking":
      return "Checking this excerpt with the server…";
    case "not_available":
      return `Posting a video to a song isn’t available yet. ${SONG_BLOCKED}`;
    case "measuring":
      return `The song is still being prepared for video; it will be checked again in a moment. ${SONG_BLOCKED}`;
    case "timing_unavailable":
      return `This song’s length couldn’t be measured, so a video can’t be posted to it. ${SONG_BLOCKED}`;
    case "refused":
      return `${refusalText(state.reason)} ${SONG_BLOCKED}`;
    case "ineligible":
      return `${ineligibleText(state.reasonCode)} ${SONG_BLOCKED}`;
    case "failed":
      return state.retryable
        ? `This excerpt couldn’t be checked. Check it again. ${SONG_BLOCKED}`
        : `This excerpt couldn’t be checked. ${SONG_BLOCKED}`;
    case "ready":
      return `Publishing asks the server to post this video to the song, from ${selectionSpan(state.selection)}. It checks the excerpt again then, and the video is posted to the song only if it accepts.`;
  }
}

/** Why a song-backed reservation was refused, and what the author can do. */
export function songReservationRefusalText(
  reasonCode: SongRejectionCode | undefined,
): string | undefined {
  switch (reasonCode) {
    case undefined:
      return undefined;
    case "capability_unavailable":
      return "Video posts aren’t available right now.";
    case "song_audio_revision_changed":
      return "The song changed. Choose it again before recording.";
    case "canonical_timing_pending":
      return "This song is still getting ready for videos.";
    case "canonical_timing_unavailable":
      return "This song’s length couldn’t load.";
    case "song_reference_mismatch":
      return "The song couldn’t be confirmed. Nothing was uploaded.";
    case "invalid_interval":
      return "Choose a different part of the song.";
    case "interval_too_short":
      return "This song needs a longer video.";
    case "interval_too_long":
      return "This song allows only shorter videos.";
    case "canonical_song_interval_uncovered":
      return "Choose an earlier part of the song.";
    case "song_not_found":
      return "This song is no longer available.";
    case "age_restricted":
      return "Your account can’t use this age-restricted song.";
    case "song_owner_policy_unavailable":
      return "This song’s video settings couldn’t load.";
    case "derivative_video_blocked":
      return "This song is closed to video posts.";
    case "derivative_video_owner_only":
      return "Only the song’s creator can use it for video posts.";
  }
}

/** A blocked song-backed video: why the song can no longer be used. */
export function songReferenceInvalidText(
  code: SongReasonCode | null | undefined,
): string {
  const next = "Start a new video and choose a song again.";
  switch (code) {
    case "song_not_published":
      return `The song this video was posted to is no longer published, so the video can’t be published with it. ${next}`;
    case "song_audio_revision_missing":
      return `The song’s audio changed after the excerpt was chosen, so this video can’t be published with it. ${next}`;
    case "derivative_video_blocked":
      return `The song’s owner no longer allows videos to be posted to it. ${next}`;
    case "derivative_video_owner_only":
      return `Only the song’s owner can post videos to it now. ${next}`;
    case null:
    case undefined:
      return `The song this video was posted to can no longer be used. ${next}`;
  }
}
