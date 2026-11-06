// Adopted from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db; type and import adapters only.
import type { LineFeedback as KaraokeLineScore } from "../../../../services/karaoke-feedback.ts";
interface KaraokeScoringState { lineScores: readonly KaraokeLineScore[]; latestLineId: string | null }
import type { KaraokeLineRating } from "./lyric-stage.tsx";

export const RATING_PERFECT_THRESHOLD = 0.9;
export const RATING_GREAT_THRESHOLD = 0.75;
const RATING_GOOD_THRESHOLD = 0.5;
export const COMBO_THRESHOLD = RATING_GOOD_THRESHOLD;

export type RatingTier = "perfect" | "great" | "good" | "miss";

export function ratingTierForScore(score: number): RatingTier {
  if (score >= RATING_PERFECT_THRESHOLD) return "perfect";
  if (score >= RATING_GREAT_THRESHOLD) return "great";
  if (score >= RATING_GOOD_THRESHOLD) return "good";
  return "miss";
}

const RATING_LABEL = {
  perfect: "Perfect",
  great: "Great",
  good: "Good",
  miss: "Miss",
} satisfies Record<RatingTier, string>;

const RATING_TONE = {
  perfect: "success",
  great: "info",
  good: "warning",
  miss: "destructive",
} satisfies Record<RatingTier, KaraokeLineRating["tone"]>;

export interface KaraokeFeedback {
  runningScore: number;
  combo: number;
  bestCombo: number;
  rating: KaraokeLineRating | null;
}

const EMPTY_FEEDBACK: KaraokeFeedback = { bestCombo: 0, combo: 0, rating: null, runningScore: 0 };

/** Derives the transient rating pop for the most recently finalized line. */
export function deriveKaraokeFeedback(state: KaraokeScoringState | null): KaraokeFeedback {
  if (!state || state.lineScores.length === 0) return EMPTY_FEEDBACK;

  const ordered = [...state.lineScores].sort((a, b) => a.scoredLineIndex - b.scoredLineIndex);
  let runningScore = 0;
  let combo = 0;
  let bestCombo = 0;
  for (const line of ordered) {
    if (line.uncertain) continue;
    runningScore += Math.round(line.score * 100);
    if (ratingTierForScore(line.score) === "miss") combo = 0;
    else {
      combo += 1;
      bestCombo = Math.max(bestCombo, combo);
    }
  }

  const latest = state.latestLineId
    ? ordered.find((line: KaraokeLineScore) => line.lineId === state.latestLineId) ?? null
    : null;
  if (!latest || latest.uncertain) return { bestCombo, combo, rating: null, runningScore };

  const tier = ratingTierForScore(latest.score);
  return {
    bestCombo,
    combo,
    rating: {
      lineId: latest.lineId,
      key: `${latest.lineId}:${latest.scoredLineIndex}:${latest.score}`,
      label: RATING_LABEL[tier],
      points: Math.round(latest.score * 100),
      tone: RATING_TONE[tier],
    },
    runningScore,
  };
}
