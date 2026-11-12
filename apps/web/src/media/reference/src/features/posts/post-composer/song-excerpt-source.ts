import { ServiceRefusal as ApiClientError } from "../../../service-refusal.ts";
import type { ExcerptBounds } from "./song-excerpt.ts";
/** Resolving a chosen song post into something the excerpt selector can use.
 *
 * The audio comes from the song playback access operation, which is the same
 * full mix the song player plays and needs nothing from Karaoke: lyrics
 * acceptance, alignment or the Karaoke runtime are not preconditions for
 * posting a video to a song. What that grant proves is narrow, and the states
 * below keep it narrow: a playable full mix exists. Permission to render that
 * audio into a published video is the server's separate decision, asked
 * through the preflight and decided again at reservation.
 *
 * A song is named by its ordinary post link, its `/p/<post id>` link or a bare
 * post id. The slug form is resolved through the public post read first, which
 * answers with the post id the playback access takes.
 */
export type SongSourceState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly audioUrl: string;
      readonly postId: string;
      readonly title: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly retryable: boolean;
    }
  | { readonly kind: "restricted"; readonly reason: string }
  | {
      readonly kind: "error";
      readonly reason: string;
      readonly retryable: boolean;
    };

export type SongSourceRequest =
  | {
      readonly kind: "post";
      readonly postId: string;
      readonly communityId?: string;
    }
  | { readonly kind: "slug"; readonly slug: string };

export type SongSourceRead = {
  readonly postId: string;
  readonly audioUrl: string;
  readonly title: string | null;
};

export type SongSourceReader = (
  request: SongSourceRequest,
  signal?: AbortSignal,
) => Promise<SongSourceRead>;

/** A refusal the reader can name, so the screen sends people to the right fix
 * instead of collapsing every failure into one message. */
export class SongSourceError extends Error {
  readonly reasonCode:
    | "not_found"
    | "age_restricted"
    | "playback_unavailable"
    | "rate_limited"
    | "read_failed";
  readonly retryable: boolean;
  constructor(
    reasonCode: SongSourceError["reasonCode"],
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.reasonCode = reasonCode;
    this.retryable = retryable;
    this.name = "SongSourceError";
  }
}

function stateFromSourceError(error: SongSourceError): SongSourceState {
  switch (error.reasonCode) {
    case "not_found":
      return {
        kind: "unavailable",
        reason: "That song isn’t available to play.",
        retryable: false,
      };
    case "age_restricted":
      return {
        kind: "restricted",
        reason: "Your account can’t use this age-restricted song.",
      };
    case "playback_unavailable":
      return {
        kind: "unavailable",
        reason: "This song has no playable audio.",
        retryable: false,
      };
    case "rate_limited":
      return {
        kind: "error",
        reason: "Too many song requests just now. Try again in a moment.",
        retryable: true,
      };
    case "read_failed":
      return {
        kind: "error",
        reason: "That song couldn’t load.",
        retryable: error.retryable,
      };
  }
}

/** Maps a read into a state. Separated from the fetching so every outcome is
 * testable without a network or an audio element. The wording is what a person
 * acts on; the underlying error is never surfaced, because it can carry
 * request detail. */
export async function loadSongSource(
  request: SongSourceRequest,
  read: SongSourceReader,
  signal?: AbortSignal,
): Promise<SongSourceState> {
  try {
    const source = await read(request, signal);
    if (!source.audioUrl) {
      return {
        kind: "unavailable",
        reason: "That song has no playable audio yet.",
        retryable: true,
      };
    }
    return {
      kind: "ready",
      audioUrl: source.audioUrl,
      postId: source.postId,
      title: source.title?.trim() || "Untitled song",
    };
  } catch (error) {
    if (error instanceof SongSourceError) return stateFromSourceError(error);
    if (error instanceof Error && error.name === "AbortError") {
      return {
        kind: "error",
        reason: "Loading was cancelled.",
        retryable: true,
      };
    }
    if (error instanceof ApiClientError) {
      if (error.status === 404) {
        return stateFromSourceError(
          new SongSourceError("not_found", "Song not found", false),
        );
      }
      if (error.status === 429) {
        return stateFromSourceError(
          new SongSourceError("rate_limited", "Too many requests", true),
        );
      }
    }
    return {
      kind: "error",
      reason: "That song couldn’t load.",
      retryable: error instanceof ApiClientError ? error.retryable : true,
    };
  }
}

/** The server's measured bounds for a song's canonical audio. */
export type { ExcerptBounds };
