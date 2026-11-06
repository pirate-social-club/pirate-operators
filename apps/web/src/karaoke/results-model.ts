// Adopted from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db; imports only.
import { clampResultPercent, resultHeadline, type ActivityResultStat } from "./activity-results.tsx";
import type { KaraokeSessionSummary, KaraokeTimingTrend } from "../../../../packages/scoring/scoring.ts";

/** The parts of the server session summary the results page reads. */
export type KaraokeResultsSummary = Pick<KaraokeSessionSummary, "finalScore" | "lyricsScore" | "timingScore" | "timingTrend" | "scoredLineCount" | "uncertainLineCount">;

export interface KaraokeResultsView {
  readonly heading: string;
  readonly scorePercent: number | null;
  readonly stats: readonly ActivityResultStat[];
  readonly note?: string;
}

const timingLabels = {
  early: "Early",
  late: "Late",
  mixed: "Mixed",
  on_time: "On time",
} satisfies Record<KaraokeTimingTrend, string>;

function lines(count: number): string {
  return count === 1 ? "1 line" : `${count} lines`;
}

/**
 * The first completion page for a Karaoke take, built only from the server
 * session summary and the client's own combo count. No number is invented:
 * a missing summary or a take with no recognised lyrics shows no score.
 */
export function karaokeResultsView(summary: KaraokeResultsSummary | null, bestCombo: number): KaraokeResultsView {
  if (summary === null) {
    return { heading: "Take ended", scorePercent: null, stats: [], note: "Your score for this take wasn't received." };
  }
  if (summary.scoredLineCount === 0) {
    return {
      heading: "No lines scored",
      scorePercent: null,
      stats: [],
      note: "We couldn't hear the lyrics this time. Check your microphone and try again.",
    };
  }
  const score = clampResultPercent(summary.finalScore * 100);
  const stats: ActivityResultStat[] = [
    { label: "Lyrics", value: `${clampResultPercent(summary.lyricsScore * 100)}%`, tone: "success" },
    // A null timing score was not part of this take's score; say so rather than show a number.
    { label: "Timing", value: summary.timingScore === null ? "Not scored" : timingLabels[summary.timingTrend], tone: "primary" },
    { label: "Best combo", value: `×${Math.max(0, Math.floor(bestCombo))}`, tone: "warning" },
  ];
  const note = summary.uncertainLineCount > 0
    ? `${lines(summary.uncertainLineCount)} couldn't be measured, so ${summary.uncertainLineCount === 1 ? "it doesn't" : "they don't"} count toward your score.`
    : undefined;
  return {
    heading: resultHeadline(score, "Performance complete!"),
    scorePercent: score,
    stats,
    ...(note === undefined ? {} : { note }),
  };
}
