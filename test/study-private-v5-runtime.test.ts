// Failure cases prepared before private V5 runtime implementation. Actual HTTP,
// session, D1 lessons/attempts, issuer signatures, admission SQL and local grader.
import test from "node:test";
import assert from "node:assert/strict";
import {
  privateStudyV5Fixture,
  json,
  path,
  recording,
} from "./study-private-v5-runtime-fixture.ts";
import type {
  StudyLesson,
  StudyLessonSubmission,
} from "../packages/study/lesson.ts";
import type { StudyAttempt } from "../packages/study/contracts.ts";
import { StudySpeechError } from "../packages/study/speech-transcriber.ts";

test(
  "plain-login private V5 uses actual lesson/speech/history without public permission or financial intent",
  { timeout: 60000 },
  async () => {
    const f = await privateStudyV5Fixture(19971);
    try {
      const auth = await f.login(),
        other = await f.login(6);
      const { song, lesson, requestId } = await f.start(auth);
      assert.equal(lesson.progress.total, 10);
      const row = await f.lessonRow(lesson.lessonId);
      assert.equal(row.state.privateV5.publication.kind, "private");
      assert.equal(row.state.privateV5.version, 5);
      assert.equal(row.state.telegram, undefined);
      assert.equal(
        (await f.start(auth, requestId, song)).lesson.lessonId,
        lesson.lessonId,
      );
      assert.equal((await f.get(path(lesson.lessonId), other)).status, 404);
      assert.equal(
        (
          await f.post(
            "/api/study/lessons",
            { requestId, song },
            { cookie: auth.cookie },
          )
        ).status,
        403,
      );
      const opened = await json<{ attempt: StudyAttempt; lesson: StudyLesson }>(
        await f.post(
          path(lesson.lessonId) + "/attempts",
          { presentationNumber: 1, takeNumber: 1 },
          auth,
        ),
      );
      f.heard(opened.attempt.line.text);
      const upload =
        path(lesson.lessonId) +
        "/attempts/" +
        opened.attempt.attemptId +
        "/audio";
      const graded = await json<StudyLessonSubmission>(
        await f.call(upload, recording(auth)),
      );
      assert.equal(graded.attempt.state, "assessed");
      assert.equal(
        graded.lesson.progress.firstPassCorrect,
        1,
        "actual local grader consumes fixture transcript",
      );
      const replay = await json<StudyLessonSubmission>(
        await f.call(upload, recording(auth)),
      );
      assert.deepEqual(replay.attempt, graded.attempt);
      assert.equal(f.calls(), 1);
      assert.equal((await f.call(upload, recording(auth, 2))).status, 409);
      let progress = graded.lesson;
      while (progress.current) {
        const next = await json<{ attempt: StudyAttempt; lesson: StudyLesson }>(
          await f.post(
            path(lesson.lessonId) + "/attempts",
            {
              presentationNumber: progress.current.presentationNumber,
              takeNumber: progress.current.takeNumber,
            },
            auth,
          ),
        );
        f.heard(next.attempt.line.text);
        progress = (
          await json<StudyLessonSubmission>(
            await f.call(
              path(lesson.lessonId) +
                "/attempts/" +
                next.attempt.attemptId +
                "/audio",
              recording(auth),
            ),
          )
        ).lesson;
      }
      assert.equal(progress.status, "completed");
      assert.equal(progress.progress.firstPassCorrect, 10);
      assert.equal(f.calls(), 10);
      const history = await json<{
        lesson: { state: { startedAt: number; privateV5: unknown } };
        attempts: StudyAttempt[];
      }>(await f.post(path(lesson.lessonId) + "/history", {}, auth));
      assert.equal(history.lesson.state.startedAt, lesson.startedAt);
      assert.deepEqual(history.lesson.state.privateV5, row.state.privateV5);
      assert.equal(history.attempts[0].state, "assessed");
      assert.equal(
        (
          await json<{ state: string }>(
            await f.post(path(lesson.lessonId) + "/publication", {}, auth),
          )
        ).state,
        "private",
      );
      assert.equal(f.store.entries("studyBinding:").length, 0);
      assert.equal(f.store.entries("studyV5PrivateBinding:").length, 1);
      assert.equal(f.store.entries("studyPublication:").length, 0);
      assert.equal(f.store.entries("intent:").length, 0);
      assert.equal(f.store.entries("sponsor:").length, 0);
      // The reviewed shared budget is now genuinely exhausted, across accounts.
      const capped = await f.start(other);
      const cappedAttempt = await json<{ attempt: StudyAttempt }>(
        await f.post(
          path(capped.lesson.lessonId) + "/attempts",
          { presentationNumber: 1, takeNumber: 1 },
          other,
        ),
      );
      const refused = await json<StudyLessonSubmission>(
        await f.call(
          path(capped.lesson.lessonId) +
            "/attempts/" +
            cappedAttempt.attempt.attemptId +
            "/audio",
          recording(other),
        ),
      );
      assert.equal(refused.attempt.state, "unavailable");
      assert.equal(refused.lesson.progress.firstPassGraded, 0);
      assert.equal(
        f.calls(),
        10,
        "actual admission cap prevents another provider call",
      );
      assert.ok(
        !f.queries.some((sql) =>
          /learning_authorizations|learning_signins|publication_grants|nonce|sponsor/i.test(
            sql,
          ),
        ),
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "fresh private V5 refuses public choice, absent/zero/changed admission and unsigned operator calls before dispatch",
  { timeout: 60000 },
  async () => {
    const f = await privateStudyV5Fixture(19972);
    try {
      const auth = await f.login(),
        song = await f.song(auth);
      assert.equal(
        (
          await f.post(
            "/api/study/lessons",
            {
              requestId: crypto.randomUUID(),
              song,
              publication: { kind: "public" },
            },
            auth,
          )
        ).status,
        409,
      );
      const original = f.env.STUDY_PRIVATE_V5_PROFILE;
      f.env.STUDY_PRIVATE_V5_PROFILE = undefined;
      assert.equal(
        (
          await f.post(
            "/api/study/lessons",
            { requestId: crypto.randomUUID(), song },
            auth,
          )
        ).status,
        503,
      );
      f.env.STUDY_PRIVATE_V5_PROFILE = original;
      const policy = f.env.SPEECH_ADMISSION_CONFIG;
      for (const invalid of [
        undefined,
        JSON.stringify({ ...f.policy, dailyUnits: 0 }),
        JSON.stringify({ ...f.policy, keyGeneration: "unreviewed" }),
      ]) {
        f.env.SPEECH_ADMISSION_CONFIG = invalid;
        assert.equal(
          (
            await f.post(
              "/api/study/lessons",
              { requestId: crypto.randomUUID(), song },
              auth,
            )
          ).status,
          503,
        );
      }
      f.env.SPEECH_ADMISSION_CONFIG = policy;
      assert.equal(
        (
          await f.operatorCall(
            new Request("http://operator/study/v5/private/bind", {
              method: "POST",
              body: "{}",
            }),
          )
        ).status,
        400,
      );
      assert.equal(f.calls(), 0);
      assert.equal(
        await f.db
          .prepare("SELECT count(*) n FROM study_lessons")
          .first<number>("n"),
        0,
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "lost bind response and reloaded HTTP objects retain original private choice/source/start without upgrade",
  { timeout: 60000 },
  async () => {
    const f = await privateStudyV5Fixture(19973);
    try {
      const auth = await f.login(),
        requestId = crypto.randomUUID(),
        song = await f.song(auth);
      f.lose("/study/v5/private/bind");
      assert.equal(
        (await f.post("/api/study/lessons", { requestId, song }, auth)).status,
        503,
      );
      const first = await f.db
        .prepare(
          "SELECT lesson_id,state_json FROM study_lessons WHERE request_id=?",
        )
        .bind(requestId)
        .first<{ lesson_id: string; state_json: string }>();
      assert.ok(first);
      const resumed = await f.start(auth, requestId, song);
      assert.equal(resumed.lesson.lessonId, first.lesson_id);
      assert.equal(
        resumed.lesson.startedAt,
        JSON.parse(first.state_json).startedAt,
      );
      assert.equal(
        (
          await f.post(
            "/api/study/lessons",
            {
              requestId,
              song: { ...song, lyricRevision: song.lyricRevision + 1 },
            },
            auth,
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await f.post(
            "/api/study/lessons",
            { requestId, song, publication: { kind: "public" } },
            auth,
          )
        ).status,
        409,
      );
      assert.equal(f.store.entries("studyV5PrivateBinding:").length, 1);
      assert.equal(f.store.entries("intent:").length, 0);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "unknown private speech keeps original job/charge; reload queries instead of resending",
  { timeout: 60000 },
  async () => {
    const f = await privateStudyV5Fixture(19974);
    try {
      const auth = await f.login(),
        { lesson } = await f.start(auth);
      const opened = await json<{ attempt: StudyAttempt }>(
        await f.post(
          path(lesson.lessonId) + "/attempts",
          { presentationNumber: 1, takeNumber: 1 },
          auth,
        ),
      );
      f.behavior(async () => {
        throw new StudySpeechError("fixture_unknown_ack", "unknown");
      });
      const upload =
        path(lesson.lessonId) +
        "/attempts/" +
        opened.attempt.attemptId +
        "/audio";
      const result = await json<StudyLessonSubmission>(
        await f.call(upload, recording(auth)),
      );
      assert.equal(result.attempt.state, "uncertain");
      await json(await f.get(path(lesson.lessonId), auth));
      await json(await f.call(upload, recording(auth)));
      assert.equal(f.calls(), 1);
      assert.ok(f.resolutions.some((r) => r.state === "unknown"));
      assert.ok(!f.resolutions.some((r) => r.state === "refused"));
      assert.equal(f.store.entries("intent:").length, 0);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "logout during actual D1 read refuses the accepting write",
  { timeout: 60000 },
  async () => {
    const f = await privateStudyV5Fixture(19975);
    try {
      const auth = await f.login(),
        song = await f.song(auth);
      f.afterRead(async (sql) => {
        if (sql.includes("FROM study_lessons") && sql.includes("request_id"))
          await f.db.prepare("DELETE FROM community_sessions").run();
      });
      assert.equal(
        (
          await f.post(
            "/api/study/lessons",
            { requestId: crypto.randomUUID(), song },
            auth,
          )
        ).status,
        409,
      );
      assert.equal(
        await f.db
          .prepare("SELECT count(*) n FROM study_lessons")
          .first<number>("n"),
        0,
      );
      assert.equal(f.calls(), 0);
    } finally {
      await f.dispose();
    }
  },
);

// Regression through the same real HTTP facade after selecting the successor.
// Existing V4 wire/authorization rows and their original binding remain byte-exact.
test(
  "fresh selection retains an already-bound V4 lesson instead of reinterpreting it as V5",
  { timeout: 60000 },
  async () => {
    const { studyCommunityFixture } = await import(
      "./study-community-fixture.ts"
    );
    const { firstSongFixture } = await import("../harness/karaoke-live.ts");
    const { studyV5PrivateHttp } = await import("../services/study-v5-http.ts");
    const { speechRepairFixture } = await import(
      "./karaoke-admission-repair1-fixture.ts"
    );
    const { digest } = await import("../packages/protocol/index.ts");
    const { firstSong } = await import("../services/first-song-profile.ts");
    const f = await studyCommunityFixture(19976, { v4: true });
    const budget = speechRepairFixture({ communityId: f.config.communityId });
    try {
      const auth = await f.login();
      await f.recordSignIns();
      const song = await json<import("../packages/study/lesson.ts").StudySong>(
        await f.call("/api/study/song?postId=" + firstSongFixture.postId, {
          headers: auth,
        }),
      );
      const original = await json<StudyLesson>(
        await f.post(
          "/api/study/lessons",
          { requestId: crypto.randomUUID(), song },
          auth,
        ),
      );
      const before = await f.db
        .prepare(
          "SELECT binding_json FROM study_publications WHERE lesson_id=?",
        )
        .bind(original.lessonId)
        .first<{ binding_json: string }>();
      assert.ok(before);
      assert.equal(JSON.parse(before.binding_json).target.version, 4);
      const profile = {
        schema: "pirate.study-private-runtime/5",
        version: 5,
        chainId: 31337,
        communityId: f.config.communityId,
        sourceChainId: f.config.chainId,
        contract: f.v4.toLowerCase(),
        releaseHash: digest({ fixture: "private-selection-after-v4" }),
        speechPolicyHash: digest(budget.policy),
      };
      const env = {
        ...f.env,
        ...budget.env,
        STUDY_RUNTIME: "private-v5" as const,
        STUDY_PRIVATE_V5_PROFILE: JSON.stringify(profile),
      };
      const response = await studyV5PrivateHttp(
        new Request(firstSong.origin + path(original.lessonId), {
          headers: auth,
        }),
        {
          env,
          db: f.db as unknown as D1Database,
          reads: f.ports.publicReads!,
          config: f.config,
          now: f.clock,
        },
        { communityId: f.config.communityId, origin: firstSong.origin },
        new Headers(),
      );
      const retained = await json<StudyLesson>(response!);
      assert.equal(retained.lessonId, original.lessonId);
      assert.equal(retained.startedAt, original.startedAt);
      assert.deepEqual(retained.current, original.current);
      assert.deepEqual(
        await f.db
          .prepare(
            "SELECT binding_json FROM study_publications WHERE lesson_id=?",
          )
          .bind(original.lessonId)
          .first(),
        before,
      );
      assert.equal(f.store.entries("studyV5PrivateBinding:").length, 0);
    } finally {
      budget.close();
      await f.dispose();
    }
  },
);

test(
  "known unavailable speech consumes no learner take and a new authorized retry still grades locally",
  { timeout: 60000 },
  async () => {
    const f = await privateStudyV5Fixture(19977);
    try {
      const auth = await f.login(),
        { lesson } = await f.start(auth);
      const open = () =>
        f.post(
          path(lesson.lessonId) + "/attempts",
          { presentationNumber: 1, takeNumber: 1 },
          auth,
        );
      const first = await json<{ attempt: StudyAttempt }>(await open());
      f.behavior(async () => {
        throw new StudySpeechError("fixture_known_refusal", "known_failed");
      });
      const failed = await json<StudyLessonSubmission>(
        await f.call(
          path(lesson.lessonId) +
            "/attempts/" +
            first.attempt.attemptId +
            "/audio",
          recording(auth),
        ),
      );
      assert.equal(failed.attempt.state, "unavailable");
      assert.equal(failed.lesson.progress.firstPassGraded, 0);
      const retry = await json<{ attempt: StudyAttempt }>(await open());
      assert.notEqual(retry.attempt.attemptId, first.attempt.attemptId);
      assert.equal(retry.attempt.lesson?.takeNumber, 1);
      f.behavior(async () => ({
        text: retry.attempt.line.text,
        language: "en",
      }));
      const passed = await json<StudyLessonSubmission>(
        await f.call(
          path(lesson.lessonId) +
            "/attempts/" +
            retry.attempt.attemptId +
            "/audio",
          recording(auth),
        ),
      );
      assert.equal(passed.lesson.progress.firstPassCorrect, 1);
      assert.ok(f.resolutions.some((r) => r.state === "refused"));
      assert.ok(f.resolutions.some((r) => r.state === "succeeded"));
    } finally {
      await f.dispose();
    }
  },
);

test(
  "actual accepting D1 transaction rolls back a start after the final session check loses authority",
  { timeout: 60000 },
  async () => {
    const f = await privateStudyV5Fixture(19978);
    try {
      const auth = await f.login(),
        song = await f.song(auth);
      f.beforeBatch(async (statements) => {
        if (statements.some((sql) => sql.includes("INSERT INTO study_lessons")))
          await f.db.prepare("DELETE FROM community_sessions").run();
      });
      assert.equal(
        (
          await f.post(
            "/api/study/lessons",
            { requestId: crypto.randomUUID(), song },
            auth,
          )
        ).status,
        409,
      );
      assert.equal(
        await f.db
          .prepare("SELECT count(*) n FROM study_lessons")
          .first<number>("n"),
        0,
      );
      assert.equal(f.store.entries("studyV5PrivateBinding:").length, 0);
      assert.equal(f.calls(), 0);
    } finally {
      await f.dispose();
    }
  },
);

// Reproductions for review findings: use the actual default HTTP connector and
// safe-retry composition; only the remote response is replaced, never its guards.
for (const change of ["expiry", "release"] as const) {
  test(
    `physical rate-limit retry rechecks original ${change} before another upload`,
    { timeout: 60000 },
    async (t) => {
      const f = await privateStudyV5Fixture(
        change === "expiry" ? 19979 : 19980,
        { productionSpeech: true },
      );
      try {
        const auth = await f.login(),
          { lesson } = await f.start(auth);
        const opened = await json<{ attempt: StudyAttempt }>(
          await f.post(
            path(lesson.lessonId) + "/attempts",
            { presentationNumber: 1, takeNumber: 1 },
            auth,
          ),
        );
        const actualFetch = globalThis.fetch;
        let uploads = 0;
        t.mock.method(
          globalThis,
          "fetch",
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : String(input);
            if (new URL(url).hostname !== "api.elevenlabs.io")
              return actualFetch(input, init);
            uploads++;
            assert.equal(init?.method, "POST");
            assert.ok(init?.body instanceof FormData);
            if (uploads === 1) {
              if (change === "expiry") f.advance(61000);
              else
                f.operatorEnv.STUDY_PRIVATE_V5_PROFILE = JSON.stringify({
                  ...JSON.parse(f.operatorEnv.STUDY_PRIVATE_V5_PROFILE),
                  releaseHash: "0x" + "f1".repeat(32),
                });
            }
            return new Response("rate limited before processing", {
              status: 429,
            });
          },
        );
        const response = await f.call(
          path(lesson.lessonId) +
            "/attempts/" +
            opened.attempt.attemptId +
            "/audio",
          recording(auth),
        );
        const result = await json<StudyLessonSubmission>(response);
        assert.equal(
          uploads,
          1,
          "retired original authority must stop the second physical HTTP upload",
        );
        assert.equal(result.attempt.state, "unavailable");
        assert.equal(result.lesson.progress.firstPassGraded, 0);
        assert.ok(f.resolutions.some((r) => r.state === "refused"));
        assert.equal(
          f.resolutions.some(
            (r) => r.state === "succeeded" || r.state === "unknown",
          ),
          false,
        );
        assert.equal(f.store.entries("intent:").length, 0);
      } finally {
        await f.dispose();
      }
    },
  );
}

for (const website of [true, false]) {
  test(
    `website latest excludes retained Telegram lessons with ${website ? "an older website lesson" : "Telegram-only history"}`,
    { timeout: 60000 },
    async () => {
      const f = await privateStudyV5Fixture(website ? 19981 : 19982);
      try {
        const auth = await f.login(),
          { lesson, song } = await f.start(auth);
        const row = await f.db
          .prepare("SELECT account_id FROM study_lessons WHERE lesson_id=?")
          .bind(lesson.lessonId)
          .first<{ account_id: string }>();
        assert.ok(row);
        const state = structuredClone(
          (await f.lessonRow(lesson.lessonId)).state,
        );
        delete state.privateV5;
        state.telegram = {
          fenceHash: "0x" + "c1".repeat(32),
          authorizationId: "0x" + "c2".repeat(32),
        };
        state.startedAt += 1000;
        const { StudyLessonStore } = await import(
          "../packages/study/lesson-store.ts"
        );
        await new StudyLessonStore(f.db).create(
          { accountId: row.account_id, communityId: f.config.communityId },
          crypto.randomUUID(),
          state,
        );
        if (!website)
          await f.db
            .prepare(
              "UPDATE study_lessons SET history_deleted_at=? WHERE lesson_id=?",
            )
            .bind(f.clock(), lesson.lessonId)
            .run();
        const providerCalls = f.calls(),
          bindings = f.store.entries("studyV5PrivateBinding:").length;
        const latest = await json<StudyLesson | null>(
          await f.get(
            "/api/study/lessons?song=" +
              encodeURIComponent(JSON.stringify(song)),
            auth,
          ),
        );
        assert.equal(
          latest?.lessonId ?? null,
          website ? lesson.lessonId : null,
        );
        assert.equal(f.calls(), providerCalls);
        assert.equal(
          f.store.entries("studyV5PrivateBinding:").length,
          bindings,
        );
        assert.equal(f.store.entries("intent:").length, 0);
      } finally {
        await f.dispose();
      }
    },
  );
}
