import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { lessonFixture, lessonRecording } from "./study-lesson-fixture.ts";

test("a disk restart reconciles a saved grade exactly once without repeating the provider call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-lesson-restart-"));
  let f = await lessonFixture(4, dir);
  try {
    const lesson = await f.start(),
      current = lesson.current!;
    const opened = await f.lessons.openAttempt(
      f.owner,
      lesson.lessonId,
      current.presentationNumber,
      current.takeNumber,
    );
    await Effect.runPromise(
      f.attempts.submit(f.owner, opened.attempt.attemptId, lessonRecording()),
    );
    const saved = await f.db
      .prepare("SELECT state_json FROM study_lessons WHERE lesson_id=?")
      .bind(lesson.lessonId)
      .first<{ state_json: string }>();
    assert.equal(JSON.parse(saved!.state_json).presentationCount, 0);
    await f.dispose();
    f = await lessonFixture(4, dir, false);
    const states = await Promise.all(
      Array.from({ length: 4 }, () => f.lessons.get(f.owner, lesson.lessonId)),
    );
    assert.ok(
      states.every(
        (l) =>
          l.progress.presentations === 1 &&
          l.current?.line.lineId === f.lines[1].lineId,
      ),
    );
    assert.equal(f.calls(), 0);
    const result = await Effect.runPromise(
      f.lessons.submit(
        f.owner,
        lesson.lessonId,
        opened.attempt.attemptId,
        lessonRecording(),
      ),
    );
    assert.equal(result.attempt.grade?.correct, true);
    assert.equal(result.lesson.progress.presentations, 1);
    assert.equal(f.calls(), 0);
  } finally {
    await f.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("uncertain dispatch survives a disk restart and cannot advance or trigger another provider request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-lesson-unknown-"));
  let f = await lessonFixture(4, dir);
  try {
    const lesson = await f.start();
    f.fail("unknown");
    const result = await f.answer(lesson, true);
    assert.equal(f.calls(), 1);
    await f.dispose();
    f = await lessonFixture(4, dir, false);
    const reloaded = await f.lessons.get(f.owner, lesson.lessonId);
    assert.equal(reloaded.current?.attempt?.state, "uncertain");
    assert.equal(reloaded.progress.presentations, 0);
    const replay = await Effect.runPromise(
      f.lessons.submit(
        f.owner,
        lesson.lessonId,
        result.attempt.attemptId,
        lessonRecording(),
      ),
    );
    assert.equal(replay.attempt.grade, null);
    assert.equal(replay.lesson.current?.line.lineId, f.lines[0].lineId);
    assert.equal(f.calls(), 0);
  } finally {
    await f.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
