import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { lessonFixture, lessonRecording } from "./study-lesson-fixture.ts";
import { makeStudyLessonService } from "../services/study-lessons.ts";
import { makeStudyService } from "../services/study-spoken.ts";
import { withSafeStudySpeechRetries } from "../packages/study/speech-retries.ts";
import { StudySpeechError } from "../packages/study/speech-transcriber.ts";
import type { StudyLesson } from "../packages/study/lesson.ts";

test("safe speech retries are bounded and never repeat an uncertain dispatch", async () => {
  for (const [code, outcome, expected] of [
    ["speech_rate_limited", "known_failed", 3],
    ["speech_timeout", "unknown", 1],
    ["speech_unavailable", "known_failed", 1],
  ] as const) {
    let calls = 0;
    const waits: number[] = [];
    const provider = withSafeStudySpeechRetries(
      {
        providerRetention: "stored",
        async transcribe() {
          calls++;
          throw new StudySpeechError(code, outcome);
        },
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    await assert.rejects(
      provider.transcribe(new Uint8Array(), "audio/webm", "en"),
      new RegExp(code),
    );
    assert.equal(calls, expected);
    assert.deepEqual(waits, expected === 3 ? [250, 500] : []);
  }
});

test("repeated provider refusals preserve the same take and first-pass facts, with a bounded cooldown", async () => {
  const f = await lessonFixture();
  try {
    let lesson = await f.start();
    f.fail("known_failed");
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const result = await f.answer(lesson, true);
      ids.add(result.attempt.attemptId);
      lesson = result.lesson;
      assert.equal(lesson.current?.takeNumber, 1);
      assert.equal(lesson.progress.firstPassGraded, 0);
      assert.equal(lesson.progress.presentations, 0);
    }
    assert.equal(ids.size, 3);
    await assert.rejects(
      f.lessons.openAttempt(f.owner, lesson.lessonId, 1, 1),
      /study_speech_retry_later/,
    );
    assert.equal(f.calls(), 3);
    f.advanceClock(60000);
    f.fail(null);
    lesson = (await f.answer(lesson, true)).lesson;
    assert.equal(lesson.progress.firstPassCorrect, 1);
    assert.equal(lesson.progress.presentations, 1);
  } finally {
    await f.dispose();
  }
});

test("v5 grants exactly one uncounted rerecord and freezes open v4 lessons across activation", async () => {
  const f = await lessonFixture();
  try {
    const historical = await f.start();
    const activation = {
      schema: "pirate.study-grader-activation/1" as const,
      revision: "script_aware_token_phonetic_v5" as const,
      epochStartS: f.clock() / 1000,
      periodSeconds: 1,
      effectivePeriod: 1,
      effectiveAtMs: f.clock() + 1000,
    };
    const lessons = makeStudyLessonService({
      ...f.lessonOptions,
      graderActivation: activation,
    });
    f.advanceClock(1000);
    let lesson = await lessons.start(
      f.owner,
      "new-grader-lesson-request",
      f.song,
    );
    assert.equal(lesson.graderRevision, "script_aware_token_phonetic_v5");
    assert.equal(
      (await lessons.get(f.owner, historical.lessonId)).graderRevision,
      "script_aware_token_phonetic_v4",
    );
    const answer = async (current: StudyLesson) => {
      f.heard("unrelated voice");
      const { attempt } = await lessons.openAttempt(
        f.owner,
        current.lessonId,
        current.current!.presentationNumber,
        current.current!.takeNumber,
      );
      return Effect.runPromise(
        lessons.submit(
          f.owner,
          current.lessonId,
          attempt.attemptId,
          lessonRecording(),
        ),
      );
    };
    const first = await answer(lesson);
    lesson = first.lesson;
    assert.equal(first.attempt.grade?.rerecordReason, "low_voice_overlap");
    assert.equal(lesson.progress.firstPassGraded, 0);
    assert.equal(lesson.progress.presentations, 0);
    assert.equal(lesson.current?.takeNumber, 2);
    const replay = await Effect.runPromise(
      lessons.submit(
        f.owner,
        lesson.lessonId,
        first.attempt.attemptId,
        lessonRecording(),
      ),
    );
    assert.equal(replay.lesson.progress.presentations, 0);
    lesson = (await answer(lesson)).lesson;
    assert.equal(lesson.progress.firstPassGraded, 1);
    assert.equal(lesson.progress.firstPassCorrect, 0);
    assert.equal(lesson.progress.presentations, 1);
    assert.equal(f.calls(), 2);
    const frozen = await answer(
      await lessons.get(f.owner, historical.lessonId),
    );
    assert.equal(frozen.attempt.grade?.rerecordReason, undefined);
    assert.equal(frozen.lesson.progress.presentations, 1);
  } finally {
    await f.dispose();
  }
});

test("uncertain provider outcome reconciles from retained receipt without a second speech call", async () => {
  const f = await lessonFixture();
  try {
    let lesson = await f.start();
    f.fail("unknown");
    lesson = (await f.answer(lesson, true)).lesson;
    assert.equal(lesson.current?.attempt?.state, "uncertain");
    assert.equal(f.calls(), 1);
    let recovered = 0;
    const attempts = makeStudyService({
      ...f.attemptOptions,
      transcriber: {
        ...f.attemptOptions.transcriber,
        async recover() {
          recovered++;
          return {
            state: "assessed" as const,
            transcript: { text: f.lines[0].text, language: "en" },
          };
        },
      },
    });
    const restored = makeStudyLessonService({ ...f.lessonOptions, attempts });
    const reads = await Promise.all(
      Array.from({ length: 3 }, () => restored.get(f.owner, lesson.lessonId)),
    );
    assert.ok(
      reads.every(
        (value) =>
          value.progress.presentations === 1 &&
          value.progress.firstPassCorrect === 1,
      ),
    );
    assert.ok(recovered > 0);
    assert.equal(f.calls(), 1);
  } finally {
    await f.dispose();
  }
});
