import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { lessonFixture, lessonRecording } from "./study-lesson-fixture.ts";
import { StudyLessonStore } from "../packages/study/lesson-store.ts";
import { normalizeStudyLineText } from "../packages/study/line-selection.ts";
import { makeStudyLessonService } from "../services/study-lessons.ts";
import type { StudyLesson } from "../packages/study/lesson.ts";

async function selected(
  f: Awaited<ReturnType<typeof lessonFixture>>,
  lesson: StudyLesson,
) {
  const row = await f.db
    .prepare("SELECT state_json FROM study_lessons WHERE lesson_id=?")
    .bind(lesson.lessonId)
    .first<{ state_json: string }>();
  return JSON.parse(row!.state_json).items.map(
    (item: { line: { lineId: string } }) => item.line.lineId,
  ) as string[];
}

test("successive lessons reach beyond ten lines using durable learner-specific practice", async () => {
  const f = await lessonFixture(25);
  try {
    let first = await f.start("first-selection-request");
    assert.deepEqual(
      await selected(f, first),
      f.lines.slice(0, 10).map((l) => l.lineId),
    );
    const firstId = first.lessonId;
    for (let i = 0; i < 10; i++) {
      f.advanceClock(1000);
      first = (await f.answer(first, true)).lesson;
    }
    let second = await f.start();
    assert.deepEqual(
      await selected(f, second),
      f.lines.slice(10, 20).map((l) => l.lineId),
    );
    for (let i = 0; i < 10; i++) {
      f.advanceClock(1000);
      second = (await f.answer(second, true)).lesson;
    }
    const third = await f.start();
    assert.deepEqual(
      await selected(f, third),
      [...f.lines.slice(20), ...f.lines.slice(0, 5)].map((l) => l.lineId),
    );
    const other = await f.lessons.start(
      { ...f.owner, accountId: "another-learner" },
      "other-selection-request",
      f.song,
    );
    assert.deepEqual(
      await selected(f, other),
      f.lines.slice(0, 10).map((l) => l.lineId),
    );
    const replay = await f.lessons.start(
      f.owner,
      "first-selection-request",
      f.song,
    );
    assert.equal(replay.lessonId, firstId);
    assert.equal(replay.status, "completed");
    assert.deepEqual(
      await selected(f, replay),
      f.lines.slice(0, 10).map((l) => l.lineId),
    );
    assert.equal(f.calls(), 20);
  } finally {
    await f.dispose();
  }
});

test("fewest graded presentations wins, then least recent, then song order", async () => {
  const f = await lessonFixture();
  try {
    let a = await f.start();
    a = (await f.answer(a, false)).lesson; // line 0: once
    f.advanceClock(1000);
    a = (await f.answer(a, true)).lesson; // line 1: once
    let b = await f.start();
    assert.deepEqual(
      await selected(f, b),
      [2, 3, 0, 1].map((i) => f.lines[i].lineId),
    );
    for (let i = 0; i < 3; i++) {
      // lines 2, 3, 0
      f.advanceClock(1000);
      b = (await f.answer(b, true)).lesson;
    }
    f.advanceClock(1000);
    a = (await f.answer(a, true)).lesson; // line 2: twice
    assert.deepEqual(
      await selected(f, await f.start()),
      [1, 3, 0, 2].map((i) => f.lines[i].lineId),
    );
    f.advanceClock(1000);
    a = (await f.answer(a, true)).lesson; // line 3: twice
    f.advanceClock(1000);
    b = (await f.answer(b, true)).lesson; // line 1: twice, most recent
    assert.deepEqual(
      await selected(f, await f.start()),
      [0, 2, 3, 1].map((i) => f.lines[i].lineId),
    );
    assert.equal(
      (await f.lessons.get(f.owner, a.lessonId)).current?.line.lineId,
      f.lines[0].lineId,
    );
  } finally {
    await f.dispose();
  }
});

test("repeated chorus text is collapsed before the ten-line limit and needs four unique lines", async () => {
  const f = await lessonFixture(14);
  try {
    for (const i of [2, 6, 13]) f.lines[i].text = "  ＨＯＬＤ me CLOSE 1! 🎵 ";
    const lesson = await f.start();
    const ids = await selected(f, lesson);
    assert.deepEqual(
      ids,
      f.lines
        .filter((_, i) => ![2, 6, 13].includes(i))
        .slice(0, 10)
        .map((l) => l.lineId),
    );
    assert.equal(
      new Set(
        ids.map((id) =>
          normalizeStudyLineText(f.lines.find((l) => l.lineId === id)!.text),
        ),
      ).size,
      10,
    );
    assert.equal(
      normalizeStudyLineText("Don’t go!"),
      normalizeStudyLineText("don t go"),
    );
    await f.answer(lesson, true);
    const next = await f.start();
    assert.equal(next.current?.line.lineId, f.lines[1].lineId);
    assert.ok((await selected(f, next)).includes(f.lines[12].lineId));
    for (const line of f.lines) line.text = f.lines[0].text;
    await assert.rejects(f.start(), /insufficient_study_lines/);
    assert.deepEqual(await selected(f, lesson), ids);
  } finally {
    await f.dispose();
  }
});

