import {
  clampExcerpt,
  type ExcerptBounds,
  isSubmittableExcerpt,
} from "./song-excerpt.ts";

/** The excerpt selection as it is retained with a video draft.
 *
 * Reopening a draft must restore the same integer milliseconds that were
 * chosen, because these are the values publication and MP3 extraction use. A
 * draft that restored something merely close would produce a video danced to
 * one span and an MP3 cut from another.
 *
 * The identity retained beside the bounds is the song post's id, which is what
 * the payload read takes and what publication will name. It is not the song
 * entity's id; those are different lookups, and a field that blurred them
 * would send a later step to the wrong record.
 */
export const SONG_EXCERPT_DRAFT_VERSION = "song-excerpt-draft-v2";

export type SongExcerptDraft = {
  readonly endMs: number;
  readonly songPostId: string;
  readonly startMs: number;
  readonly version: typeof SONG_EXCERPT_DRAFT_VERSION;
};

/** A store yields a draft or nothing. Parsing belongs at the boundary that
 * reads the bytes, so nothing downstream of here handles an unparsed value. */
export type SongExcerptDraftStore = {
  readonly load: () => Promise<SongExcerptDraft | null>;
  readonly save: (draft: SongExcerptDraft) => Promise<void>;
};

/** A store that lives only as long as the composer that made it. The
 * selection stays while the composer is open, across a change of song and back,
 * and starts fresh when it is reopened: nothing is written anywhere a later
 * session could read. */
export function createMemoryExcerptDraftStore(): SongExcerptDraftStore {
  let held: SongExcerptDraft | null = null;
  return {
    load: async () => held,
    save: async (draft) => {
      held = draft;
    },
  };
}

export function makeSongExcerptDraft(
  songPostId: string,
  bounds: ExcerptBounds,
): SongExcerptDraft {
  return {
    endMs: bounds.endMs,
    songPostId,
    startMs: bounds.startMs,
    version: SONG_EXCERPT_DRAFT_VERSION,
  };
}

/** Narrows a stored value to a draft. A guard rather than an assertion, so
 * nothing is claimed about the value that has not been checked. */
export function isSongExcerptDraft(value: unknown): value is SongExcerptDraft {
  if (typeof value !== "object" || value === null) return false;
  if (
    !(
      "version" in value &&
      "songPostId" in value &&
      "startMs" in value &&
      "endMs" in value
    )
  ) {
    return false;
  }
  return (
    value.version === SONG_EXCERPT_DRAFT_VERSION &&
    typeof value.songPostId === "string" &&
    typeof value.startMs === "number" &&
    typeof value.endMs === "number"
  );
}

/** The I/O boundary: whatever a store held becomes a draft or nothing. Stale,
 * hand-edited and older-version values are rejected here rather than repaired,
 * so nothing downstream has to wonder what it is holding. */
export function parseStoredExcerptDraft(
  value: unknown,
): SongExcerptDraft | null {
  return isSongExcerptDraft(value) ? value : null;
}

/** Reads a retained draft against the song post it names. Range is the one
 * thing clamped rather than rejected, because a song can legitimately have
 * changed length under a draft; identity and shape are not repaired. */
export function readSongExcerptDraft(
  draft: SongExcerptDraft | null,
  song: { readonly durationMs: number; readonly id: string } | undefined,
): { bounds: ExcerptBounds; songPostId: string } | null {
  if (!song || !draft || draft.songPostId !== song.id) return null;
  const bounds = clampExcerpt(
    { startMs: draft.startMs, endMs: draft.endMs },
    song.durationMs,
  );
  return isSubmittableExcerpt(bounds, song.durationMs)
    ? { bounds, songPostId: song.id }
    : null;
}

/** Round-trips through a store. Kept as one pair so the save and the load
 * cannot drift apart. */
export async function retainSongExcerpt(
  store: SongExcerptDraftStore,
  songPostId: string,
  bounds: ExcerptBounds,
): Promise<void> {
  await store.save(makeSongExcerptDraft(songPostId, bounds));
}

export async function restoreSongExcerpt(
  store: SongExcerptDraftStore,
  song: { readonly durationMs: number; readonly id: string } | undefined,
): Promise<{ bounds: ExcerptBounds; songPostId: string } | null> {
  return readSongExcerptDraft(await store.load(), song);
}
