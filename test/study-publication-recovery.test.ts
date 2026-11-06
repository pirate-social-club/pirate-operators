import test from "node:test";
import assert from "node:assert/strict";
import { zeroHash } from "viem";
import { accounts } from "../harness/runtime.ts";
import { studyPublicationFixture } from "./study-publication-fixture.ts";
import { communityScheduled } from "../services/community-application.ts";
import { intentOf, txRow } from "../services/operator-tx.ts";
import { publishManagedStudy } from "../services/study-operator-client.ts";
import { resumeStudyPublication } from "../services/study-publication.ts";
import {
  resumeStudyPublications,
  studyPublicationAlarm,
  recoverLearningTransactions,
} from "../services/study-publication-recovery.ts";
import {
  acceptRevocation,
  revocationRequest,
} from "../services/learning-enrollment.ts";
import { resultsTarget } from "../services/learning-contract.ts";
import { revocationTypes } from "../packages/protocol/learning-results-v3.ts";
import { StudySpeechError } from "../packages/study/speech-transcriber.ts";

test(
  "a pre-broadcast crash, altered retry and lost terminal response retain one signed Study intent",
  { timeout: 90000 },
  async () => {
    const f = await studyPublicationFixture(19872);
    try {
      let lesson = await f.start();
      lesson = (await f.answer(lesson, false)).lesson;
      f.store.set("fault:crash-before-broadcast", true);
      await f.abandon(lesson.lessonId);
      assert.equal((await f.publication(lesson.lessonId)).state, "pending");
      const ref = "study:" + lesson.lessonId + ":1";
      const intent = intentOf(f.store, "record_result", ref)!;
      const row = txRow(f.store, intent.nonce!)!;
      assert.ok(row.raw);
      assert.equal(row.mined, null);
      const ledger = f.store.get("sponsor:ledger");
      const changed = await f.terminal(lesson.lessonId);
      changed.terminal.outcomes = (changed.terminal.outcomes.slice(0, 6) +
        "01" +
        changed.terminal.outcomes.slice(8)) as `0x${string}`;
      await assert.rejects(
        publishManagedStudy(f.operator, changed),
        /study_terminal_changed/,
      );
      const target = f.operatorEnv.RESULTS_V3_CONTRACT;
      f.operatorEnv.RESULTS_V3_CONTRACT = f.v2;
      await assert.rejects(
        resumeStudyPublication(f.operatorEnv, f.store, lesson.lessonId),
        /results_target_changed/,
      );
      f.operatorEnv.RESULTS_V3_CONTRACT = target;
      f.store.set("intent:record_result:" + ref, { ...intent, data: "0x00" });
      await assert.rejects(
        resumeStudyPublication(f.operatorEnv, f.store, lesson.lessonId),
        /result_transaction_changed/,
      );
      f.store.set("intent:record_result:" + ref, intent);
      f.restartJournal();
      assert.ok(studyPublicationAlarm(f.store).some(Number.isFinite));
      await resumeStudyPublications(f.operatorEnv, f.store);
      f.lose("/study/terminal");
      await communityScheduled(f.env, f.ports);
      assert.equal((await f.publication(lesson.lessonId)).state, "pending");
      await communityScheduled(f.env, f.ports);
      const saved = await f.publication(lesson.lessonId);
      assert.equal(saved.state, "published");
      assert.equal(saved.receipt!.transactionHash, row.hash);
      assert.equal(txRow(f.store, intent.nonce!)!.raw, row.raw);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      assert.equal(f.store.entries("intent:record_result:study:").length, 1);
      const [read] = await f.readResults();
      assert.equal(read.verified, true, JSON.stringify(read.problems));
      assert.equal(read.result.status, 2);
      if (read.assessment?.activity !== 2)
        throw Error("missing Study assessment");
      assert.equal(read.assessment.outcomes[0].status, "incorrect");
      assert.ok(
        read.assessment.outcomes
          .slice(1)
          .every((x) => x.status === "unattempted"),
      );
    } finally {
      await f.dispose();
    }
  },
);

test(
  "scheduled recovery closes an unattended Study at its original deadline and publishes unmeasured absence",
  { timeout: 60000 },
  async () => {
    const f = await studyPublicationFixture(19873);
    try {
      const lesson = await f.start();
      f.behavior(async () => {
        throw new StudySpeechError("speech_timeout", "unknown");
      });
      await f.answer(lesson, true);
      f.advance(3600001);
      await f.mineClock();
      await communityScheduled(f.env, f.ports);
      const closed = await f.get(lesson.lessonId);
      assert.equal(closed.status, "expired");
      assert.equal(closed.completedAt, lesson.expiresAt);
      assert.equal(closed.progress.firstPassGraded, 0);
      assert.equal((await f.publication(lesson.lessonId)).state, "published");
      const [read] = await f.readResults();
      assert.equal(read.verified, true, JSON.stringify(read.problems));
      assert.equal(read.result.status, 3);
      assert.equal(
        read.result.completedAt,
        BigInt(Math.floor(lesson.expiresAt / 1000)),
      );
      if (read.assessment?.activity !== 2)
        throw Error("missing Study assessment");
      assert.equal(read.assessment.outcomes[0].status, "unmeasured");
      assert.ok(
        read.assessment.outcomes
          .slice(1)
          .every((x) => x.status === "unattempted"),
      );
      assert.deepEqual(f.counts(), { calls: 1, observations: 1 });
    } finally {
      await f.dispose();
    }
  },
);

