// Adapts the protocol's timed karaoke manifest to the centralized display
// model. Every word keeps its published text and millisecond range; the
// adopted transform owns spacing, punctuation and canonical-text alignment.
import {
  toKaraokeStageLines,
  type KaraokeStageLine,
  type RawKaraokeLine,
} from "./lyric-transform.ts";

/**
 * The timing fields of the protocol's ManifestLine in
 * packages/protocol/payments.ts, declared structurally so the browser build
 * does not depend on the protocol's chain libraries. Real adapter calls in
 * the manifest-line tests also check ManifestLine assignability at typecheck.
 */
export interface KaraokeTimedWord {
  text: string;
  startMs: number;
  endMs: number;
}
export interface KaraokeTimedLine {
  lineId: string;
  ordinal: number;
  text: string;
  startMs: number;
  endMs: number;
  words: readonly KaraokeTimedWord[];
}

export function karaokeStageLinesOf(
  lines: readonly KaraokeTimedLine[],
): KaraokeStageLine[] {
  const raw: RawKaraokeLine[] = [...lines]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((line) => ({
      id: line.lineId,
      text: line.text,
      startMs: line.startMs,
      endMs: line.endMs,
      words: line.words.map((word) => ({
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
      })),
    }));
  return toKaraokeStageLines(raw);
}
