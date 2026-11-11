import test from "node:test";
import assert from "node:assert/strict";
import {
  gradeEnglishTranscriptV5 as grade,
  gradeTranscriptV2,
  studyTranscriptReviewGrade,
  STUDY_TRANSCRIPT_GRADER_POLICY_V5,
} from "../packages/study/transcript-grading.ts";
import { assessStudySpokenRerecord } from "../packages/study/spoken-rerecord.ts";

const assessment = (reference: string, heard: string) => {
  const result = grade(reference, heard);
  return {
    grade: result,
    rerecord: assessStudySpokenRerecord({
      grade: result,
      expectedLanguage: "en",
      detectedLanguage: "en",
      detectedLanguageConfidence: 0.99,
    }),
  };
};

test("short dropped-g participles are exact equivalents in both directions and never request a rerecord", () => {
  for (const [spoken, canonical, rest] of [
    ["goin", "going", "home"],
    ["doin", "doing", "fine"],
    ["bein", "being", "kind"],
    ["lyin", "lying", "low"],
    ["dyin", "dying", "slowly"],
    ["tyin", "tying", "knots"],
    ["vyin", "vying", "for attention"],
    ["usin", "using", "words"],
    ["owin", "owing", "nothing"],
  ]) {
    for (const spelling of [
      spoken,
      `${spoken}'`,
      `${spoken}’`,
      `${spoken.toUpperCase()}‘`,
    ]) {
      for (const [reference, heard] of [
        [`I'm ${spelling} ${rest}`, `I am ${canonical} ${rest}`],
        [`I am ${canonical} ${rest}`, `I'm ${spelling} ${rest}`],
        [spelling, canonical],
        [canonical, spelling],
      ]) {
        const result = assessment(reference, heard);
        assert.equal(result.grade.correct, true, `${reference} / ${heard}`);
        assert.equal(result.grade.matchKind, "exact");
        assert.deepEqual(result.grade.missing, []);
        assert.deepEqual(result.grade.substituted, []);
        assert.equal(result.rerecord.candidateReason, null);
        assert.equal(
          studyTranscriptReviewGrade(result.grade.matchKind, 1),
          "good",
        );
      }
    }
  }
});

test("ordinary short words stay their own tokens rather than becoming dropped-g participles", () => {
  for (const word of [
    "thin",
    "skin",
    "spin",
    "coin",
    "join",
    "grin",
    "rain",
    "pain",
    "gain",
    "main",
    "vein",
    "ruin",
    "bin",
    "kin",
    "sin",
    "win",
  ]) {
    for (const spelling of [word, `${word}'`, `${word}’`]) {
      const result = grade(spelling, spelling);
      assert.equal(result.matchKind, "exact", spelling);
      assert.deepEqual(
        result.matched,
        [{ token: word, position: 0 }],
        spelling,
      );
    }
  }
  for (const word of ["within", "begin", "origin", "goinville"]) {
    assert.deepEqual(grade(word, word).matched, [{ token: word, position: 0 }]);
  }
  assert.equal(
    gradeTranscriptV2("goin'", "going", "fr", STUDY_TRANSCRIPT_GRADER_POLICY_V5)
      .correct,
    false,
  );
});

test("short-stem normalization preserves meaningful omission, negation and numeric refusal", () => {
  for (const [reference, heard] of [
    ["I'm goin' home", "I am home"],
    ["I'm goin' home", "I am going"],
    ["I am bein' kind", "I am being"],
    ["We are not goin' home", "We are going home"],
    ["I am goin' 2 miles", "I am going 3 miles"],
    ["We wanna go home", "We want to home"],
  ]) {
    const result = assessment(reference, heard);
    assert.equal(result.grade.correct, false, `${reference} / ${heard}`);
    assert.equal(
      result.rerecord.candidateReason,
      null,
      `${reference} / ${heard}`,
    );
  }
  assert.ok(
    grade("I'm goin' home", "I am home").missing.some(
      (item) => item.token === "going",
    ),
  );
});

test("re-record assessment still distinguishes low overlap and harmless insertion from accepted short forms", () => {
  const empty = assessment("goin'", "");
  assert.equal(empty.grade.correct, false);
  assert.equal(empty.rerecord.candidateReason, "low_voice_overlap");
  const insertion = assessment(
    "I am goin' home until dawn",
    "I am going really home until dawn",
  );
  assert.equal(insertion.grade.correct, false);
  assert.equal(insertion.rerecord.candidateReason, "single_insertion");
  const accepted = assessment("I'm goin' home", "I am going home");
  assert.equal(accepted.grade.correct, true);
  assert.equal(accepted.rerecord.candidateReason, null);
});
