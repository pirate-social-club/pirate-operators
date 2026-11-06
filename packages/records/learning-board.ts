import type { Hex } from "viem";
import type { PublicResult } from "./results-v2.ts";

export interface LearningPolicy {
  scoringPolicies: readonly Hex[];
  terminalStatuses: readonly number[];
  minScoreBps: number;
  maxUnmeasuredBps: number;
}
export interface BoardRow { learner: string; days: number; current: number; best: number; rank: number | null }

/** Call for one community or a filtered song, at a fixed canonical head and evaluation period. */
export function learningBoard(results: readonly PublicResult[], evaluationPeriod: bigint,
  policies: ReadonlyMap<Hex, LearningPolicy>, ineligible: ReadonlySet<string> = new Set()): BoardRow[] {
  const days = new Map<string, Set<bigint>>();
  for (const evidence of results) {
    const r = evidence.result, policy = policies.get(r.qualificationPolicy);
    if (!evidence.verified || !policy || !policy.terminalStatuses.includes(r.status) ||
      !policy.scoringPolicies.includes(r.scoringPolicy) || evidence.period > evaluationPeriod) continue;
    const unmeasured = evidence.lines.filter((line) => line.status === "unmeasured").length;
    const denominator = evidence.lines.length - unmeasured;
    const sum = evidence.lines.reduce((value, line) => value + (line.status === "assessed" ? line.scoreBps! : 0), 0);
    if (denominator === 0 || Math.floor(sum / denominator) < policy.minScoreBps ||
      unmeasured * 10000 > policy.maxUnmeasuredBps * evidence.lines.length) continue;
    const learner = r.learner.toLowerCase(), periods = days.get(learner) ?? new Set<bigint>();
    periods.add(evidence.period); days.set(learner, periods);
  }
  const board = [...days].map(([learner, periods]) => {
    let current = 0, best = 0, run = 0, previous: bigint | undefined;
    for (const period of [...periods].sort((a, b) => a < b ? -1 : 1)) {
      run = previous !== undefined && period === previous + 1n ? run + 1 : 1;
      best = Math.max(best, run); previous = period;
    }
    let last = periods.has(evaluationPeriod) ? evaluationPeriod : evaluationPeriod - 1n;
    while (periods.has(last)) { current++; last--; }
    return { learner, days: periods.size, current, best, rank: null as number | null };
  }).sort((a, b) => b.current - a.current || b.best - a.best || a.learner.localeCompare(b.learner));
  let position = 0, rank = 0, previous: BoardRow | undefined;
  for (const row of board) {
    if (ineligible.has(row.learner)) continue;
    position++;
    if (!previous || previous.current !== row.current || previous.best !== row.best) rank = position;
    row.rank = rank; previous = row;
  }
  return board;
}
