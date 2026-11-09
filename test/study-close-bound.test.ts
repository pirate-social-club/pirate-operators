// Lesson-level close rules after the learner time limit was removed. Legacy
// one-hour lessons keep their deadline; new lessons close only by leaving, by
// finishing, or at their close bound (bound consent end, or 30 days unbound).
import test from "node:test";
import assert from "node:assert/strict";
import { lessonFixture } from "./study-lesson-fixture.ts";
import { closeBoundOf, lessonState } from "./study-close-bound-fixture.ts";
import {
  STUDY_LESSON_LIFETIME_MS,
  STUDY_LESSON_NO_DEADLINE,
  STUDY_OPEN_LESSON_MAX_MS,
} from "../packages/study/lesson.ts";

const DAY = 86400000;

test("a legacy lesson read after its deadline expires at exactly its deadline; leaving late records expiry", async () => {
  const f = await lessonFixture();
  try {
    const read = await f.startLegacy(),
      left = await f.startLegacy();
    assert.equal(read.expiresAt, read.startedAt + STUDY_LESSON_LIFETIME_MS);
    f.advanceClock(STUDY_LESSON_LIFETIME_MS - 1);
    assert.equal(
      (await f.lessons.get(f.owner, read.lessonId)).status,
      "active",
    );
    f.advanceClock(7 * DAY);
    const expired = await f.lessons.get(f.owner, read.lessonId);
    assert.equal(expired.status, "expired");
    assert.equal(expired.completionReason, "deadline");
    assert.equal(expired.completedAt, read.expiresAt);
    // Leaving after the deadline records the deadline, not the leave time.
    const abandoned = await f.lessons.abandon(f.owner, left.lessonId);
    assert.equal(abandoned.status, "expired");
    assert.equal(abandoned.completionReason, "deadline");
    assert.equal(abandoned.completedAt, left.expiresAt);
    assert.equal(f.calls(), 0);
  } finally {
    await f.dispose();
  }
});

test("a new lesson days later resumes with its grades, and leaving records the leave time", async () => {
  const f = await lessonFixture();
  try {
    f.consent(Math.floor(f.clock() / 1000) + 30 * 86400);
    let lesson = await f.start();
    assert.equal(lesson.expiresAt, STUDY_LESSON_NO_DEADLINE);
    lesson = (await f.answer(lesson, true)).lesson;
    lesson = (await f.answer(lesson, false)).lesson;
    f.advanceClock(5 * DAY);
    const resumed = await f.lessons.get(f.owner, lesson.lessonId);
    assert.equal(resumed.status, "active");
    assert.equal(resumed.completedAt, null);
    assert.equal(resumed.progress.firstPassGraded, 2);
    assert.equal(resumed.progress.firstPassCorrect, 1);
    assert.deepEqual(resumed.current, lesson.current);
    f.advanceClock(1234);
    const leftAt = f.clock();
    const left = await f.lessons.abandon(f.owner, lesson.lessonId);
    assert.equal(left.status, "abandoned");
    assert.equal(left.completionReason, "left");
    assert.equal(left.completedAt, leftAt);
    assert.equal(f.calls(), 2);
  } finally {
    await f.dispose();
  }
});

test("a new lesson closes at its bound consent's last millisecond, never before, without speech", async () => {
  const f = await lessonFixture();
  try {
    const consentEnd = Math.floor(f.clock() / 1000) + 10 * 86400;
    f.consent(consentEnd);
    let lesson = await f.start();
    lesson = (await f.answer(lesson, false)).lesson;
    const at = consentEnd * 1000 - 1;
    f.advanceClock(at - 1 - f.clock());
    assert.equal(
      (await f.lessons.get(f.owner, lesson.lessonId)).status,
      "active",
    );
    f.advanceClock(1 + 3 * DAY);
    const closed = await f.lessons.get(f.owner, lesson.lessonId);
    assert.equal(closed.status, "abandoned");
    assert.equal(closed.completionReason, "consent_ended");
    assert.equal(closed.completedAt, at);
    assert.equal(closed.progress.firstPassGraded, 1);
    assert.deepEqual(
      (await lessonState(f.db, lesson.lessonId)).terminalAbsences,
      [null, "unattempted", "unattempted", "unattempted"],
    );
    assert.equal(f.calls(), 1);
  } finally {
    await f.dispose();
  }
});

