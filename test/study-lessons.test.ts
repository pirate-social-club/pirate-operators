import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { lessonFixture, lessonRecording } from "./study-lesson-fixture.ts";
import { makeStudyLessonService } from "../services/study-lessons.ts";

test("miss returns after unseen lines; reload follows server state and first-pass facts remain immutable", async () => {
  const f = await lessonFixture();
  try {
    let lesson = await f.start();
    const first = await f.answer(lesson, false);
    lesson = first.lesson;
    assert.equal(lesson.current?.line.lineId, f.lines[1].lineId);
    assert.equal(lesson.progress.resolved, 0);
    const restored = makeStudyLessonService(f.lessonOptions);
    assert.equal(
      (await restored.get(f.owner, lesson.lessonId)).current?.line.lineId,
      f.lines[1].lineId,
    );
    for (let i = 1; i < 4; i++) {
      assert.equal(lesson.current?.line.lineId, f.lines[i].lineId);
      lesson = (await f.answer(lesson, true)).lesson;
    }
    assert.equal(lesson.current?.line.lineId, f.lines[0].lineId);
    assert.equal(lesson.current?.presentationNumber, 5);
    assert.equal(lesson.progress.firstPassCorrect, 3);
    lesson = (await f.answer(lesson, true)).lesson;
    assert.equal(lesson.status, "completed");
    assert.equal(lesson.completionReason, "all_resolved");
    assert.deepEqual(lesson.progress, {
      total: 4,
      resolved: 4,
      mastered: 4,
      presentations: 5,
      presentationCap: 12,
      firstPassGraded: 4,
      firstPassCorrect: 3,
    });
    assert.equal(lesson.qualification, "not_evaluated");
    const replay = await Effect.runPromise(
      f.lessons.submit(
        f.owner,
        lesson.lessonId,
        first.attempt.attemptId,
        lessonRecording(),
      ),
    );
    assert.equal(replay.attempt.grade?.correct, false);
    assert.equal(replay.lesson.progress.presentations, 5);
    assert.equal(f.calls(), 5);
  } finally {
    await f.dispose();
  }
});
test("third miss resolves a line without mastering it; the pinned overall cap ends a longer lesson", async () => {
  for (const count of [4, 10]) {
    const f = await lessonFixture(count);
    try {
      let lesson = await f.start();
      const visited: string[] = [];
      while (lesson.status === "active") {
        visited.push(lesson.current!.line.lineId);
        lesson = (await f.answer(lesson, false)).lesson;
      }
      assert.equal(lesson.progress.presentations, Math.min(20, 3 * count));
      assert.equal(lesson.progress.mastered, 0);
      assert.equal(lesson.progress.firstPassCorrect, 0);
      assert.equal(lesson.progress.firstPassGraded, count);
      assert.equal(
        lesson.completionReason,
        count === 4 ? "all_resolved" : "presentation_budget",
      );
      assert.equal(lesson.progress.resolved, count === 4 ? 4 : 0);
      assert.deepEqual(
        visited.slice(0, count),
        f.lines.map((l) => l.lineId),
      );
      assert.deepEqual(
        visited.slice(count, 2 * count),
        f.lines.map((l) => l.lineId),
      );
      assert.equal(lesson.qualification, "not_evaluated");
    } finally {
      await f.dispose();
    }
  }
});
test("parallel opens and repeated uploads advance one presentation and dispatch speech once", async () => {
  const f = await lessonFixture();
  try {
    const starts = await Promise.all(
      Array.from({ length: 4 }, () => f.start("concurrent-start-command")),
    );
    assert.equal(new Set(starts.map((l) => l.lessonId)).size, 1);
    const lesson = starts[0],
      current = lesson.current!;
    const opens = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.lessons.openAttempt(
          f.owner,
          lesson.lessonId,
          current.presentationNumber,
          current.takeNumber,
        ),
      ),
    );
    assert.equal(new Set(opens.map((o) => o.attempt.attemptId)).size, 1);
    const id = opens[0].attempt.attemptId;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        Effect.runPromise(
          f.lessons.submit(f.owner, lesson.lessonId, id, lessonRecording()),
        ),
      ),
    );
    assert.equal(f.calls(), 1);
    assert.equal(
      (await f.lessons.get(f.owner, lesson.lessonId)).progress.presentations,
      1,
    );
    await assert.rejects(
      Effect.runPromise(
        f.lessons.submit(f.owner, lesson.lessonId, id, lessonRecording(2000)),
      ),
      /study_audio_conflict/,
    );
    await assert.rejects(
      f.lessons.openAttempt(f.owner, lesson.lessonId, 1, 1),
      /study_lesson_changed/,
    );
    const other = await f.start();
    await assert.rejects(
      Effect.runPromise(
        f.lessons.submit(f.owner, other.lessonId, id, lessonRecording()),
      ),
      /study_attempt_not_found/,
    );
    await assert.rejects(
      f.lessons.get(
        { ...f.owner, accountId: "other-account" },
        lesson.lessonId,
      ),
      /study_lesson_not_found/,
    );
    assert.equal(f.calls(), 1);
  } finally {
    await f.dispose();
  }
});
test("provider refusal permits an ungraded retake; uncertainty blocks without spending the queue", async () => {
  for (const failure of ["known_failed", "unknown"] as const) {
    const f = await lessonFixture();
    try {
      let lesson = await f.start();
      f.fail(failure);
      const result = await f.answer(lesson, true);
      lesson = result.lesson;
      assert.equal(lesson.progress.presentations, 0);
      assert.equal(lesson.progress.firstPassGraded, 0);
      assert.equal(result.attempt.grade, null);
      assert.equal(lesson.current?.line.lineId, f.lines[0].lineId);
      await Effect.runPromise(
        f.lessons.submit(
          f.owner,
          lesson.lessonId,
          result.attempt.attemptId,
          lessonRecording(),
        ),
      );
      assert.equal(f.calls(), 1);
      if (failure === "known_failed") {
        assert.equal(lesson.current?.takeNumber, 1);
        f.fail(null);
        lesson = (await f.answer(lesson, true)).lesson;
        assert.equal(lesson.progress.firstPassCorrect, 1);
        assert.equal(f.calls(), 2);
      } else {
        assert.equal(lesson.current?.attempt?.state, "uncertain");
        const again = await f.start();
        assert.notEqual(again.lessonId, lesson.lessonId);
        assert.equal(
          (await f.lessons.get(f.owner, lesson.lessonId)).progress
            .presentations,
          0,
        );
      }
    } finally {
      await f.dispose();
    }
  }
});
test("too-short input never dispatches; expired unsubmitted audio can be rerecorded without a grade", async () => {
  const f = await lessonFixture();
  try {
    let lesson = await f.start(),
      current = lesson.current!;
    const opened = await f.lessons.openAttempt(
      f.owner,
      lesson.lessonId,
      current.presentationNumber,
      current.takeNumber,
    );
    await assert.rejects(
      Effect.runPromise(
        f.lessons.submit(
          f.owner,
          lesson.lessonId,
          opened.attempt.attemptId,
          lessonRecording(999),
        ),
      ),
      /study_recording_too_short/,
    );
    assert.equal(f.calls(), 0);
    assert.equal(
      (await f.lessons.get(f.owner, lesson.lessonId)).progress.presentations,
      0,
    );
    f.advanceClock(300001);
    lesson = await f.lessons.get(f.owner, lesson.lessonId);
    assert.equal(lesson.current?.takeNumber, 1);
    assert.equal(lesson.lastAttempt?.state, "unavailable");
    assert.equal(lesson.lastAttempt?.grade, null);
    lesson = (await f.answer(lesson, true)).lesson;
    assert.equal(lesson.progress.presentations, 1);
    assert.equal(f.calls(), 1);
  } finally {
    await f.dispose();
  }
});
test("a lesson admits four to ten immutable distinct lines, never caller-supplied grading text", async () => {
  const f = await lessonFixture(3);
  try {
    await assert.rejects(f.start(), /insufficient_study_lines/);
    assert.equal(f.calls(), 0);
  } finally {
    await f.dispose();
  }
  const valid = await lessonFixture();
  try {
    const lesson = await valid.start();
    valid.attemptOptions.resolveLine = async (selected) => ({
      ...valid.lines.find((l) => l.lineId === selected.lineId)!,
      text: "changed reference",
    });
    await assert.rejects(
      valid.lessons.openAttempt(valid.owner, lesson.lessonId, 1, 1),
      /study_reference_mismatch/,
    );
    assert.equal(valid.calls(), 0);
  } finally {
    await valid.dispose();
  }
});
