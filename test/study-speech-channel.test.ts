import test from "node:test";
import assert from "node:assert/strict";
import {
  validateStudyOffer,
  type StudyLessonOfferV4,
} from "../packages/study/operator-contract.ts";
import { STUDY_LESSON_NO_DEADLINE } from "../packages/study/lesson.ts";

test("connected Telegram channel is frozen by the issuer; trial cannot enter a public Study binding", () => {
  const offer: StudyLessonOfferV4 = {
    lessonId: "channel-lesson-fixture",
    learner: `0x${"1".repeat(40)}`,
    sourceDigest: `0x${"2".repeat(64)}`,
    authorizationId: `0x${"3".repeat(64)}`,
    startedAt: 1800000000000,
    expiresAt: STUDY_LESSON_NO_DEADLINE,
    exercises: [1, 2, 3, 4].map((ordinal) => ({
      ordinal,
      lineId: `0x${String(ordinal).repeat(64)}` as `0x${string}`,
      language: "en",
    })),
  };
  assert.equal(
    validateStudyOffer(
      { ...offer, speechChannel: "telegram-linked" },
      1800000000,
      4,
    ),
    validateStudyOffer(offer, 1800000000, 4),
  );
  assert.throws(
    () =>
      validateStudyOffer(
        { ...offer, speechChannel: "telegram-trial" as never },
        1800000000,
        4,
      ),
    /invalid_study_speech_channel/,
  );
});