test("a grade whose provider response completes after the bound stays unmeasured", async () => {
  const f = await lessonFixture();
  try {
    const consentEnd = Math.floor(f.clock() / 1000) + 2 * 86400;
    f.consent(consentEnd);
    const lesson = await f.start();
    f.attemptOptions.transcriber.transcribe = async () => {
      f.advanceClock(consentEnd * 1000 - f.clock());
      return { text: f.lines[0].text, language: "en" };
    };
    const response = await f.answer(lesson, true);
    assert.equal(response.lesson.status, "abandoned");
    assert.equal(response.lesson.completionReason, "consent_ended");
    assert.equal(response.lesson.completedAt, consentEnd * 1000 - 1);
    assert.equal(response.lesson.progress.firstPassGraded, 0);
    assert.equal(
      (await lessonState(f.db, lesson.lessonId)).terminalAbsences?.[0],
      "unmeasured",
    );
    // The saved attempt keeps its evidence; it is not a first-pass grade.
    const attempt = await f.attempts.get(f.owner, response.attempt.attemptId);
    assert.equal(attempt.state, "assessed");
  } finally {
    await f.dispose();
  }
});

test("leaving just after the bound records the bound and consent end, never a later time", async () => {
  const f = await lessonFixture();
  try {
    const consentEnd = Math.floor(f.clock() / 1000) + 86400;
    f.consent(consentEnd);
    const lesson = await f.start();
    f.advanceClock(consentEnd * 1000 - f.clock() + 1);
    const left = await f.lessons.abandon(f.owner, lesson.lessonId);
    assert.equal(left.status, "abandoned");
    assert.equal(left.completionReason, "consent_ended");
    assert.equal(left.completedAt, consentEnd * 1000 - 1);
  } finally {
    await f.dispose();
  }
});

test("a draft never bound to consent closes thirty days after it started, not before", async () => {
  const f = await lessonFixture();
  try {
    const lesson = await f.start();
    const bound = await closeBoundOf(f.db, lesson.lessonId);
    assert.equal(bound.reason, "never_bound");
    assert.equal(bound.at, lesson.startedAt + STUDY_OPEN_LESSON_MAX_MS);
    f.advanceClock(bound.at - 1 - f.clock());
    assert.equal(
      (await f.lessons.get(f.owner, lesson.lessonId)).status,
      "active",
    );
    f.advanceClock(1);
    const closed = await f.lessons.get(f.owner, lesson.lessonId);
    assert.equal(closed.status, "abandoned");
    assert.equal(closed.completionReason, "never_bound");
    assert.equal(closed.completedAt, bound.at);
    assert.equal(f.calls(), 0);
  } finally {
    await f.dispose();
  }
});

test("a consent end beyond thirty days, even past 2^53 seconds, cannot keep a new lesson open past thirty days", async () => {
  for (const consentEnd of [
    Math.floor(Date.now() / 1000) + 3650 * 86400,
    2 ** 60,
  ]) {
    const f = await lessonFixture();
    try {
      f.consent(consentEnd);
      let lesson = await f.start();
      lesson = (await f.answer(lesson, false)).lesson;
      const at = lesson.startedAt + STUDY_OPEN_LESSON_MAX_MS;
      f.advanceClock(at - 1 - f.clock());
      assert.equal(
        (await f.lessons.get(f.owner, lesson.lessonId)).status,
        "active",
      );
      f.advanceClock(1);
      const closed = await f.lessons.get(f.owner, lesson.lessonId);
      assert.equal(closed.status, "abandoned");
      assert.equal(closed.completionReason, "open_limit");
      assert.equal(closed.completedAt, at);
      assert.equal(closed.progress.firstPassGraded, 1);
    } finally {
      await f.dispose();
    }
  }
});
