import { test } from "node:test";
import assert from "node:assert/strict";
import { zeroHash } from "viem";
import { completedStudyBundle } from "../packages/study/result-adapter.ts";
import { studySourceSelection } from "../packages/study/public-source.ts";
import {
  packStudyOutcomes,
  studyExercisesHash,
  studyFirstPassScore,
  unpackStudyOutcomes,
} from "../packages/protocol/learning-results-v3.ts";
import { studyResultFixture } from "./study-result-fixture.ts";

test("Study has an independent byte vector and keeps first-pass misses after mastery", () => {
  const { state, bundle } = studyResultFixture();
  assert(state.items.every((x) => x.mastered));
  assert.equal(state.presentationCount, 5);
  assert.equal(bundle.outcomes, "0x000702000201000a01000401");
  // Independently calculated with cast keccak on the literal ordinal bytes.
  assert.equal(
    bundle.result.exercisesHash,
    "0xf7930735c7334e84c22370fafba26c8d0a608fcd751db170ac3f1eb6e4a32efa",
  );
  const outcomes = unpackStudyOutcomes(bundle.outcomes, 4);
  assert.deepEqual(
    outcomes.map((x) => x.sourceOrdinal),
    [7, 2, 10, 4],
  );
  assert.deepEqual(studyFirstPassScore(outcomes), {
    graded: 4,
    correct: 3,
    total: 4,
    scoreBps: 7500,
    qualifies: true,
  });
  const failed = studyResultFixture([false, false, true, true]);
  assert(failed.state.items.every((x) => x.mastered));
  assert.equal(
    studyFirstPassScore(unpackStudyOutcomes(failed.bundle.outcomes, 4))
      .qualifies,
    false,
  );
  const publicText = JSON.stringify(bundle, (_, value) =>
    typeof value === "bigint" ? String(value) : value,
  );
  for (const privateValue of [
    "private-lesson-id",
    "private-attempt-",
    "heardTranscript",
    "recordingDurationMs",
  ])
    assert(!publicText.includes(privateValue));
});

test("Study count, order, duplicate, status and absence validation do not shrink the denominator", () => {
  assert.throws(() => studyExercisesHash([1, 2, 3]), /invalid_study_count/);
  assert.throws(
    () => studyExercisesHash(Array.from({ length: 11 }, (_, i) => i + 1)),
    /invalid_study_count/,
  );
  assert.throws(() => studyExercisesHash([1, 2, 3, 3]), /duplicate_exercise/);
  assert.throws(
    () => studyExercisesHash([0, 2, 3, 4]),
    /invalid_source_ordinal/,
  );
  assert.throws(
    () => studyExercisesHash([2001, 2, 3, 4]),
    /invalid_source_ordinal/,
  );
  assert.notEqual(
    studyExercisesHash([1, 2, 3, 4]),
    studyExercisesHash([2, 1, 3, 4]),
  );
  assert.throws(
    () => unpackStudyOutcomes("0x000101000201000301000406", 4),
    /invalid_study_outcome/,
  );
  const partial = ["correct", "correct", "correct", "unmeasured"] as const;
  const outcomes = partial.map((status, i) => ({
    sourceOrdinal: i + 1,
    status,
  }));
  assert.deepEqual(
    unpackStudyOutcomes(packStudyOutcomes(outcomes), 4),
    outcomes,
  );
  assert.deepEqual(studyFirstPassScore(outcomes), {
    graded: 3,
    correct: 3,
    total: 4,
    scoreBps: 7500,
    qualifies: false,
  });
  for (let n = 4; n <= 10; n++)
    for (let correct = 0; correct <= n; correct++) {
      const lines = Array.from({ length: n }, (_, i) => ({
        sourceOrdinal: i + 1,
        status: i < correct ? ("correct" as const) : ("incorrect" as const),
      }));
      assert.equal(
        studyFirstPassScore(lines).qualifies,
        correct >= Math.ceil((7 * n) / 10),
      );
    }
});

test("completed adapter refuses active, incomplete, changed-source and incompatible enrollment snapshots", () => {
  const { input } = studyResultFixture();
  const changed = () => structuredClone(input);
  let value = changed();
  value.state.status = "active";
  assert.throws(() => completedStudyBundle(value), /study_not_completed/);
  value = changed();
  value.state.items[0].firstPassOutcome = null;
  assert.throws(() => completedStudyBundle(value), /invalid_study_first_pass/);
  value = changed();
  value.state.items[0].line.text = "changed reference";
  assert.throws(() => completedStudyBundle(value), /study_source_mismatch/);
  value = changed();
  value.state.presentationCount--;
  assert.throws(() => completedStudyBundle(value), /invalid_study_completion/);
  value = changed();
  value.enrollment.issuedAt += 60;
  assert.throws(() => completedStudyBundle(value), /study_enrollment_mismatch/);
  value = changed();
  value.enrollment.id = zeroHash;
  assert.throws(
    () => completedStudyBundle(value),
    /invalid_study_publication_identity/,
  );
  value = changed();
  value.state.items[0].firstPassOutcome = "correct";
  assert.throws(() => completedStudyBundle(value), /invalid_study_first_pass/);
  const a = completedStudyBundle(input),
    b = completedStudyBundle({ ...input, lessonId: "another-private-lesson" });
  assert.notEqual(a.result.sessionId, b.result.sessionId);
});

test("the full source determines eligibility, first occurrence and exact line versions", () => {
  const { source } = studyResultFixture();
  assert.throws(
    () => studySourceSelection(source, [1, 2, 3, 4]),
    /ineligible_study_exercise/,
  );
  assert.throws(
    () => studySourceSelection(source, [6, 3, 4, 5]),
    /ineligible_study_exercise/,
  );
  assert.throws(
    () => studySourceSelection(source, [2, 3, 4, 11]),
    /ineligible_study_exercise/,
  );
  const selected = studySourceSelection(source, [7, 2, 10, 4]);
  assert.equal(selected.selected[0].lineId, source.lines[6].lineId);
  assert.equal(selected.selected[1].text, source.lines[1].text);
});

test("presentation-budget completion preserves every first pass, including unresolved misses", () => {
  const f = studyResultFixture(
    Array(8).fill(false),
    1800000000000,
    [2, 3, 4, 5, 7, 8, 9, 10],
    false,
  );
  assert.equal(f.state.completionReason, "presentation_budget");
  assert.equal(f.state.presentationCount, 20);
  assert(f.state.items.some((x) => !x.resolved));
  const outcomes = unpackStudyOutcomes(f.bundle.outcomes, 8);
  assert.equal(outcomes.length, 8);
  assert(outcomes.every((x) => x.status === "incorrect"));
  assert.equal(studyFirstPassScore(outcomes).qualifies, false);
});
