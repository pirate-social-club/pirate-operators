import test from "node:test";
import assert from "node:assert/strict";
import { accounts } from "../harness/runtime.ts";
import { learningBindingFixture } from "./learning-binding-fixture.ts";
import {
  acceptEnrollment,
  acceptRevocation,
  activeEnrollment,
  bindEnrollment,
  correctV2,
  enrollmentRequest,
  publicationV2,
  publishV2,
  resumeEnrollments,
  revocationRequest,
  type BoundEnrollment,
} from "../services/learning-results.ts";
import {
  contractDomain,
  contractEnrollmentId,
  resultsTarget,
  retainedTarget,
  revocationKey,
} from "../services/learning-contract.ts";
import { intentOf, txRow } from "../services/operator-tx.ts";
import { submitResultTransaction } from "../services/learning-transactions.ts";
import { revocationTypes } from "../packages/protocol/learning-results.ts";
import type { Env } from "../services/runtime.ts";

test(
  "pending V2 consent, publication and revocation keep their signed destination when V3 becomes default",
  { timeout: 60000 },
  async () => {
    const f = await learningBindingFixture(19845);
    try {
      const old = await f.enrollment(2),
        id = contractEnrollmentId(old.target, old.e);
      f.store.set("fault:crash-before-broadcast", true);
      await assert.rejects(
        acceptEnrollment(f.env, f.store, old.e, old.signature),
        /simulated_crash_before_broadcast/,
      );
      const enrollIntent = intentOf(f.store, "record_enroll", id)!;
      const originalEnroll = txRow(f.store, enrollIntent.nonce!)!;
      const pendingKey = `pendingEnrollment:${old.e.learner.toLowerCase()}`;
      const legacyPending = f.store.get<Record<string, unknown>>(pendingKey)!;
      delete legacyPending.target;
      f.store.set(pendingKey, legacyPending);
      f.env.RESULTS_V3_CONTRACT = f.v3;
      f.restartJournal();
      await resumeEnrollments(f.env, f.store);
      assert.equal(
        txRow(f.store, enrollIntent.nonce!)?.raw,
        originalEnroll.raw,
      );
      assert.equal(
        txRow(f.store, enrollIntent.nonce!)?.to.toLowerCase(),
        f.v2.toLowerCase(),
      );
      assert.equal(
        txRow(f.store, enrollIntent.nonce!)?.mined?.status,
        "success",
      );
      await assert.rejects(
        activeEnrollment(f.env, old.e.learner),
        /enrollment_required/,
      );
      const request = await enrollmentRequest(
        f.env,
        old.e.learner,
        f.store.now(),
      );
      assert.equal(request.domain.version, "3");
      assert.equal(request.message.activities, "3");
      // The old signature is not accepted at the new default and creates no new intent.
      const beforeIntents = f.store.entries("intent:").length;
      await assert.rejects(
        acceptEnrollment(f.env, f.store, old.e, old.signature),
      );
      assert.equal(f.store.entries("intent:").length, beforeIntents);
      f.env.RESULTS_V3_CONTRACT = undefined;
      const pendingTake = await f.prepare("legacy-unpublished-take");
      const bound = f.store.get<BoundEnrollment>(
        `enrollment:${pendingTake.ticket.ticketId}`,
      )!;
      delete bound.target;
      delete bound.activities;
      f.store.set(`enrollment:${pendingTake.ticket.ticketId}`, bound);
      const result = await f.finish(pendingTake);
      f.store.set("fault:crash-before-broadcast", true);
      await assert.rejects(
        publishV2(f.env, f.store, pendingTake.ticket.ticketId),
        /simulated_crash_before_broadcast/,
      );
      const resultRef = `${pendingTake.ticket.ticketId}:1`,
        resultIntent = intentOf(f.store, "record_result", resultRef)!;
      const originalResult = txRow(f.store, resultIntent.nonce!)!;
      const work = f.store.get<Record<string, unknown>>(`workV2:${resultRef}`)!;
      delete work.target;
      f.store.set(`workV2:${resultRef}`, work);
      const ledger = f.store.get("sponsor:ledger");
      f.env.RESULTS_V3_CONTRACT = f.v3;
      f.restartJournal();
      await publishV2(f.env, f.store, pendingTake.ticket.ticketId);
      assert.equal(
        publicationV2(f.store, pendingTake.ticket.ticketId)?.state,
        "published",
      );
      assert.equal(
        txRow(f.store, resultIntent.nonce!)?.raw,
        originalResult.raw,
      );
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      assert.notEqual(
        await f.evm.read(f.v2, "LearningResultsV2", "commitments", [
          result.attemptId,
        ]),
        f.zeroHash,
      );
      assert.equal(
        await f.evm.read(f.v3, "LearningResultsV3", "commitments", [
          result.attemptId,
        ]),
        f.zeroHash,
      );
      await bindEnrollment(
        f.env,
        f.store,
        pendingTake.ticket.ticketId,
        old.e.learner,
      );
      assert.equal(
        f.store.get<BoundEnrollment>(
          `enrollment:${pendingTake.ticket.ticketId}`,
        )?.target?.version,
        2,
      );
      const next = await f.enrollment(3);
      await acceptEnrollment(f.env, f.store, next.e, next.signature);
      const newTake = await f.prepare("successor-take"),
        newResult = await f.finish(newTake);
      await publishV2(f.env, f.store, newTake.ticket.ticketId);
      assert.equal(
        publicationV2(f.store, newTake.ticket.ticketId)?.state,
        "published",
      );
      assert.notEqual(
        await f.evm.read(f.v3, "LearningResultsV3", "commitments", [
          newResult.attemptId,
        ]),
        f.zeroHash,
      );
      assert.equal(
        await f.evm.read(f.v2, "LearningResultsV2", "commitments", [
          newResult.attemptId,
        ]),
        f.zeroHash,
      );
      await correctV2(f.env, f.store, {
        ticketId: pendingTake.ticket.ticketId,
        lineId: pendingTake.manifest.lines[0].lineId,
        status: "assessed",
        scoreBps: 0,
      });
      await publishV2(f.env, f.store, pendingTake.ticket.ticketId);
      assert.equal(
        intentOf(
          f.store,
          "record_result",
          `${pendingTake.ticket.ticketId}:2`,
        )?.to.toLowerCase(),
        f.v2.toLowerCase(),
      );
      assert.equal(
        publicationV2(f.store, pendingTake.ticket.ticketId)?.revision,
        2,
      );
      const revoke = { learner: old.e.learner, nonce: 1n };
      const signature = await accounts[5].signTypedData({
        domain: contractDomain(old.target),
        types: revocationTypes,
        primaryType: "Revocation",
        message: revoke,
      });
      f.store.set("fault:crash-before-broadcast", true);
      await assert.rejects(
        acceptRevocation(
          f.env,
          f.store,
          revoke.learner,
          revoke.nonce,
          signature,
          old.target,
        ),
        /simulated_crash_before_broadcast/,
      );
      const revokeJobKey = revocationKey(
        old.target,
        revoke.learner,
        revoke.nonce,
      );
      const revokeJob = f.store.get<Record<string, unknown>>(revokeJobKey)!;
      delete revokeJob.target;
      f.store.set(revokeJobKey, revokeJob);
      const revokeIntent = intentOf(f.store, "record_revoke", id)!;
      const raw = txRow(f.store, revokeIntent.nonce!)!.raw;
      f.restartJournal();
      await resumeEnrollments(f.env, f.store);
      assert.equal(txRow(f.store, revokeIntent.nonce!)?.raw, raw);
      assert.equal(
        txRow(f.store, revokeIntent.nonce!)?.mined?.status,
        "success",
      );
      await assert.rejects(
        activeEnrollment(f.env, old.e.learner, old.target),
        /enrollment_required/,
      );
      assert.equal(
        (await activeEnrollment(f.env, next.e.learner)).target?.version,
        3,
      );
      assert.equal(
        (await revocationRequest(f.env, next.e.learner)).domain.version,
        "3",
      );
    } finally {
      await f.stop();
    }
  },
);

