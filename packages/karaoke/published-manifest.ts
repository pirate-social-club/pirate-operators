// The Karaoke manifest of a published song: its immutable lyric manifest's
// occurrence IDs with the timings of one completed forced alignment.
// Line building adapts api-next a5c63b8db01d4359344d33c31d294a00fbeadb20
// packages/platform-cf/src/karaoke-readiness-repository.ts
// buildKaraokePayloadLines: a line's words must reproduce its text, it starts
// at its first word and ends at its last, and section cues are not scored.
// Nothing is interpolated: a line without usable timing makes the song
// unavailable for Karaoke rather than fabricated.
import { hashJson } from "../community/common.ts";
import { check } from "../protocol/index.ts";
import {
  validateManifest,
  type KaraokeManifest,
  type ManifestLine,
  type ManifestSong,
} from "../protocol/payments.ts";
import { songKeyOf } from "../protocol/records.ts";
import {
  validateLyrics,
  type LyricManifest,
} from "../community/lyric-manifest.ts";
import {
  isSectionCue,
  type AlignedWord,
  type AlignmentResult,
} from "../alignment/elevenlabs-response.ts";

/** The LearningRecords song key of a published post. */
export const publishedSongOf = (lyrics: LyricManifest): ManifestSong => ({
  chainId: lyrics.chainId,
  posts: lyrics.postsContract,
  communityId: lyrics.communityId,
  postId: lyrics.postId,
});

const compact = (value: string) => value.replace(/\s+/gu, "");

export function publishedKaraokeManifest(
  input: LyricManifest,
  alignment: Pick<AlignmentResult, "words">,
  maxSegmentMs: number,
): KaraokeManifest {
  const lyrics = validateLyrics(input),
    byLine = new Map<string, AlignedWord[]>();
  for (const word of alignment.words) {
    const words = byLine.get(word.lineId) ?? [];
    words.push(word);
    byLine.set(word.lineId, words);
  }
  const lines: ManifestLine[] = [];
  for (const line of lyrics.lines) {
    const words = byLine.get(line.lineId) ?? [];
    byLine.delete(line.lineId);
    if (isSectionCue(line.text)) {
      check(words.length === 0, "invalid_timed_lyrics");
      continue;
    }
    check(
      words.length > 0 &&
        words.every(
          (w, i) =>
            w.wordIndex === i &&
            w.lineVersion === line.lineVersion &&
            w.endMs >= w.startMs &&
            (i === 0 || w.startMs >= words[i - 1]!.endMs),
        ) &&
        compact(words.map((w) => w.text).join("")) === compact(line.text),
      "invalid_timed_lyrics",
    );
    const startMs = words[0]!.startMs,
      endMs = words.at(-1)!.endMs;
    check(endMs > startMs, "invalid_timed_lyrics");
    lines.push({
      lineId: line.lineId,
      lineVersion: line.lineVersion,
      ordinal: lines.length + 1,
      text: line.text,
      startMs,
      endMs,
      words: words.map(({ text, startMs, endMs }) => ({
        text,
        startMs,
        endMs,
      })),
    });
  }
  // Every timed word belongs to one retained occurrence of this revision.
  check(byLine.size === 0, "invalid_timed_lyrics");
  const song = publishedSongOf(lyrics),
    manifest: KaraokeManifest = {
      manifestVersion: "pirate.karaoke.manifest/1",
      songHash: songKeyOf(song),
      lines,
      // One purchase per sung line, as in the local fixture songs.
      segments: lines.map((line) => ({
        segmentId: `s${line.ordinal}`,
        startMs: line.startMs,
        endMs: line.endMs,
        lineIds: [line.lineId],
      })),
      song,
      source: { lyricsRevision: lyrics.revision, lyricsSha256: hashJson(lyrics) },
    };
  validateManifest(manifest, maxSegmentMs);
  return manifest;
}
