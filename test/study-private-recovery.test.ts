import test from "node:test";
import assert from "node:assert/strict";
import { lessonFixture } from "./study-lesson-fixture.ts";
import { makeStudyService } from "../services/study-spoken.ts";
import { makeStudyLessonService } from "../services/study-lessons.ts";
import { privateStudySource } from "../services/study-private-assessment.ts";
import type { AnyStudyLessonOffer } from "../packages/study/operator-contract.ts";

for (const mode of ["abandon", "open_limit"] as const) {
  test(`missing original linked grading source preserves uncertainty and permits ${mode} closure without a transcript fallback`, async () => {
    const f = await lessonFixture();
    try {
      // Model the stored V4 authorization's unbounded consent separately
      // from the unavailable older speech-grading context.
      f.consent(Infinity);
      const lesson = await f.start();
      f.fail("unknown");
      const original = await f.answer(lesson, true);
      assert.equal(original.attempt.state, "uncertain");
      assert.equal(f.calls(), 1);
      let constructions = 0,
        statusReads = 0;
      // Explicit older-binding fixture: the trusted context resolver encounters
      // the real missing-source validator before a status request can be made.
      const legacyOffer = {
        speechChannel: "telegram-linked",
      } as AnyStudyLessonOffer;
      const attempts = makeStudyService({
        ...f.attemptOptions,
        async assessor() {
          constructions++;
          privateStudySource(legacyOffer);
          throw Error("fixture_source_validation_must_refuse");
        },
        transcriber: {
          ...f.attemptOptions.transcriber,
          async recover() {
            statusReads++;
            throw Error("fixture_raw_recovery_forbidden");
          },
        },
      });
      const lessons = makeStudyLessonService({ ...f.lessonOptions, attempts });
      const current = await lessons.get(f.owner, lesson.lessonId);
      assert.equal(current.current?.attempt?.state, "uncertain");
      assert.equal(current.progress.presentations, 0);
      assert.equal(current.progress.firstPassGraded, 0);
      const observed = await attempts.get(f.owner, original.attempt.attemptId);
      assert.equal(observed.state, "uncertain");
      assert.equal(observed.grade, null);
      if (mode === "open_limit") f.advanceClock(30 * 86400000 + 1);
      const closed =
        mode === "abandon"
          ? await lessons.abandon(f.owner, lesson.lessonId)
          : await lessons.get(f.owner, lesson.lessonId);
      assert.notEqual(closed.status, "active");
      assert.equal(
        closed.completionReason,
        mode === "open_limit" ? "open_limit" : "left",
      );
      const terminal = await f.db
        .prepare("SELECT state_json FROM study_lessons WHERE lesson_id=?")
        .bind(lesson.lessonId)
        .first<{ state_json: string }>();
      assert.equal(
        JSON.parse(terminal!.state_json).terminalAbsences[0],
        "unmeasured",
      );
      assert.equal(closed.progress.firstPassGraded, 0);
      assert.equal(
        (await attempts.get(f.owner, original.attempt.attemptId)).grade,
        null,
      );
      assert.equal(f.calls(), 1);
      assert.equal(statusReads, 0);
      assert.ok(constructions >= 2);
      const row = await f.db
        .prepare("SELECT grade_json FROM study_attempts WHERE attempt_id=?")
        .bind(original.attempt.attemptId)
        .first<{ grade_json: string | null }>();
      assert.equal(row?.grade_json, null);
    } finally {
      await f.dispose();
    }
  });
}