test(
  "configured target drift and changed queued bytes fail before a new charge or transaction",
  { timeout: 60000 },
  async () => {
    const f = await learningBindingFixture(19846);
    try {
      const e = await f.enrollment(2);
      await acceptEnrollment(f.env, f.store, e.e, e.signature);
      const take = await f.prepare("target-drift-take");
      await f.finish(take);
      const before = f.store.entries("");
      const changed = { ...f.env, RESULTS_V2_CONTRACT: f.v3 };
      await assert.rejects(
        publishV2(changed, f.store, take.ticket.ticketId),
        /results_target_changed/,
      );
      assert.deepEqual(f.store.entries(""), before);
      const bound = f.store.get<BoundEnrollment>(
        `enrollment:${take.ticket.ticketId}`,
      )!;
      delete bound.target;
      f.store.set(`enrollment:${take.ticket.ticketId}`, bound);
      await assert.rejects(
        publishV2(changed, f.store, take.ticket.ticketId),
        /results_target_changed/,
      );
      const intent = intentOf(
        f.store,
        "record_enroll",
        contractEnrollmentId(e.target, e.e),
      )!;
      const ledger = f.store.get("sponsor:ledger");
      await assert.rejects(
        submitResultTransaction(
          f.env,
          f.store,
          "record_enroll",
          intent.ref,
          intent.data,
          f.v3,
        ),
        /result_transaction_changed/,
      );
      await assert.rejects(
        submitResultTransaction(
          f.env,
          f.store,
          "record_enroll",
          intent.ref,
          "0x1234",
          f.v2,
        ),
        /result_transaction_changed/,
      );
      assert.deepEqual(f.store.get("sponsor:ledger"), ledger);
      assert.throws(
        () => resultsTarget({ ...f.env, PAYMENT_CHAIN_ID: "1" }),
        /unsupported_results_chain/,
      );
      assert.throws(
        () =>
          retainedTarget({ ...f.env, RESULTS_V3_CONTRACT: f.v3 }, {
            ...e.target,
            version: 4,
          } as never),
        /unsupported_results_version/,
      );
      assert.throws(
        () => retainedTarget(f.env, { ...e.target, chainId: 6343 }),
        /results_target_changed/,
      );
    } finally {
      await f.stop();
    }
  },
);
