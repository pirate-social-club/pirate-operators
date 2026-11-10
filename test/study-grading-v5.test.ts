import test from "node:test";
import assert from "node:assert/strict";
import {
  gradeEnglishTranscriptV4 as v4,
  gradeEnglishTranscriptV5 as v5,
  gradeTranscriptV2,
  STUDY_TRANSCRIPT_GRADER_POLICY_V5,
} from "../packages/study/transcript-grading.ts";
import { assessStudySpokenRerecord } from "../packages/study/spoken-rerecord.ts";
import {
  studyGraderAt,
  validateStudyGraderActivation,
  STUDY_SCORING_POLICY_V5_HASH,
} from "../packages/study/grader-revision.ts";
import { STUDY_SCORING_POLICY_HASH } from "../packages/protocol/learning-results-v3.ts";

test("v5 accepts dropped-g and wanna equivalents without rewriting historical v4", () => {
  for (const [reference, heard] of [
    ["I got nothin'", "I got nothing"],
    ["Nothin’ can stop us", "Nothing can stop us"],
    ["I wanna dance", "I want to dance"],
    ["I'm walkin' home", "I am walking home"],
    ["Runnin' past somethin'", "Running past something"],
  ]) {
    assert.equal(v5(reference, heard).correct, true, reference);
    assert.equal(v5(heard, reference).correct, true, reference);
  }
  assert.equal(v4("I got nothin'", "I got nothing").correct, false);
  assert.equal(v4("I wanna dance", "I want to dance").correct, false);
  for (const [reference, heard] of [
    ["Nothing can stop us", "Something can stop us"],
    ["I wanna dance", "I do not want to dance"],
    ["I want two", "I want three"],
    ["Nothin'", ""],
    ["Within thin walls", "With thing walls"],
  ])
    assert.equal(
      v5(reference, heard).correct,
      false,
      `${reference} / ${heard}`,
    );
  assert.equal(
    gradeTranscriptV2(
      "wanna",
      "want to",
      "fr",
      STUDY_TRANSCRIPT_GRADER_POLICY_V5,
    ).correct,
    false,
  );
});

test("centralized rerecord thresholds protect negations and numbers and retain confident language evidence", () => {
  const assess = (
    reference: string,
    heard: string,
    language = "en",
    confidence = 0.99,
  ) =>
    assessStudySpokenRerecord({
      grade: v5(reference, heard),
      expectedLanguage: "en",
      detectedLanguage: language,
      detectedLanguageConfidence: confidence,
    });
  assert.equal(
    assess(
      "We let them sing the song until dawn",
      "We let them really sing the song until dawn",
    ).candidateReason,
    "single_insertion",
  );
  assert.equal(
    assess("We let them sing the song until dawn", "Unrelated voice")
      .candidateReason,
    "low_voice_overlap",
  );
  assert.equal(
    assess(
      "We let them sing the song until dawn",
      "We let them sing song until dawn",
      "fr",
      0.8,
    ).candidateReason,
    null,
  ); // accepted matches never re-record
  assert.equal(
    assess(
      "We let them sing the song until dawn",
      "We never let them sing the song until dawn",
    ).candidateReason,
    null,
  );
  assert.equal(
    assess(
      "We let them sing the song until dawn",
      "We let two them sing the song until dawn",
    ).candidateReason,
    null,
  );
  assert.equal(
    assess(
      "We let them sing the song until dawn",
      "We let them hear the tune till morning",
      "fr",
      0.8,
    ).candidateReason,
    "language_mismatch",
  );
});

test("activation uses exact period boundary and changes the policy hash prospectively", () => {
  const activation = {
    schema: "pirate.study-grader-activation/1" as const,
    revision: STUDY_TRANSCRIPT_GRADER_POLICY_V5,
    epochStartS: 1793552400,
    periodSeconds: 86400,
    effectivePeriod: 4,
    effectiveAtMs: (1793552400 + 4 * 86400) * 1000,
  };
  assert.equal(
    studyGraderAt(activation.effectiveAtMs - 1, activation),
    "script_aware_token_phonetic_v4",
  );
  assert.equal(
    studyGraderAt(activation.effectiveAtMs, activation),
    STUDY_TRANSCRIPT_GRADER_POLICY_V5,
  );
  assert.equal(
    studyGraderAt(activation.effectiveAtMs),
    "script_aware_token_phonetic_v4",
  );
  assert.throws(
    () =>
      validateStudyGraderActivation({
        ...activation,
        effectiveAtMs: activation.effectiveAtMs + 1,
      }),
    /activation_invalid/,
  );
  assert.notEqual(STUDY_SCORING_POLICY_V5_HASH, STUDY_SCORING_POLICY_HASH);
});
