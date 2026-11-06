// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/karaoke-results-model.ts; only imports changed.
// karaokeOperatorResultsView is new, for the operator's signed per-line result.
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

/** The parts of the operator's signed result the results page reads. */
export interface KaraokeOperatorResult {
  readonly status: "completed" | "abandoned" | "expired" | "payment_missing";
  readonly summary: { readonly scoreBps: number };
  readonly lines: readonly { readonly status: string; readonly scoreBps: number | null }[];
  readonly unmeasuredCount: number;
}

/**
 * The results page for an operator-graded take. The operator signs one score
 * and per-line statuses, so this shows only those: no separate lyric or
 * timing score is invented.
 */
export function karaokeOperatorResultsView(result: KaraokeOperatorResult): KaraokeResultsView {
  const assessed = result.lines.filter((line) => line.status === "assessed").length;
  if (result.status === "payment_missing")
    return { heading: "Take stopped", scorePercent: null, stats: [], note: "Two lines in a row couldn't be paid for, so the take stopped." };
  if (assessed === 0)
    return {
      heading: "No lines scored",
      scorePercent: null,
      stats: [],
      note: "We couldn't hear the lyrics this time. Check your microphone and try again.",
    };
  const score = clampResultPercent(result.summary.scoreBps / 100);
  const note = result.unmeasuredCount > 0
    ? `${lines(result.unmeasuredCount)} couldn't be measured, so ${result.unmeasuredCount === 1 ? "it doesn't" : "they don't"} count toward your score.`
    : undefined;
  return {
    heading: resultHeadline(score, "Performance complete!"),
    scorePercent: score,
    stats: [{ label: "Lines", value: `${assessed} of ${result.lines.length}`, tone: "success" }],
    ...(note === undefined ? {} : { note }),
  };
}