test(
  "revoked Study stays private without a new transaction and unbound drafts expire without acquiring authority",
  { timeout: 60000 },
  async () => {
    const f = await studyPublicationFixture(19874);
    try {
      const lesson = await f.start();
      const target = resultsTarget(f.operatorEnv, 3);
      const request = await revocationRequest(
        f.operatorEnv,
        accounts[5].address,
        target,
      );
      const message = {
        learner: accounts[5].address,
        nonce: BigInt(request.message.nonce),
      };
      const signature = await accounts[5].signTypedData({
        domain: request.domain,
        primaryType: "Revocation",
        types: revocationTypes,
        message,
      });
      await acceptRevocation(
        f.operatorEnv,
        f.store,
        accounts[5].address,
        message.nonce,
        signature,
        target,
      );
      const count = f.store.entries("tx:").length;
      const before = f.store.get<{ spent: string; reserved: string }>(
        "sponsor:ledger",
      )!;
      await f.abandon(lesson.lessonId);
      const receipt = (await f.publication(lesson.lessonId)).receipt!;
      assert.equal(receipt.state, "private");
      assert.equal(receipt.reason, "enrollment_inactive");
      assert.equal(f.store.entries("tx:").length, count);
      assert.equal(
        await f.evm.read(f.v3, "LearningResultsV3", "commitments", [
          receipt.sessionId,
        ]),
        zeroHash,
      );
      const after = f.store.get<{ spent: string; reserved: string }>(
        "sponsor:ledger",
      )!;
      assert.equal(after.spent, before.spent);
      assert.ok(BigInt(after.reserved) < BigInt(before.reserved));
      const other = await f.login(6);
      assert.equal(
        (
          await f.post(
            "/api/study/lessons",
            { requestId: crypto.randomUUID(), song: f.song },
            other,
          )
        ).status,
        503,
      );
      f.advance(3600001);
      await f.mineClock();
      await communityScheduled(f.env, f.ports);
      const draft = await f.db
        .prepare(
          "SELECT l.state_json FROM study_lessons l LEFT JOIN study_publications p USING(lesson_id) WHERE p.lesson_id IS NULL",
        )
        .first<{ state_json: string }>();
      assert.equal(JSON.parse(draft!.state_json).status, "expired");
      assert.equal(f.store.entries("tx:").length, count);
      assert.deepEqual(f.counts(), { calls: 0, observations: 0 });
    } finally {
      await f.dispose();
    }
  },
);

test(
  "canonical loss of a published Study reuses the original signed bytes and charge",
  { timeout: 60000 },
  async () => {
    const f = await studyPublicationFixture(19875);
    try {
      const lesson = await f.start();
      const snapshot = await f.evm.rpc("evm_snapshot", []);
      await f.abandon(lesson.lessonId);
      const first = (await f.publication(lesson.lessonId)).receipt!;
      assert.equal(first.state, "published");
      const intent = intentOf(
        f.store,
        "record_result",
        "study:" + lesson.lessonId + ":1",
      )!;
      const row = txRow(f.store, intent.nonce!)!;
      const ledger = f.store.get("sponsor:ledger");
      assert.equal(await f.evm.rpc("evm_revert", [snapshot]), true);
      f.restartJournal();
      const recovered = await resumeStudyPublication(
        f.operatorEnv,
        f.store,
        lesson.lessonId,
      );
      assert.equal(recovered.state, "published");
      assert.equal(recovered.transactionHash, first.transactionHash);
      assert.equal(txRow(f.store, intent.nonce!)!.raw, row.raw);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      assert.equal((await f.readResults()).length, 1);
    } finally {
      await f.dispose();
    }
  },
);

test(
  "general recovery cannot broadcast a retained Study transaction before chain time catches up",
  { timeout: 60000 },
  async () => {
    const f = await studyPublicationFixture(19877);
    try {
      const lesson = await f.start();
      const snapshot = await f.evm.rpc("evm_snapshot", []);
      f.advance(5000);
      await f.mineClock();
      f.store.set("fault:crash-before-broadcast", true);
      await f.abandon(lesson.lessonId);
      const intent = intentOf(
        f.store,
        "record_result",
        "study:" + lesson.lessonId + ":1",
      )!;
      const row = txRow(f.store, intent.nonce!)!;
      assert.ok(row.raw);
      const ledger = f.store.get("sponsor:ledger");
      await f.evm.rpc("evm_revert", [snapshot]);
      await recoverLearningTransactions(f.operatorEnv, f.store);
      assert.equal(txRow(f.store, intent.nonce!)!.mined, null);
      assert.equal(
        await f.evm.rpc("eth_getTransactionReceipt", [row.hash]),
        null,
      );
      assert.equal(txRow(f.store, intent.nonce!)!.raw, row.raw);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      await f.mineClock();
      await recoverLearningTransactions(f.operatorEnv, f.store);
      assert.equal(txRow(f.store, intent.nonce!)!.mined!.status, "success");
      assert.equal(txRow(f.store, intent.nonce!)!.raw, row.raw);
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
    } finally {
      await f.dispose();
    }
  },
);
