// Private, provisional feedback uses the same scorer as terminal results.
// It never writes a public learning result or accepts browser assessments.
import {
  bucketRecognizedWordsIntoLines,
  scoreKaraokeLine,
  type KaraokeRecognizedWord,
  type KaraokeLineScore,
  type KaraokeSessionSummary,
} from "../packages/scoring/scoring.ts";
import type { KaraokeManifest } from "../packages/protocol/payments.ts";
export interface LineFeedback {
  lineId: string;
  scoredLineIndex: number;
  score: number;
  uncertain: boolean;
}
export function liveLineScores(
  manifest: KaraokeManifest,
  words: KaraokeRecognizedWord[],
  failedLineIds: readonly string[],
  throughMs: number,
): LineFeedback[] {
  return bucketRecognizedWordsIntoLines({
    lines: manifest.lines.map((line, index) => ({
      ...line,
      lineIndex: index,
      scoredLineIndex: index,
    })),
    words,
    nowMs: throughMs,
    finalizedReason: "line_end",
  })
    .filter((bucket) => bucket.expectedLine.endMs <= throughMs)
    .map((bucket) =>
      scoreKaraokeLine({
        bucket: failedLineIds.includes(bucket.lineId)
          ? { ...bucket, finalizedReason: "provider_failed" }
          : bucket,
      }),
    )
    .map(({ lineId, scoredLineIndex, score, uncertain }) => ({
      lineId,
      scoredLineIndex,
      score,
      uncertain,
    }));
}
export function karaokePresentation(
  summary: KaraokeSessionSummary,
  lineScores: readonly KaraokeLineScore[],
) {
  let combo = 0,
    bestCombo = 0;
  for (const line of [...lineScores].sort(
    (a, b) => a.scoredLineIndex - b.scoredLineIndex,
  )) {
    if (line.uncertain) continue;
    combo = line.score >= 0.5 ? combo + 1 : 0;
    bestCombo = Math.max(bestCombo, combo);
  }
  return {
    finalScore: summary.finalScore,
    lyricsScore: summary.lyricsScore,
    timingScore: summary.timingScore,
    timingTrend: summary.timingTrend,
    scoredLineCount: summary.scoredLineCount,
    uncertainLineCount: summary.uncertainLineCount,
    bestCombo,
  };
}
