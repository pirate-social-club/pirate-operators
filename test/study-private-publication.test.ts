import test from "node:test";
import assert from "node:assert/strict";
import { zeroHash } from "viem";
import { studyPublicationFixture } from "./study-publication-fixture.ts";
import { communityScheduled } from "../services/community-application.ts";
import { deleteExpiredStudyHistory } from "../services/study-retention.ts";
import { STUDY_HISTORY_EXPORT_WINDOW_MS } from "../services/study-history.ts";
import {
  bindManagedStudy,
  publishManagedStudy,
} from "../services/study-operator-client.ts";
import {
  closedStudyPublication,
  eraseNeverSubmittedStudy,
} from "../services/study-private-publication.ts";
import { resumeStudyPublications } from "../services/study-publication-recovery.ts";
import type { PublicationJob } from "../services/study-publication.ts";
import {
  expireStudySpeech,
  type StudyOperatorBinding,
} from "../services/study-operator.ts";
import { intentOf, txRow } from "../services/operator-tx.ts";
import type { StudyTranscript } from "../packages/study/speech-transcriber.ts";

test(
  "never-submitted private grades and selections are erased with a permanent replay tombstone",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19890);
    try {
      let lesson = await f.start();
      lesson = (await f.answer(lesson, false)).lesson;
      const offer = f.store.get<StudyOperatorBinding>(
        "studyBinding:" + lesson.lessonId,
      )!.offer;
      const binding = f.env.KARAOKE_OPERATOR;
      f.env.KARAOKE_OPERATOR = {
        fetch: async () => {
          throw Error("fixture operator unavailable");
        },
      } as unknown as Fetcher;
      await f.abandon(lesson.lessonId);
      const terminal = await f.terminal(lesson.lessonId);
      const txCount = f.store.entries("tx:").length,
        counts = f.counts(),
        spent = f.store.get<{ spent: string }>("sponsor:ledger")!.spent;
      f.advance(STUDY_HISTORY_EXPORT_WINDOW_MS);
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        1,
      );
      f.env.KARAOKE_OPERATOR = binding;
      await communityScheduled(f.env, f.ports);
      const row = await f.db
        .prepare(
          "SELECT state,terminal_json,binding_json,source_json,receipt_json FROM study_publications WHERE lesson_id=?",
        )
        .bind(lesson.lessonId)
        .first<{
          state: string;
          terminal_json: string | null;
          binding_json: string;
          source_json: string;
          receipt_json: string;
        }>();
      assert.equal(row!.state, "private");
      assert.equal(row!.terminal_json, null);
      assert.equal(row!.binding_json, "{}");
      assert.equal(row!.source_json, "{}");
      const tombstone = await f.db
        .prepare(
          "SELECT song_json,started_at,request_id FROM study_lessons WHERE lesson_id=?",
        )
        .bind(lesson.lessonId)
        .first<{ song_json: string; started_at: number; request_id: string }>();
      assert.equal(tombstone!.song_json, "{}");
      assert.equal(tombstone!.started_at, 0);
      assert.ok(tombstone!.request_id.length);
      const receipt = JSON.parse(row!.receipt_json);
      assert.equal(receipt.commitment, zeroHash);
      assert.equal(receipt.neverSubmitted, true);
      assert.equal(receipt.privateHistoryErased, true);
      assert.equal(
        f.store.get("studyPublication:" + lesson.lessonId),
        undefined,
      );
      assert.equal(f.store.get("studyBinding:" + lesson.lessonId), undefined);
      assert.equal(
        f.store.entries("studySpeechSlot:" + lesson.lessonId + ":").length,
        0,
      );
      assert.equal(f.store.entries("studySpeech:").length, 0);
      const closed = closedStudyPublication(f.store, lesson.lessonId)!;
      for (const field of [
        "outcomes",
        "requestHash",
        "exercises",
        "result",
        "data",
      ])
        assert.ok(!JSON.stringify(closed).includes('"' + field + '"'));
      assert.equal(
        (await publishManagedStudy(f.operator, terminal)).commitment,
        zeroHash,
      );
      terminal.terminal.outcomes = (terminal.terminal.outcomes.slice(0, 6) +
        "01" +
        terminal.terminal.outcomes.slice(8)) as `0x${string}`;
      assert.equal(
        (await publishManagedStudy(f.operator, terminal)).commitment,
        zeroHash,
      );
      await assert.rejects(
        bindManagedStudy(f.operator, offer),
        /study_history_expired/,
      );
      assert.equal(f.store.entries("tx:").length, txCount);
      assert.equal(
        f.store.get<{ spent: string }>("sponsor:ledger")!.spent,
        spent,
      );
      assert.deepEqual(f.counts(), counts);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "private and failed labels cannot erase a signed unknown transaction, its binding or charged ledger",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19891);
    try {
      const lesson = await f.start();
      f.store.set("fault:crash-before-broadcast", true);
      await f.abandon(lesson.lessonId);
      const key = "studyPublication:" + lesson.lessonId,
        job = f.store.get<PublicationJob>(key)!;
      const intent = intentOf(
        f.store,
        "record_result",
        "study:" + lesson.lessonId + ":1",
      )!;
      const transaction = txRow(f.store, intent.nonce!)!;
      assert.ok(transaction.raw);
      const ledger = f.store.get("sponsor:ledger"),
        binding = f.store.get("studyBinding:" + lesson.lessonId),
        counts = f.counts();
      f.advance(STUDY_HISTORY_EXPORT_WINDOW_MS + 1000);
      for (const state of ["private", "failed"] as const) {
        // Synthetic stale status: real signed native evidence takes precedence.
        const candidate = { ...job, receipt: { ...job.receipt, state } };
        f.store.set(key, candidate);
        assert.equal(
          await eraseNeverSubmittedStudy(
            f.operatorEnv,
            f.store,
            lesson.lessonId,
            candidate,
          ),
          null,
        );
        assert.deepEqual(f.store.get(key), candidate);
        assert.equal(
          closedStudyPublication(f.store, lesson.lessonId),
          undefined,
        );
        assert.deepEqual(txRow(f.store, intent.nonce!), transaction);
        assert.deepEqual(
          f.store.get("studyBinding:" + lesson.lessonId),
          binding,
        );
        assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      }
      assert.deepEqual(f.counts(), counts);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "private erasure waits for its deadline and fresh canonical proof, then runs without a browser",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19892);
    try {
      const lesson = await f.start();
      const enrollment = f.store.get<StudyOperatorBinding>(
        "studyBinding:" + lesson.lessonId,
      )!.enrollment;
      f.advance(enrollment.expiresAt * 1000 + 1000 - f.clock());
      await f.mineClock();
      await f.get(lesson.lessonId);
      const key = "studyPublication:" + lesson.lessonId,
        job = f.store.get<PublicationJob>(key)!;
      assert.equal(job.receipt.state, "private");
      assert.equal(job.receipt.neverSubmitted, true);
      f.advance(job.privateHistoryExpiresAt - f.clock() - 1);
      assert.equal(
        await eraseNeverSubmittedStudy(
          f.operatorEnv,
          f.store,
          lesson.lessonId,
          job,
        ),
        null,
      );
      f.advance(1);
      // A synthetic queued intent has no nonce/raw bytes and still blocks erasure.
      const queuedKey = `intent:record_result:study:${lesson.lessonId}:2`;
      const queued = {
        kind: "record_result",
        ref: `study:${lesson.lessonId}:2`,
        to: f.v3,
        data: "0x",
        gas: "1",
        nonce: null,
      };
      f.store.set(queuedKey, queued);
      assert.equal(
        await eraseNeverSubmittedStudy(
          f.operatorEnv,
          f.store,
          lesson.lessonId,
          job,
        ),
        null,
      );
      assert.deepEqual(f.store.get(queuedKey), queued);
      f.store.delete(queuedKey); // Remove only this never-dispatched fixture control.
      const rpc = f.operatorEnv.RPC_URL;
      f.operatorEnv.RPC_URL = "http://127.0.0.1:9";
      await assert.rejects(
        eraseNeverSubmittedStudy(f.operatorEnv, f.store, lesson.lessonId, job),
      );
      assert.deepEqual(f.store.get(key), job);
      assert.ok(f.store.get("studyBinding:" + lesson.lessonId));
      assert.equal(closedStudyPublication(f.store, lesson.lessonId), undefined);
      f.operatorEnv.RPC_URL = rpc;
      await resumeStudyPublications(f.operatorEnv, f.store);
      assert.equal(f.store.get(key), undefined);
      assert.equal(
        closedStudyPublication(f.store, lesson.lessonId)!.receipt
          .privateHistoryErased,
        true,
      );
      await communityScheduled(f.env, f.ports);
      const row = await f.db
        .prepare(
          "SELECT terminal_json,binding_json FROM study_publications WHERE lesson_id=?",
        )
        .bind(lesson.lessonId)
        .first();
      assert.deepEqual(row, { terminal_json: null, binding_json: "{}" });
      assert.deepEqual(f.counts(), { calls: 0, observations: 0 });
    } finally {
      await f.dispose();
    }
  },
);

