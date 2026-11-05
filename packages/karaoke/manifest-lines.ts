// Adapts the protocol's timed karaoke manifest to the centralized display
// model. Every word keeps its published text and millisecond range; the
// adopted transform owns spacing, punctuation and canonical-text alignment.
import type { ManifestLine } from "../protocol/payments.ts";
import {
  toKaraokeStageLines,
  type KaraokeStageLine,
  type RawKaraokeLine,
} from "./lyric-transform.ts";

export function karaokeStageLinesOf(
  lines: readonly ManifestLine[],
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
