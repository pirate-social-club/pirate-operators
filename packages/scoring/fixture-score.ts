import {
  aggregateKaraokeSession,
  bucketRecognizedWordsIntoLines,
  scoreKaraokeLine,
  KARAOKE_SCORING_VERSION,
  type KaraokeRecognizedWord,
} from "./scoring.ts";

export const lines = [
  {
    lineId: "line-1",
    lineIndex: 0,
    scoredLineIndex: 0,
    text: "sing together",
    startMs: 0,
    endMs: 1500,
    words: [
      { text: "sing", startMs: 100, endMs: 500 },
      { text: "together", startMs: 600, endMs: 1200 },
    ],
  },
];
export const performance: KaraokeRecognizedWord[] = lines[0].words.map((w) => ({
  ...w,
  confidence: 1,
  final: true,
  source: "stt",
}));
export function score(words: KaraokeRecognizedWord[]) {
  const buckets = bucketRecognizedWordsIntoLines({
    lines,
    words,
    nowMs: 2000,
    finalizedReason: "session_end",
  });
  const summary = aggregateKaraokeSession({
    lineScores: buckets.map((bucket) => scoreKaraokeLine({ bucket })),
  });
  return {
    scoreBps: Math.round(summary.finalScore * 10000),
    coverageBps: Math.round(
      (summary.scoredLineCount / summary.lineCount) * 10000,
    ),
    scoringVersion: KARAOKE_SCORING_VERSION,
  };
}
