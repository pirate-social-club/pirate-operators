import { test } from "node:test";
import assert from "node:assert/strict";
import { zeroHash } from "viem";
import {
  completedStudyBundle,
  terminalStudyBundle,
  terminalStudyFacts,
} from "../packages/study/result-adapter.ts";
import { studyFactsBundle } from "../packages/study/terminal-facts.ts";
import {
  closeStudyLesson,
  newLesson,
  studyCloseBound,
  STUDY_LESSON_LIFETIME_MS,
} from "../packages/study/lesson.ts";
import { studySourceSelection } from "../packages/study/public-source.ts";
import {
  packStudyOutcomes,
  studyExercisesHash,
  studyFirstPassScore,
  unpackStudyOutcomes,
} from "../packages/protocol/learning-results-v3.ts";
import { studyResultFixture } from "./study-result-fixture.ts";

test("public Study recovery facts reject private fields and completed absence", () => {
  const { input } = studyResultFixture();
  const { state: _privateQueue, ...publicBinding } = input;
  const terminal = terminalStudyFacts(input);
  const request = { ...publicBinding, terminal };
  assert.equal(
    studyFactsBundle(request).outcomes,
    "0x000702000201000a01000401",
  );
  assert.throws(
    () =>
      studyFactsBundle({
        ...request,
        terminal: {
          ...terminal,
          heardTranscript: "private",
        } as typeof terminal,
      }),
    /invalid_study_terminal_facts/,
  );
  assert.throws(
    () =>
      studyFactsBundle({
        ...request,
        terminal: { ...terminal, outcomes: "0x000704000201000a01000401" },
      }),
    /invalid_study_first_pass/,
  );
});

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

test("abandoned and expired bundles preserve the full frozen selection and absence reasons", () => {
  const f = studyResultFixture(),
    state = newLesson(
      f.state.song,
      f.state.items.map((x) => x.line),
      f.state.startedAt,
    );
  // One saved first-pass miss, followed by an ungraded provider dispatch.
  state.items[0] = {
    ...f.state.items[0],
    presentations: 1,
    mastered: false,
    resolved: false,
    lastQueueOrdinal: 0,
  };
  state.presentationCount = 1;
  state.currentIndex = 1;
  // A new lesson closes as abandoned when the learner leaves or at its bound
  // consent's last millisecond. Only a legacy one-hour lesson can expire.
  const submitted = new Set([
    state.items[0].line.lineId,
    state.items[1].line.lineId,
  ]);
  const legacy = {
    ...state,
    expiresAt: state.startedAt + STUDY_LESSON_LIFETIME_MS,
  };
  const bound = studyCloseBound(state, f.input.enrollment.expiresAt);
  assert.equal(bound.at, f.input.enrollment.expiresAt * 1000 - 1);
  assert.equal(bound.reason, "consent_ended");
  const cases = [
    [
      "abandoned",
      closeStudyLesson(state, "abandoned", state.startedAt + 5000, submitted),
    ],
    [
      "abandoned",
      closeStudyLesson(
        state,
        "abandoned",
        bound.at,
        submitted,
        "consent_ended",
      ),
    ],
    [
      "expired",
      closeStudyLesson(legacy, "expired", legacy.expiresAt, submitted),
    ],
  ] as const;
  assert.equal(cases[1][1].completionReason, "consent_ended");
  assert.equal(cases[2][1].completionReason, "deadline");
  // A new lesson cannot expire, and a legacy lesson cannot claim consent end.
  assert.throws(
    () => closeStudyLesson(state, "expired", state.expiresAt, submitted),
    /invalid_study_close_time/,
  );
  assert.throws(
    () =>
      closeStudyLesson(
        legacy,
        "abandoned",
        legacy.startedAt + 5000,
        submitted,
        "consent_ended",
      ),
    /invalid_study_close_time/,
  );
  for (const [status, closed] of cases) {
    const input = { ...f.input, state: closed },
      bundle = terminalStudyBundle(input);
    assert.equal(bundle.result.status, status === "abandoned" ? 2 : 3);
    assert.equal(bundle.result.exercisesHash, f.bundle.result.exercisesHash);
    assert.equal(
      bundle.result.contentRevision,
      f.bundle.result.contentRevision,
    );
    assert.deepEqual(unpackStudyOutcomes(bundle.outcomes, 4), [
      { sourceOrdinal: 7, status: "incorrect" },
      { sourceOrdinal: 2, status: "unmeasured" },
      { sourceOrdinal: 10, status: "unattempted" },
      { sourceOrdinal: 4, status: "unattempted" },
    ]);
    assert.equal(
      studyFirstPassScore(unpackStudyOutcomes(bundle.outcomes, 4)).qualifies,
      false,
    );
    const changed = structuredClone(input);
    changed.state.terminalAbsences![0] = "unattempted";
    assert.throws(
      () => terminalStudyBundle(changed),
      /invalid_study_first_pass/,
    );
    changed.state.terminalAbsences = null;
    assert.throws(() => terminalStudyBundle(changed), /study_not_terminal/);
    assert.throws(() => completedStudyBundle(input), /study_not_completed/);
  }
  assert.throws(
    () => terminalStudyBundle({ ...f.input, state }),
    /study_not_terminal/,
  );
});
