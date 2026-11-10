// Separate independent checks compared with real application fixtures/codecs.
import test from "node:test";
import assert from "node:assert/strict";
import { toHex, sha256 } from "viem";
import { digest, canonical } from "../packages/protocol/index.ts";
import {
  packStudyOutcomes,
  STUDY_SCORING_POLICY_HASH,
} from "../packages/protocol/learning-results-v3.ts";
import {
  decodeStudy,
  studySource,
  studyScore,
  studyPolicy,
  referenceStudyScoring,
} from "../harness/reference-results/study.ts";
import type { ReferenceSnapshot } from "../harness/reference-results/facts.ts";
import { studyResultFixture } from "./study-result-fixture.ts";

test("independent Study bytes preserve selected order and first-pass denominator", () => {
  const f = studyResultFixture(),
    r = f.bundle.result;
  assert.equal(f.bundle.outcomes, "0x000702000201000a01000401");
  const decoded = decodeStudy(r, f.bundle.outcomes);
  assert.deepEqual(
    decoded.map((o) => o.ordinal),
    [7, 2, 10, 4],
  );
  assert.deepEqual(studyScore(decoded), {
    total: 4,
    correct: 3,
    graded: 4,
    scoreBps: 7500,
    qualifies: true,
  });
  assert.equal(studySource(r, f.source, decoded), true);
  assert.equal(referenceStudyScoring, STUDY_SCORING_POLICY_HASH);
});
test("independent Study keeps every absence distinct and never qualifies a favorable graded subset", () => {
  const f = studyResultFixture(),
    r = { ...f.bundle.result, status: 2 };
  for (const status of ["unpaid", "unmeasured", "unattempted"] as const) {
    const wire = packStudyOutcomes([
      { sourceOrdinal: 7, status },
      ...[2, 10, 4].map((sourceOrdinal) => ({
        sourceOrdinal,
        status: "correct" as const,
      })),
    ]);
    const decoded = decodeStudy(r, wire),
      score = studyScore(decoded);
    assert.equal(decoded[0].grade, null);
    assert.equal(score.total, 4);
    assert.equal(score.correct, 3);
    assert.equal(score.graded, 3);
    assert.equal(score.scoreBps, null);
    assert.equal(score.qualifies, false);
    assert.throws(() => decodeStudy({ ...r, status: 1 }, wire), /completion/);
  }
});
test("independent Study rejects omissions, duplicates, reordering, unsupported statuses and source substitutions", () => {
  const f = studyResultFixture(),
    r = f.bundle.result;
  for (const wire of [
    "0x000702000201000a01",
    "0x000702000701000a01000401",
    "0x000202000701000a01000401",
    "0x000706000201000a01000401",
  ])
    assert.throws(() => decodeStudy(r, wire as `0x${string}`));
  const shortened = structuredClone(f.source);
  shortened.lines.pop();
  assert.throws(() =>
    studySource(r, shortened, decodeStudy(r, f.bundle.outcomes)),
  );
  const duplicate = structuredClone(f.source);
  duplicate.lines[6].text = "ＨＯＬＤ　ＭＥ　ＣＬＯＳＥ";
  duplicate.sourceText = duplicate.lines.map((l) => l.text).join("\n");
  duplicate.sourceSha256 = sha256(toHex(duplicate.sourceText));
  assert.throws(
    () =>
      studySource(
        { ...r, contentRevision: digest(duplicate) },
        duplicate,
        decodeStudy(r, f.bundle.outcomes),
      ),
    /ineligible_selection/,
  );
});
test("independent Study policy accepts only the exact first-pass schema and pinned scorer", () => {
  const f = studyResultFixture(),
    uri = "ipfs://policy";
  const check = (doc: unknown) => {
    const snapshot = {
      documents: { [uri]: toHex(canonical(doc)) },
    } as unknown as ReferenceSnapshot;
    return studyPolicy(snapshot, uri, digest(doc));
  };
  assert.equal(check(f.policy).minScoreBps, 7000);
  for (const doc of [
    { ...f.policy, requireAllFirstPass: false },
    { ...f.policy, minCorrectNumerator: 6 },
    { ...f.policy, scoringPolicy: `0x${"0".repeat(64)}` },
    { ...f.policy, extra: true },
  ])
    assert.throws(() => check(doc));
});
