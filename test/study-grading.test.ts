import test from "node:test";
import assert from "node:assert/strict";
import { gradeTranscriptV2 } from "../packages/study/transcript-grading.ts";
import { STUDY_POLICY } from "../packages/study/contracts.ts";

test("inherited v4 accepts transcription equivalents and preserves meaning-changing failures", () => {
  for (const [reference, heard] of [
    ["It isn’t the same", "It is not the same"],
    ["I can't swim", "I cannot swim"],
    ["newspaper", "news paper"],
    ["Hold me close", "hold me closed"],
  ]) {
    assert.equal(
      gradeTranscriptV2(reference, heard, "en", STUDY_POLICY).correct,
      true,
      `${reference} / ${heard}`,
    );
  }
  for (const [reference, heard] of [
    ["I can love you", "I cannot love you"],
    ["I have 2 hearts", "I have 9 hearts"],
    ["the", ""],
    ["", ""],
    ["i love you", "i hate you"],
    ["Hold me close", "unrelated words"],
  ]) {
    assert.equal(
      gradeTranscriptV2(reference, heard, "en", STUDY_POLICY).correct,
      false,
      `${reference} / ${heard}`,
    );
  }
});
test("English-only phonetics never grades non-English text as English pronunciation", () => {
  assert.equal(
    gradeTranscriptV2("hold me close", "hold me closed", "es", STUDY_POLICY)
      .correct,
    false,
  );
  assert.equal(
    gradeTranscriptV2("你好 世界", "你好世界", "zh", STUDY_POLICY).correct,
    true,
  );
  const grade = gradeTranscriptV2(
    "Hold me close",
    "HOLD ME CLOSE!",
    "en",
    STUDY_POLICY,
  );
  assert.equal(grade.policyRevision, STUDY_POLICY);
  assert.ok(!("pronunciation_score" in grade));
});