test("practice is song-scoped and survives unchanged text in a new revision; edited text starts fresh", async () => {
  const f = await lessonFixture(12);
  try {
    const first = await f.start();
    await f.answer(first, true);
    const lessons = makeStudyLessonService({
      ...f.lessonOptions,
      resolveLines: async (song) =>
        f.lines.map((line) => ({ ...line, ...song })),
    });
    const differentSongs = [
      { ...f.song, postId: "0x" + "e".repeat(64) },
      { ...f.song, chainId: 6344 },
      { ...f.song, postsContract: "0x" + "3".repeat(40) },
      { ...f.song, communityId: "0x" + "f".repeat(64) },
    ];
    for (const song of differentSongs) {
      const other = await lessons.start(
        { ...f.owner, communityId: song.communityId },
        "song-selection-" + crypto.randomUUID(),
        song,
      );
      assert.equal(other.current?.line.lineId, f.lines[0].lineId);
    }
    const revision = { ...f.song, lyricRevision: 2 };
    const continued = await lessons.start(
      f.owner,
      "new-revision-request",
      revision,
    );
    assert.equal(continued.current?.line.lineId, f.lines[1].lineId);
    f.lines[0].text = "An entirely different lyric";
    const edited = await lessons.start(
      f.owner,
      "edited-revision-request",
      revision,
    );
    assert.equal(edited.current?.line.lineId, f.lines[0].lineId);
    assert.equal(
      (await f.lessons.get(f.owner, first.lessonId)).lastAttempt?.line.text,
      "Hold me close 1",
    );
  } finally {
    await f.dispose();
  }
});

test("ungraded provider failures and repeated uploads do not inflate practice", async () => {
  const f = await lessonFixture(12);
  try {
    f.fail("known_failed");
    await f.answer(await f.start(), true);
    f.fail("unknown");
    const uncertain = await f.start();
    assert.equal(uncertain.current?.line.lineId, f.lines[0].lineId);
    await f.answer(uncertain, true);
    assert.deepEqual(
      await new StudyLessonStore(f.db).practice(f.owner, f.song),
      [],
    );
    f.fail(null);
    const fresh = await f.start();
    assert.equal(fresh.current?.line.lineId, f.lines[0].lineId);
    const result = await f.answer(fresh, false);
    for (let i = 0; i < 3; i++)
      await Effect.runPromise(
        f.lessons.submit(
          f.owner,
          fresh.lessonId,
          result.attempt.attemptId,
          lessonRecording(),
        ),
      );
    const history = await new StudyLessonStore(f.db).practice(f.owner, f.song);
    assert.equal(history.length, 1);
    assert.equal(history[0].presentations, 1);
    assert.equal((await f.start()).current?.line.lineId, f.lines[1].lineId);
    assert.equal(f.calls(), 3);
  } finally {
    await f.dispose();
  }
});

test("a saved grade counts once for selection after disk restart even before queue recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-selection-restart-"));
  let f = await lessonFixture(12, dir);
  try {
    const lesson = await f.start();
    const opened = await f.lessons.openAttempt(f.owner, lesson.lessonId, 1, 1);
    await Effect.runPromise(
      f.attempts.submit(f.owner, opened.attempt.attemptId, lessonRecording()),
    );
    await f.dispose();
    f = await lessonFixture(12, dir, false);
    const next = await f.start();
    assert.equal(next.current?.line.lineId, f.lines[1].lineId);
    assert.equal(f.calls(), 0);
    await f.lessons.get(f.owner, lesson.lessonId);
    await Effect.runPromise(
      f.lessons.submit(
        f.owner,
        lesson.lessonId,
        opened.attempt.attemptId,
        lessonRecording(),
      ),
    );
    assert.equal(
      (await new StudyLessonStore(f.db).practice(f.owner, f.song))[0]
        .presentations,
      1,
    );
    assert.equal((await f.start()).current?.line.lineId, f.lines[1].lineId);
    assert.equal(f.calls(), 0);
  } finally {
    await f.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
