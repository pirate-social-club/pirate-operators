import test from "node:test";
import assert from "node:assert/strict";
import { studyCommunityFixture } from "./study-community-fixture.ts";
import { firstSongFixture } from "../harness/karaoke-live.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { StudySpeechError } from "../packages/study/speech-transcriber.ts";
import { studySourceLines } from "../packages/study/public-source.ts";
import type {
  StudyLesson,
  StudyLessonSubmission,
  StudySong,
} from "../packages/study/lesson.ts";
import type { StudyAttempt } from "../packages/study/contracts.ts";

async function json<T>(response: Response): Promise<T> {
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return value as T;
}
const path = (id: string) => "/api/study/lessons/" + id;
async function start(
  f: Awaited<ReturnType<typeof studyCommunityFixture>>,
  auth: Record<string, string>,
  requestId = crypto.randomUUID(),
) {
  const song = await json<StudySong>(
    await f.call("/api/study/song?postId=" + firstSongFixture.postId, {
      headers: auth,
    }),
  );
  const lesson = await json<StudyLesson>(
    await f.post("/api/study/lessons", { requestId, song }, auth),
  );
  return { song, lesson, requestId };
}
async function open(
  f: Awaited<ReturnType<typeof studyCommunityFixture>>,
  auth: Record<string, string>,
  lesson: StudyLesson,
) {
  return json<{ attempt: StudyAttempt; lesson: StudyLesson }>(
    await f.post(
      path(lesson.lessonId) + "/attempts",
      {
        presentationNumber: lesson.current!.presentationNumber,
        takeNumber: lesson.current!.takeNumber,
      },
      auth,
    ),
  );
}
function recording(auth: Record<string, string>, suffix = 1): RequestInit {
  const bytes = new Uint8Array(40000); // Exceeds generic JSON route limit.
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  bytes[39999] = suffix;
  return {
    method: "PUT",
    headers: {
      ...auth,
      origin: firstSong.origin,
      "content-type": "audio/webm",
      "x-study-duration-ms": "1000",
    },
    body: bytes,
  };
}

