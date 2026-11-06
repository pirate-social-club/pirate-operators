import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, stringToHex, zeroHash, type Address, type Hex } from "viem";
import { learningBoard } from "../packages/records/learning-board.ts";
import type { PublicResult } from "../packages/records/results-v2.ts";

const hash = (value: string) => keccak256(stringToHex(value));
const policyHash = hash("qualification"), scoring = hash("scoring");
const policies = new Map([[policyHash, { scoringPolicies: [scoring], terminalStatuses: [1, 2, 3, 4], minScoreBps: 7000, maxUnmeasuredBps: 1000 }]]);
function evidence(learner: number, day: number, score = 8000): PublicResult {
  const address = `0x${String(learner).padStart(40, "0")}` as Address;
  return { result: { sessionId: hash(`${learner}:${day}`), learner: address, enrollmentId: hash("grant"),
    song: { chainId: 6343n, posts: address, communityId: hash("community"), postId: hash("song") },
    contentRevision: hash("source"), exercisesHash: hash("exercises"), linesTotal: 1, activity: 1, grader: address,
    scoringPolicy: scoring, qualificationPolicy: policyHash, startedAt: 1793552400n + BigInt(day) * 86400n,
    completedAt: 1793552400n + BigInt(day) * 86400n + 60n, status: 1, revision: 1, supersedes: zeroHash },
    commitment: hash("commitment"), verified: true, problems: [], period: BigInt(day),
    lines: [{ ordinal: 1, status: "assessed", scoreBps: score }], scoreBps: score };
}
// Independent reference scans the finite day grid instead of the implementation's run reducer.
function reference(input: PublicResult[], today: number) {
  const learners = [...new Set(input.filter((r) => r.verified && r.lines[0].scoreBps! >= 7000 &&
    r.result.qualificationPolicy === policyHash).map((r) => r.result.learner.toLowerCase()))];
  return learners.map((learner) => {
    const days = Array.from({ length: today + 1 }, (_, day) => input.some((r) => r.verified && r.result.learner.toLowerCase() === learner &&
      r.period === BigInt(day) && r.lines[0].scoreBps! >= 7000 && r.result.qualificationPolicy === policyHash));
    let current = 0, best = 0;
    for (let start = 0; start < days.length; start++) {
      let n = 0; while (days[start + n]) n++;
      best = Math.max(best, n);
    }
    let day = days[today] ? today : today - 1;
    while (days[day--]) current++;
    return { learner, days: days.filter(Boolean).length, current, best };
  }).sort((a, b) => b.current - a.current || b.best - a.best || a.learner.localeCompare(b.learner));
}
test("independent day-grid reference agrees on late results, repeats, corrections and day expiry", () => {
  const input = [evidence(1, 1), evidence(1, 2), evidence(1, 4), evidence(1, 4), evidence(2, 2), evidence(2, 3), evidence(2, 4)];
  for (const day of [4, 5, 6]) assert.deepEqual(learningBoard(input, BigInt(day), policies).map(({ rank, ...row }) => row), reference(input, day));
  input.push(evidence(1, 3)); // late evidence repairs the original day.
  assert.deepEqual(learningBoard(input, 4n, policies).map(({ rank, ...row }) => row), reference(input, 4));
  input[1] = evidence(1, 2, 0); // current corrected evidence replaces the prior outcome.
  assert.deepEqual(learningBoard(input, 4n, policies).map(({ rank, ...row }) => row), reference(input, 4));
});
test("ties leave rank gaps; eligibility and absent policy do not fabricate credit", () => {
  const input = [evidence(1, 4), evidence(2, 4), evidence(3, 2)];
  assert.deepEqual(learningBoard(input, 4n, policies).map((x) => x.rank), [1, 1, 3]);
  assert.deepEqual(learningBoard(input, 4n, policies, new Set([input[0].result.learner.toLowerCase()])).map((x) => x.rank), [null, 1, 2]);
  assert.deepEqual(learningBoard(input, 4n, new Map()), []);
  const invalid = evidence(4, 4); invalid.verified = false;
  assert.deepEqual(learningBoard([invalid], 4n, policies), []);
});
