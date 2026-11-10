import test from "node:test";
import { closeBoundOf } from "./study-close-bound-fixture.ts";
import assert from "node:assert/strict";
import { studyCommunityFixture } from "./study-community-fixture.ts";
import { firstSongFixture } from "../harness/karaoke-live.ts";
import { firstSong } from "../services/first-song-profile.ts";
import type { StudyLesson, StudySong } from "../packages/study/lesson.ts";
import type { StudyAttempt } from "../packages/study/contracts.ts";
import { STUDY_HISTORY_EXPORT_WINDOW_MS } from "../services/study-history.ts";

test(
  "private Study export is account/Origin/CSRF scoped, complete past fifty attempts and independent of practice availability",
  { timeout: 60000 },
  async () => {
    const f = await studyCommunityFixture(19868);
    try {
      const auth = await f.login(),
        other = await f.login(6);
      await f.enroll();
      const song = (await (
        await f.call("/api/study/song?postId=" + firstSongFixture.postId, {
          headers: auth,
        })
      ).json()) as StudySong;
      const lesson = (await (
        await f.post(
          "/api/study/lessons",
          { song, requestId: crypto.randomUUID() },
          auth,
        )
      ).json()) as StudyLesson;
      const path = "/api/study/lessons/" + lesson.lessonId;
      const opened = (await (
        await f.post(
          path + "/attempts",
          { presentationNumber: 1, takeNumber: 1 },
          auth,
        )
      ).json()) as { attempt: StudyAttempt };
      f.heard("private fixture words");
      const audio = new Uint8Array(40000);
      audio.set([0x1a, 0x45, 0xdf, 0xa3]);
      const response = await f.call(
        path + "/attempts/" + opened.attempt.attemptId + "/audio",
        {
          method: "PUT",
          headers: {
            ...auth,
            origin: firstSong.origin,
            "content-type": "audio/webm",
            "x-study-duration-ms": "1000",
          },
          body: audio,
        },
      );
      assert.equal(response.status, 200, await response.text());
      // Synthetic extra rows exercise export completeness, not provider dispatch.
      const attempt = opened.attempt;
      await f.db.batch(
        Array.from({ length: 54 }, (_, i) =>
          f.db
            .prepare(
              `INSERT INTO study_attempts(attempt_id,account_id,community_id,request_id,line_json,policy,started_at,state,lesson_id,presentation_number,take_number)
      SELECT ?,account_id,community_id,?,line_json,policy,started_at+?,'ready',lesson_id,?,? FROM study_attempts WHERE attempt_id=?`,
            )
            .bind(
              crypto.randomUUID(),
              crypto.randomUUID(),
              i + 1,
              Math.floor((i + 1) / 3) + 1,
              ((i + 1) % 3) + 1,
              attempt.attemptId,
            ),
        ),
      );
      const endpoint = path + "/history";
      assert.equal((await f.post(endpoint, {})).status, 401);
      assert.equal(
        (await f.post(endpoint, {}, { cookie: auth.cookie })).status,
        403,
      );
      assert.equal(
        (
          await f.post(
            endpoint,
            {},
            { ...auth, origin: "https://foreign.example" },
          )
        ).status,
        403,
      );
      assert.equal((await f.post(endpoint, {}, other)).status, 404);
      const before = f.counts();
      f.env.STUDY_RESULTS_V3_CONTRACT = undefined;
      const exported = await f.post(endpoint, {}, auth);
      assert.equal(exported.status, 200, await exported.clone().text());
      assert.equal(exported.headers.get("cache-control"), "no-store");
      const history = (await exported.json()) as {
        schema: string;
        attempts: StudyAttempt[];
        exportAvailableUntil: number;
        lesson: { lessonId: string };
      };
      assert.equal(history.schema, "pirate.study-private-history/1");
      assert.equal(history.lesson.lessonId, lesson.lessonId);
      assert.equal(history.attempts.length, 55);
      assert.equal(
        history.attempts.find((a) => a.attemptId === attempt.attemptId)?.grade
          ?.heardTranscript,
        "private fixture words",
      );
      assert.deepEqual(f.counts(), before);
      assert.equal(f.store.entries("studyPublication:").length, 0);
      assert.ok(
        history.exportAvailableUntil >=
          lesson.startedAt + STUDY_HISTORY_EXPORT_WINDOW_MS,
      );
      // The lesson is still open. Its reported window is a lower bound (leaving
      // later can only extend it); the export ends at the close bound (the
      // bound consent's last second) plus the window, whether or not any
      // reader has closed the lesson.
      assert.equal(
        history.exportAvailableUntil,
        (history as unknown as { exportedAt: number }).exportedAt +
          STUDY_HISTORY_EXPORT_WINDOW_MS,
      );
      const bound = await closeBoundOf(f.db, lesson.lessonId);
      assert.equal(bound.reason, "consent_ended");
      f.advance(bound.at + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock() - 1);
      assert.equal((await f.post(endpoint, {}, auth)).status, 200);
      f.advance(1);
      const expired = await f.post(endpoint, {}, auth);
      assert.equal(expired.status, 410);
      assert.equal(
        ((await expired.json()) as { error: string }).error,
        "study_history_expired",
      );
      assert.deepEqual(f.counts(), before);
    } finally {
      await f.dispose();
    }
  },
);