test(
  "actual Study migration and authenticated application routes freeze public source and isolate each learner",
  { timeout: 60000 },
  async () => {
    const f = await studyCommunityFixture(19861);
    try {
      assert.equal(
        (
          await f.db
            .prepare("SELECT version FROM setup_schema WHERE version=9")
            .first()
        )?.version,
        9,
      );
      assert.equal(
        (await f.call("/api/study/song?postId=" + firstSongFixture.postId))
          .status,
        401,
      );
      const auth = await f.login(),
        other = await f.login(6);
      assert.equal(
        (await f.post("/api/study/lessons", {}, { cookie: auth.cookie }))
          .status,
        403,
      );
      assert.equal(
        (
          await f.post(
            "/api/study/lessons",
            {},
            { ...auth, origin: "https://foreign.example" },
          )
        ).status,
        403,
      );
      await f.enroll();
      const { lesson, song, requestId } = await start(f, auth);
      assert.equal(lesson.progress.total, 10);
      assert.ok(studySourceLines(firstSongFixture.lyrics).lines.length > 10);
      const same = await json<StudyLesson>(
        await f.post("/api/study/lessons", { requestId, song }, auth),
      );
      assert.equal(same.lessonId, lesson.lessonId);
      assert.equal(f.store.entries("studyBinding:").length, 1);
      const saved = await f.db
        .prepare("SELECT * FROM study_publications WHERE lesson_id=?")
        .bind(lesson.lessonId)
        .first<{ binding_json: string; source_json: string }>();
      const bound = JSON.parse(saved!.binding_json);
      assert.equal(bound.target.contract.toLowerCase(), f.v3.toLowerCase());
      assert.equal(bound.enrollment.activities, 3);
      assert.deepEqual(JSON.parse(saved!.source_json), firstSongFixture.lyrics);
      assert.equal(
        (await f.call(path(lesson.lessonId), { headers: other })).status,
        404,
      );
      assert.equal(
        (await f.post(path(lesson.lessonId) + "/abandon", {}, other)).status,
        404,
      );
      // Already selected work survives a source-gateway outage without changing text.
      f.sourceDown(true);
      const opened = await open(f, auth, lesson);
      f.heard(opened.attempt.line.text);
      const audioPath =
        path(lesson.lessonId) +
        "/attempts/" +
        opened.attempt.attemptId +
        "/audio";
      assert.equal((await f.call(audioPath, recording(other))).status, 404);
      const result = await json<StudyLessonSubmission>(
        await f.call(audioPath, recording(auth)),
      );
      assert.equal(result.attempt.state, "assessed");
      assert.equal(result.lesson.progress.firstPassCorrect, 1);
      const replay = await json<StudyLessonSubmission>(
        await f.call(audioPath, recording(auth)),
      );
      assert.equal(replay.lesson.progress.firstPassGraded, 1);
      assert.equal((await f.call(audioPath, recording(auth, 2))).status, 409);
      assert.deepEqual(f.counts(), { calls: 1, observations: 1 });
      const closed = await json<StudyLesson>(
        await f.post(path(lesson.lessonId) + "/abandon", {}, auth),
      );
      assert.equal(closed.status, "abandoned");
      assert.equal(closed.progress.firstPassCorrect, 1);
      assert.equal(
        (
          await f.post(
            path(lesson.lessonId) + "/attempts",
            { presentationNumber: 2, takeNumber: 1 },
            auth,
          )
        ).status,
        409,
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "application recovers a lost Study binding and speech response without another provider dispatch",
  { timeout: 60000 },
  async () => {
    const f = await studyCommunityFixture(19862);
    try {
      const auth = await f.login();
      await f.enroll();
      const song = await json<StudySong>(
        await f.call("/api/study/song?postId=" + firstSongFixture.postId, {
          headers: auth,
        }),
      );
      const requestId = crypto.randomUUID();
      f.lose("/study/bind");
      const lost = await f.post(
        "/api/study/lessons",
        { requestId, song },
        auth,
      );
      assert.ok(lost.status >= 500);
      const ledger = f.store.get("sponsor:ledger");
      const lesson = await json<StudyLesson>(
        await f.post("/api/study/lessons", { requestId, song }, auth),
      );
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      const opened = await open(f, auth, lesson);
      f.heard(opened.attempt.line.text);
      f.lose("/study/speech");
      f.statusDown(true);
      const audioPath =
        path(lesson.lessonId) +
        "/attempts/" +
        opened.attempt.attemptId +
        "/audio";
      const interrupted = await json<StudyLessonSubmission>(
        await f.call(audioPath, recording(auth)),
      );
      assert.equal(interrupted.attempt.state, "uncertain");
      assert.equal(interrupted.lesson.progress.firstPassGraded, 0);
      assert.deepEqual(f.counts(), { calls: 1, observations: 1 });
      f.restartJournal();
      f.statusDown(false);
      const key = "studySpeech:" + opened.attempt.attemptId;
      const saved = f.store.get<Record<string, unknown>>(key)!;
      f.store.set(key, { ...saved, audioDigest: "0x" + "0".repeat(64) });
      const altered = await json<StudyLesson>(
        await f.call(path(lesson.lessonId), { headers: auth }),
      );
      assert.equal(altered.progress.firstPassGraded, 0);
      f.store.set(key, saved);
      const recovered = await json<StudyLesson>(
        await f.call(path(lesson.lessonId), { headers: auth }),
      );
      assert.equal(recovered.progress.firstPassCorrect, 1);
      assert.equal(recovered.lastAttempt!.state, "assessed");
      await json<StudyLessonSubmission>(
        await f.call(audioPath, recording(auth)),
      );
      assert.deepEqual(f.counts(), { calls: 1, observations: 1 });
      const second = await open(f, auth, recovered);
      f.behavior(async () => {
        throw new StudySpeechError("speech_timeout", "unknown");
      });
      const pending = await json<StudyLessonSubmission>(
        await f.call(
          path(lesson.lessonId) +
            "/attempts/" +
            second.attempt.attemptId +
            "/audio",
          recording(auth),
        ),
      );
      assert.equal(pending.attempt.state, "uncertain");
      assert.equal(pending.lesson.progress.firstPassGraded, 1);
      await f.call(path(lesson.lessonId), { headers: auth });
      assert.deepEqual(f.counts(), { calls: 2, observations: 2 });
      f.advance(3600001);
      const expired = await json<StudyLesson>(
        await f.call(path(lesson.lessonId), { headers: auth }),
      );
      assert.equal(expired.status, "expired");
      assert.equal(expired.progress.firstPassGraded, 1);
      const terminal = await f.db
        .prepare("SELECT state_json FROM study_lessons WHERE lesson_id=?")
        .bind(lesson.lessonId)
        .first<{ state_json: string }>();
      const state = JSON.parse(terminal!.state_json);
      assert.ok(state.terminalAbsences.includes("unmeasured"));
      assert.ok(state.terminalAbsences.includes("unattempted"));
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a saved speech receipt cannot reopen a Study lesson after abandonment or expiry",
  { timeout: 60000 },
  async () => {
    const f = await studyCommunityFixture(19863);
    try {
      const auth = await f.login();
      await f.enroll();
      for (const mode of ["abandoned", "expired"] as const) {
        const { lesson } = await start(f, auth);
        const opened = await open(f, auth, lesson);
        f.heard(opened.attempt.line.text);
        f.lose("/study/speech");
        f.statusDown(true);
        await json<StudyLessonSubmission>(
          await f.call(
            path(lesson.lessonId) +
              "/attempts/" +
              opened.attempt.attemptId +
              "/audio",
            recording(auth),
          ),
        );
        if (mode === "expired") f.advance(3600001);
        const closed = await json<StudyLesson>(
          mode === "abandoned"
            ? await f.post(path(lesson.lessonId) + "/abandon", {}, auth)
            : await f.call(path(lesson.lessonId), { headers: auth }),
        );
        f.statusDown(false);
        const again = await json<StudyLesson>(
          await f.call(path(lesson.lessonId), { headers: auth }),
        );
        assert.equal(again.status, mode);
        assert.equal(again.progress.firstPassGraded, 0);
        assert.deepEqual(again, closed);
      }
      assert.deepEqual(f.counts(), { calls: 2, observations: 2 });
    } finally {
      await f.dispose();
    }
  },
);

test(
  "Study refuses paid work without a successor grant or matching configured contract",
  { timeout: 60000 },
  async () => {
    const f = await studyCommunityFixture(19864);
    try {
      const auth = await f.login();
      const song = await json<StudySong>(
        await f.call("/api/study/song?postId=" + firstSongFixture.postId, {
          headers: auth,
        }),
      );
      const refused = await f.post(
        "/api/study/lessons",
        { requestId: crypto.randomUUID(), song },
        auth,
      );
      assert.ok(refused.status >= 400);
      assert.equal(f.store.entries("studyBinding:").length, 0);
      assert.equal(
        (
          await f.db
            .prepare("SELECT count(*) AS count FROM study_publications")
            .first()
        )?.count,
        0,
      );
      assert.deepEqual(f.counts(), { calls: 0, observations: 0 });
      await f.enroll();
      f.env.STUDY_RESULTS_V3_CONTRACT = f.v2;
      const mismatch = await f.post(
        "/api/study/lessons",
        { requestId: crypto.randomUUID(), song },
        auth,
      );
      assert.equal(mismatch.status, 503);
      assert.equal(
        ((await mismatch.json()) as { error: string }).error,
        "study_unavailable",
      );
      assert.equal(f.store.entries("studyBinding:").length, 0);
      assert.deepEqual(f.counts(), { calls: 0, observations: 0 });
    } finally {
      await f.dispose();
    }
  },
);