test(
  "a late provider completion cannot recreate an expired receipt or a deleted private attempt",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19893);
    let release = (_value: StudyTranscript) => {};
    try {
      const lesson = await f.start(),
        started = Promise.withResolvers<void>();
      f.behavior(
        () =>
          new Promise<StudyTranscript>((resolve) => {
            release = resolve;
            started.resolve();
          }),
      );
      const answering = f.answer(lesson, true).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await started.promise;
      f.advance(lesson.expiresAt + STUDY_HISTORY_EXPORT_WINDOW_MS - f.clock());
      assert.equal(
        await deleteExpiredStudyHistory(f.db, f.config.communityId, f.clock),
        1,
      );
      expireStudySpeech(f.store);
      assert.equal(f.store.entries("studySpeech:").length, 0);
      release({ text: "late private fixture words", language: "en" });
      const response = await answering;
      assert.ok("error" in response);
      assert.equal(f.store.entries("studySpeech:").length, 0);
      assert.equal(
        (await f.db
          .prepare("SELECT count(*) AS n FROM study_attempts WHERE lesson_id=?")
          .bind(lesson.lessonId)
          .first<{ n: number }>())!.n,
        0,
      );
      const row = await f.db
        .prepare("SELECT state_json FROM study_lessons WHERE lesson_id=?")
        .bind(lesson.lessonId)
        .first<{ state_json: string }>();
      assert.equal(row!.state_json, "{}");
      assert.deepEqual(f.counts(), { calls: 1, observations: 1 });
    } finally {
      release({ text: "late private fixture words", language: "en" });
      await f.dispose();
    }
  },
);
