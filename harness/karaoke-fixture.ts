import type { Hex } from "viem";
import { digest, type Song } from "../packages/protocol/index.ts";
import type {
  KaraokeManifest,
  ManifestLine,
} from "../packages/protocol/payments.ts";
import type { KaraokeRecognizedWord } from "../packages/scoring/scoring.ts";

// Fixture learning material, labelled as fixture. Occurrence IDs are stable
// per line occurrence; the repeated chorus line is its own occurrence.
const text = [
  ["line-01", "sing together", 0, 2000],
  ["line-02", "hold the light", 2500, 4500],
  ["line-03", "sing together", 5000, 7000],
  ["line-04", "all night long", 20000, 22000],
] as const;

function words(phrase: string, startMs: number, endMs: number) {
  const parts = phrase.split(" ");
  const step = Math.floor((endMs - startMs - 400) / parts.length);
  return parts.map((part, i) => ({
    text: part,
    startMs: startMs + 200 + i * step,
    endMs: startMs + 200 + i * step + step - 100,
  }));
}
export const fixtureLyrics = text.map(([, phrase]) => phrase).join("\n");

export function fixtureManifest(song: Song): KaraokeManifest {
  const lines: ManifestLine[] = text.map(([lineId, phrase, startMs, endMs], i) => ({
    lineId,
    lineVersion: 1,
    ordinal: i + 1,
    text: phrase,
    startMs,
    endMs,
    words: words(phrase, startMs, endMs),
  }));
  return {
    manifestVersion: "pirate.karaoke.manifest/1",
    songHash: digest(song) as Hex,
    lines,
    segments: lines.map((line, i) => ({
      segmentId: `seg-0${i + 1}`,
      startMs: line.startMs,
      endMs: line.endMs,
      lineIds: [line.lineId],
    })),
  };
}

/** Simulated provider output: exact singing, optionally wrong on chosen lines. */
export function sungWords(
  manifest: KaraokeManifest,
  options: { lineIds?: readonly string[]; wrong?: readonly string[] } = {},
): KaraokeRecognizedWord[] {
  return manifest.lines
    .filter((line) => !options.lineIds || options.lineIds.includes(line.lineId))
    .flatMap((line) =>
      line.words.map((word) => ({
        ...word,
        text: options.wrong?.includes(line.lineId) ? "mumble" : word.text,
        confidence: 1,
        final: true,
        source: "stt" as const,
      })),
    );
}
