import test from "node:test";
import assert from "node:assert/strict";
import {
  studyPublicationFixture,
  lessonPath,
} from "./study-publication-fixture.ts";
import { deleteExpiredStudyHistory } from "../services/study-retention.ts";
import { communityScheduled } from "../services/community-application.ts";
import { STUDY_HISTORY_EXPORT_WINDOW_MS } from "../services/study-history.ts";
import { intentOf, txRow } from "../services/operator-tx.ts";
import { expireStudySpeech } from "../services/study-operator.ts";
import { StudySpeechError } from "../packages/study/speech-transcriber.ts";
import { closeBoundOf } from "./study-close-bound-fixture.ts";

test(
  "a malformed old queue is reported without starving another due lesson",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19886);
    try {
      const invalid = await f.start();
      await f.db
        .prepare(
          "UPDATE study_lessons SET state_json=json_set(state_json,'$.policy','fixture-invalid') WHERE lesson_id=?",
        )
        .bind(invalid.lessonId)
        .run();
      f.advance(1);
      const valid = await f.start();
      const bound = await closeBoundOf(f.db, valid.lessonId);
      assert.equal(bound.reason, "consent_ended");
      f.advance(bound.at + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock());
      await assert.rejects(
        deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock, 2),
        /study_lesson_policy_unavailable/,
      );
      const rows = await f.db
        .prepare("SELECT lesson_id,history_deleted_at FROM study_lessons")
        .all<{ lesson_id: string; history_deleted_at: number | null }>();
      assert.equal(
        rows.results.find((row) => row.lesson_id === invalid.lessonId)!
          .history_deleted_at,
        null,
      );
      assert.equal(
        rows.results.find((row) => row.lesson_id === valid.lessonId)!
          .history_deleted_at,
        f.clock(),
      );
      assert.deepEqual(f.counts(), { calls: 0, observations: 0 });
    } finally {
      await f.dispose();
    }
  },
);

