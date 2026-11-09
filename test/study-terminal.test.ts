import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { sha256 } from "viem";
import { lessonFixture, lessonRecording } from "./study-lesson-fixture.ts";
import { StudyLessonStore } from "../packages/study/lesson-store.ts";
import { StudyAttemptStore } from "../packages/study/attempt-store.ts";
import {
  closeStudyLesson,
  STUDY_LESSON_LIFETIME_MS,
} from "../packages/study/lesson.ts";
import { selectionOf } from "../packages/study/contracts.ts";
import { gradeTranscriptV2 } from "../packages/study/transcript-grading.ts";

test("abandonment freezes first passes and submitted absence once, with owner isolation", async () => {
  const f = await lessonFixture();
  try {
    let lesson = await f.start();
    lesson = (await f.answer(lesson, false)).lesson;
    f.fail("known_failed");
    lesson = (await f.answer(lesson, true)).lesson;
    f.advanceClock(5000);
    const closed = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.lessons.abandon(f.owner, lesson.lessonId),
      ),
    );
    assert(closed.every((l) => l.status === "abandoned" && l.current === null));
    assert.equal(new Set(closed.map((l) => l.completedAt)).size, 1);
    const store = new StudyLessonStore(f.db),
      row = await store.row(f.owner, lesson.lessonId);
    const state = store.state(row);
    assert.equal(state.items[0].firstPassOutcome, "incorrect");
    assert.deepEqual(state.terminalAbsences, [
      null,
      "unmeasured",
      "unattempted",
      "unattempted",
    ]);
    f.advanceClock(10000);
    await f.lessons.abandon(f.owner, lesson.lessonId);
    assert.deepEqual(await store.row(f.owner, lesson.lessonId), row);
    await assert.rejects(
      f.lessons.openAttempt(f.owner, lesson.lessonId, 2, 2),
      /study_lesson_changed/,
    );
    await assert.rejects(
      f.lessons.abandon(
        { ...f.owner, accountId: "other-account" },
        lesson.lessonId,
      ),
      /study_lesson_not_found/,
    );
    assert.equal(f.calls(), 2);
  } finally {
    await f.dispose();
  }
});

test("closed ready takes and unlinked takes cannot start a provider call", async () => {
  const f = await lessonFixture();
  try {
    const lesson = await f.start();
    const orphan = await f.attempts.open(
      f.owner,
      "unlinked-attempt-request",
      selectionOf(f.lines[0]),
      { lessonId: lesson.lessonId, presentationNumber: 1, takeNumber: 1 },
    );
    await assert.rejects(
      Effect.runPromise(
        f.attempts.submit(f.owner, orphan.attemptId, lessonRecording()),
      ),
    );
    const opened = await f.lessons.openAttempt(f.owner, lesson.lessonId, 1, 1);
    await f.lessons.abandon(f.owner, lesson.lessonId);
    const result = await Effect.runPromise(
      f.lessons.submit(
        f.owner,
        lesson.lessonId,
        opened.attempt.attemptId,
        lessonRecording(),
      ),
    );
    assert.equal(result.attempt.grade, null);
    assert.equal(result.attempt.state, "unavailable");
    const store = new StudyLessonStore(f.db);
    assert.deepEqual(
      store.state(await store.row(f.owner, lesson.lessonId)).terminalAbsences,
      Array(4).fill("unattempted"),
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.dispose();
  }
});

test("a late provider response cannot rewrite a durably abandoned lesson after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-terminal-restart-"));
  let f = await lessonFixture(4, dir);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let pending: Promise<unknown> | undefined;
  try {
    const lesson = await f.start();
    const opened = await f.lessons.openAttempt(f.owner, lesson.lessonId, 1, 1);
    let calls = 0;
    f.attemptOptions.transcriber.transcribe = async () => {
      calls++;
      entered.resolve();
      await release.promise;
      return { text: f.lines[0].text, language: "en" };
    };
    pending = Effect.runPromise(
      f.lessons.submit(
        f.owner,
        lesson.lessonId,
        opened.attempt.attemptId,
        lessonRecording(),
      ),
    );
    await entered.promise;
    const closed = await f.lessons.abandon(f.owner, lesson.lessonId);
    assert.equal(closed.status, "abandoned");
    release.resolve();
    await pending;
    const store = new StudyLessonStore(f.db),
      row = await store.row(f.owner, lesson.lessonId);
    assert.deepEqual(store.state(row).terminalAbsences, [
      "unmeasured",
      "unattempted",
      "unattempted",
      "unattempted",
    ]);
    const attempt = await f.attempts.get(f.owner, opened.attempt.attemptId);
    assert.equal(attempt.state, "uncertain");
    assert.equal(attempt.grade, null);
    assert.equal(calls, 1);
    await f.dispose();
    f = await lessonFixture(4, dir, false);
    assert.deepEqual(await f.lessons.get(f.owner, lesson.lessonId), closed);
    await Effect.runPromise(
      f.lessons.submit(
        f.owner,
        lesson.lessonId,
        opened.attempt.attemptId,
        lessonRecording(),
      ),
    );
    assert.equal(f.calls(), 0);
    assert.deepEqual(
      await new StudyLessonStore(f.db).row(f.owner, lesson.lessonId),
      row,
    );
  } finally {
    release.resolve();
    await pending?.catch(() => {});
    await f.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy expiry keeps a previously saved grade and uses the fixed deadline, not delayed recovery time", async () => {
  const f = await lessonFixture();
  try {
    const lesson = await f.startLegacy(),
      second = await f.startLegacy();
    assert.equal(lesson.expiresAt, lesson.startedAt + STUDY_LESSON_LIFETIME_MS);
    const opened = await f.lessons.openAttempt(f.owner, lesson.lessonId, 1, 1);
    await Effect.runPromise(
      f.attempts.submit(f.owner, opened.attempt.attemptId, lessonRecording()),
    );
    f.advanceClock(STUDY_LESSON_LIFETIME_MS + 86400000);
    assert.equal(await f.lessons.expirePending(1), 1);
    assert.equal(await f.lessons.expirePending(1), 1);
    assert.equal(await f.lessons.expirePending(), 0);
    const expired = await f.lessons.get(f.owner, lesson.lessonId);
    assert.equal(expired.status, "expired");
    assert.equal(expired.completedAt, lesson.expiresAt);
    assert.equal(expired.progress.firstPassCorrect, 1);
    const store = new StudyLessonStore(f.db);
    assert.deepEqual(
      store.state(await store.row(f.owner, lesson.lessonId)).terminalAbsences,
      [null, "unattempted", "unattempted", "unattempted"],
    );
    assert.equal(
      (await f.lessons.abandon(f.owner, second.lessonId)).status,
      "expired",
    );
    assert.equal(f.calls(), 1);
  } finally {
    await f.dispose();
  }
});

test("a legacy response received after the deadline is unmeasured, never a new first-pass grade", async () => {
  const f = await lessonFixture();
  try {
    const lesson = await f.startLegacy();
    f.attemptOptions.transcriber.transcribe = async () => {
      f.advanceClock(STUDY_LESSON_LIFETIME_MS);
      return { text: f.lines[0].text, language: "en" };
    };
    const response = await f.answer(lesson, true);
    assert.equal(response.lesson.status, "expired");
    assert.equal(response.lesson.progress.firstPassGraded, 0);
    const store = new StudyLessonStore(f.db);
    assert.equal(
      store.state(await store.row(f.owner, lesson.lessonId))
        .terminalAbsences?.[0],
      "unmeasured",
    );
    assert.equal(
      (await f.attempts.get(f.owner, response.attempt.attemptId)).grade,
      null,
    );
  } finally {
    await f.dispose();
  }
});

test("closure retries when a provider claim or saved grade wins its database comparison", async () => {
  const f = await lessonFixture();
  try {
    const lesson = await f.start(),
      opened = await f.lessons.openAttempt(f.owner, lesson.lessonId, 1, 1);
    const store = new StudyLessonStore(f.db),
      attempts = new StudyAttemptStore(f.db);
    const row = await store.row(f.owner, lesson.lessonId),
      state = store.state(row);
    const audio = new Uint8Array(await lessonRecording().arrayBuffer());
    await attempts.claim(
      f.owner,
      opened.attempt.attemptId,
      sha256(audio),
      state.startedAt,
      1000,
    );
    assert.equal(
      await store.close(
        f.owner,
        row,
        closeStudyLesson(state, "abandoned", state.startedAt, new Set()),
        opened.attempt,
      ),
      false,
    );
    const assessing = await f.attempts.get(f.owner, opened.attempt.attemptId);
    await attempts.finish(
      f.owner,
      opened.attempt.attemptId,
      "assessed",
      gradeTranscriptV2(
        f.lines[0].text,
        f.lines[0].text,
        "en",
        "script_aware_token_phonetic_v4",
      ),
      null,
      state.startedAt,
    );
    assert.equal(
      await store.close(
        f.owner,
        row,
        closeStudyLesson(
          state,
          "abandoned",
          state.startedAt,
          new Set([f.lines[0].lineId]),
        ),
        assessing,
      ),
      false,
    );
    const closed = await f.lessons.abandon(f.owner, lesson.lessonId);
    assert.equal(closed.progress.firstPassCorrect, 1);
    assert.equal(
      store.state(await store.row(f.owner, lesson.lessonId))
        .terminalAbsences?.[0],
      null,
    );
  } finally {
    await f.dispose();
  }
});

test("known failures have three takes per presentation and never invent a wrong answer", async () => {
  const f = await lessonFixture();
  try {
    let lesson = await f.start();
    f.fail("known_failed");
    for (let take = 1; take <= 3; take++)
      lesson = (await f.answer(lesson, true)).lesson;
    assert.equal(lesson.current?.takeNumber, 4);
    await assert.rejects(
      f.lessons.openAttempt(f.owner, lesson.lessonId, 1, 4),
      /study_retry_limit/,
    );
    assert.equal(lesson.progress.firstPassGraded, 0);
    assert.equal(f.calls(), 3);
    await f.lessons.abandon(f.owner, lesson.lessonId);
    const store = new StudyLessonStore(f.db);
    assert.equal(
      store.state(await store.row(f.owner, lesson.lessonId))
        .terminalAbsences?.[0],
      "unmeasured",
    );
  } finally {
    await f.dispose();
  }
});