test(
  "Study deletion preserves lost-response public recovery and blocks private replay at the exact deadline",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19883);
    try {
      let lesson = await f.start();
      lesson = (await f.answer(lesson, false)).lesson;
      f.lose("/study/terminal");
      await f.abandon(lesson.lessonId);
      const request = await f.db
        .prepare("SELECT request_id FROM study_lessons WHERE lesson_id=?")
        .bind(lesson.lessonId)
        .first<{ request_id: string }>();
      const before = await f.db
        .prepare(
          "SELECT terminal_json,binding_json FROM study_publications WHERE lesson_id=?",
        )
        .bind(lesson.lessonId)
        .first<{ terminal_json: string; binding_json: string }>();
      assert.ok(before?.terminal_json);
      assert.deepEqual(Object.keys(JSON.parse(before.terminal_json)).sort(), [
        "completedAt",
        "expiresAt",
        "outcomes",
        "schema",
        "startedAt",
        "status",
      ]);
      assert.ok(!before.terminal_json.includes("unrelated words"));
      const intent = intentOf(
        f.store,
        "record_result",
        "study:" + lesson.lessonId + ":1",
      )!;
      const tx = txRow(f.store, intent.nonce!)!;
      assert.ok(tx.raw);
      const ledger = f.store.get("sponsor:ledger"),
        counts = f.counts();
      f.advance(STUDY_HISTORY_EXPORT_WINDOW_MS - 1);
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        0,
      );
      assert.equal(
        (await f.db
          .prepare("SELECT count(*) AS n FROM study_attempts WHERE lesson_id=?")
          .bind(lesson.lessonId)
          .first<{ n: number }>())!.n,
        1,
      );
      f.advance(1);
      const contract = f.env.STUDY_RESULTS_V3_CONTRACT;
      f.env.STUDY_RESULTS_V3_CONTRACT = undefined;
      await communityScheduled(f.env, f.ports); // Retention continues with practice disabled.
      const erased = await f.db
        .prepare(
          "SELECT state_json,history_deleted_at FROM study_lessons WHERE lesson_id=?",
        )
        .bind(lesson.lessonId)
        .first<{ state_json: string; history_deleted_at: number }>();
      assert.equal(erased!.state_json, "{}");
      assert.equal(erased!.history_deleted_at, f.clock());
      assert.equal(
        (await f.db
          .prepare("SELECT count(*) AS n FROM study_attempts WHERE lesson_id=?")
          .bind(lesson.lessonId)
          .first<{ n: number }>())!.n,
        0,
      );
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        0,
      );
      expireStudySpeech(f.store);
      assert.equal(f.store.entries("studySpeech:").length, 0);
      assert.ok(f.store.entries("studyBinding:").length);
      assert.ok(f.store.entries("studySpeechSlot:").length);
      f.env.STUDY_RESULTS_V3_CONTRACT = contract;
      const auth = await f.login();
      assert.equal(
        (await f.post(lessonPath(lesson.lessonId) + "/history", {}, auth))
          .status,
        410,
      );
      assert.equal(
        (await f.call(lessonPath(lesson.lessonId), { headers: auth })).status,
        410,
      );
      assert.equal(
        (
          await f.post(
            "/api/study/lessons",
            { song: f.song, requestId: request!.request_id },
            auth,
          )
        ).status,
        410,
      );
      await f.evm.rpc("anvil_mine", ["0xc"]);
      await communityScheduled(f.env, f.ports);
      const saved = await f.publication(lesson.lessonId);
      assert.equal(saved.state, "published");
      assert.equal(saved.receipt!.confirmed, true);
      assert.equal(saved.receipt!.transactionHash, tx.hash);
      assert.equal(txRow(f.store, intent.nonce!)!.raw, tx.raw);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      assert.deepEqual(f.counts(), counts);
      const after = await f.db
        .prepare(
          "SELECT terminal_json,binding_json FROM study_publications WHERE lesson_id=?",
        )
        .bind(lesson.lessonId)
        .first();
      assert.deepEqual(after, before);
      const [publicResult] = await f.readResults();
      assert.equal(
        publicResult.verified,
        true,
        JSON.stringify(publicResult.problems),
      );
      if (publicResult.assessment?.activity !== 2)
        throw Error("missing Study assessment");
      assert.equal(publicResult.assessment.outcomes[0].status, "incorrect");
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a terminal outbox survives deletion before first operator delivery without acquiring a new grant or charge",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19884);
    try {
      const lesson = await f.start(),
        binding = f.env.KARAOKE_OPERATOR;
      f.env.KARAOKE_OPERATOR = {
        fetch: async () => {
          throw Error("fixture operator unavailable");
        },
      } as unknown as Fetcher;
      await f.abandon(lesson.lessonId);
      assert.equal(f.store.entries("studyPublication:").length, 0);
      const count = f.store.entries("tx:").length;
      const spent = f.store.get<{ spent: string }>("sponsor:ledger")!.spent;
      f.advance(STUDY_HISTORY_EXPORT_WINDOW_MS);
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        1,
      );
      f.env.KARAOKE_OPERATOR = binding;
      await communityScheduled(f.env, f.ports);
      const row = await f.db
        .prepare(
          "SELECT receipt_json FROM study_publications WHERE lesson_id=?",
        )
        .bind(lesson.lessonId)
        .first<{ receipt_json: string }>();
      assert.equal(JSON.parse(row!.receipt_json).state, "private");
      assert.equal(
        JSON.parse(row!.receipt_json).reason,
        "private_history_expired",
      );
      assert.equal(JSON.parse(row!.receipt_json).neverSubmitted, true);
      assert.equal(JSON.parse(row!.receipt_json).privateHistoryErased, true);
      assert.equal(f.store.entries("tx:").length, count);
      assert.equal(
        f.store.get<{ spent: string }>("sponsor:ledger")!.spent,
        spent,
      );
      assert.deepEqual(f.counts(), { calls: 0, observations: 0 });
    } finally {
      await f.dispose();
    }
  },
);

for (const mode of ["legacy", "new"] as const)
  test(
    `retention closes an unattended uncertain ${mode} dispatch without inventing a wrong answer or sending speech again`,
    { timeout: 90000 },
    async () => {
      const f = await studyPublicationFixture(
        mode === "legacy" ? 19885 : 19953,
      );
      try {
        let lesson =
          mode === "legacy" ? await f.startLegacy() : await f.start();
        f.behavior(async () => {
          throw new StudySpeechError("fixture_unknown", "unknown");
        });
        lesson = (await f.answer(lesson, false)).lesson;
        const counts = f.counts();
        // Legacy: the one-hour deadline. New: the bound consent's last second.
        const bound = await closeBoundOf(f.db, lesson.lessonId);
        assert.equal(
          bound.reason,
          mode === "legacy" ? "deadline" : "consent_ended",
        );
        if (mode === "legacy") assert.equal(bound.at, lesson.expiresAt);
        f.advance(bound.at + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock());
        assert.equal(
          await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
          1,
        );
        const row = await f.db
          .prepare(
            "SELECT terminal_json FROM study_publications WHERE lesson_id=?",
          )
          .bind(lesson.lessonId)
          .first<{ terminal_json: string }>();
        const terminal = JSON.parse(row!.terminal_json);
        assert.equal(
          terminal.status,
          mode === "legacy" ? "expired" : "abandoned",
        );
        assert.equal(terminal.completedAt, bound.at);
        assert.equal(terminal.outcomes.slice(6, 8), "04"); // Submitted but unmeasured.
        assert.equal(terminal.outcomes.slice(12, 14), "05"); // Never attempted.
        assert.deepEqual(f.counts(), counts);
      } finally {
        await f.dispose();
      }
    },
  );
