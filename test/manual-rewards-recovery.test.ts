import { test } from "node:test";
import assert from "node:assert/strict";
import {
  manualRewardsFixture,
  rewardHash,
  rewardTestProfile,
} from "./manual-rewards-fixture.ts";

async function ready() {
  const f = await manualRewardsFixture();
  try {
    const [learner] = f.principals;
    await f.settle("offer_0001", "1");
    const intent = await f.claims.intent(learner);
    f.subjects.set("provider_1", "77");
    await f.claims.readIntent(learner, intent.intent_id);
    await f.claims.claim(
      learner,
      (await f.store.credits(learner.accountId))[0].credit_id,
    );
    const hash = rewardHash(200);
    f.transfers.set(hash, {
      ...f.receipt(hash, rewardTestProfile.payoutWallet, "2000000"),
      blockNumber: "90",
      sender: `0x${"77".repeat(20)}`,
    });
    await f.payments.fund("funding_001", hash, 2, {
      kind: "prefunding",
      sourceUsdcAtomic: "0",
      sourceTransactionHash: null,
      feeUsdcAtomic: "0",
    });
    return {
      f,
      learner,
      payment: await f.payments.prepare("payment_001", learner.accountId),
    };
  } catch (error) {
    await f.dispose();
    throw error;
  }
}

test("declines, errors and unknown results preserve reservations; explicit retries retain the same guard and all attempt hashes", async () => {
  const { f, learner, payment } = await ready();
  try {
    for (const [i, outcome] of ["cancelled", "error", "unknown"].entries()) {
      const id = `attempt_00${i}`;
      const dispatch = await f.payments.dispatch(payment.paymentId, "pay", id);
      assert.equal(dispatch.guardNonce, payment.guardNonce);
      assert.equal(
        (
          await f.payments.outcome(
            payment.paymentId,
            id,
            outcome as "cancelled" | "error" | "unknown",
          )
        ).state,
        "review_required",
      );
      await assert.rejects(
        f.payments.cancelPrepared(payment.paymentId),
        /needs_reconciliation/,
      );
      await assert.rejects(
        f.payments.prepare("payment_002", learner.accountId),
        /account_busy/,
      );
    }
    await f.payments.dispatch(payment.paymentId, "pay", "attempt_003");
    await f.payments.attach(payment.paymentId, rewardHash(203), "attempt_003");
    await f.payments.dispatch(payment.paymentId, "pay", "attempt_004");
    // The oldest unknown attempt wins; the newer callback's hash is not substituted for the actual receipt.
    f.guard(payment, rewardHash(202), [
      f.receipt(rewardHash(202), learner.wallet, payment.amountAtomic),
    ]);
    const result = await f.payments.reconcile(payment.paymentId);
    assert.equal(result.state, "confirmed");
    assert.equal(result.transactionHash, rewardHash(202));
    assert.equal(result.attempts.length, 5);
    assert.equal(
      result.attempts.find((a) => a.attemptId === "attempt_003")
        ?.transactionHash,
      rewardHash(203),
    );
    await f.payments.outcome(payment.paymentId, "attempt_004", "cancelled");
    assert.equal(
      (await f.payments.reconcile(payment.paymentId)).state,
      "confirmed",
    );
    const inventory = await f.store
      .statement("SELECT reserved_atomic,paid_atomic FROM reward_inventory")
      .first();
    assert.deepEqual(inventory, {
      reserved_atomic: "0",
      paid_atomic: payment.amountAtomic,
    });
    await assert.rejects(
      f.payments.dispatch(payment.paymentId, "pay", "attempt_005"),
      /already_resolved/,
    );
  } finally {
    await f.dispose();
  }
});

test("only a consumed on-chain guard releases a postdispatch cancellation, even after a lost cancellation callback", async () => {
  const { f, learner, payment } = await ready();
  try {
    await f.payments.dispatch(payment.paymentId, "pay", "attempt_001");
    await f.payments.outcome(payment.paymentId, "attempt_001", "unknown");
    await f.payments.dispatch(payment.paymentId, "cancel", "attempt_002");
    await f.payments.outcome(payment.paymentId, "attempt_002", "cancelled");
    assert.equal(
      (await f.store.credits(learner.accountId))[0].payment_id,
      payment.paymentId,
    );
    assert.equal(
      (await f.store.credits(learner.accountId))[0].paid_atomic,
      "0",
    );
    f.guard(payment, rewardHash(210));
    const result = await f.payments.reconcile(payment.paymentId);
    assert.equal(result.state, "cancelled");
    assert.equal(result.transactionHash, rewardHash(210));
    assert.equal(
      (await f.store.credits(learner.accountId))[0].payment_id,
      null,
    );
    assert.equal(
      (await f.store.credits(learner.accountId))[0].paid_atomic,
      "0",
    );
    await f.payments.outcome(
      payment.paymentId,
      "attempt_001",
      "approved",
      rewardHash(211),
    );
    const next = await f.payments.prepare("payment_002", learner.accountId);
    assert.notEqual(next.guardNonce, payment.guardNonce);
    assert.equal(next.amountAtomic, payment.amountAtomic);
  } finally {
    await f.dispose();
  }
});

test("a payment winning the cancellation race is paid once; ambiguous or malformed guard receipts cannot release money", async () => {
  const { f, learner, payment } = await ready();
  try {
    await f.payments.dispatch(payment.paymentId, "pay", "attempt_001");
    await f.payments.dispatch(payment.paymentId, "cancel", "attempt_002");
    const hash = rewardHash(220),
      row = f.receipt(hash, learner.wallet, payment.amountAtomic);
    const proof = f.guard(payment, hash, [row]);
    for (const patch of [
      { transfers: [row, { ...row, logIndex: 3 }] },
      { transfers: [{ ...row, amountAtomic: "1" }] },
      { transfers: [{ ...row, logIndex: 0 }] },
      { nonce: "0" },
      { implementation: rewardTestProfile.token },
      { blockNumber: "100" },
    ]) {
      f.guards.set(payment.guardNonce, { ...proof, ...patch });
      await assert.rejects(
        f.payments.reconcile(payment.paymentId),
        /reward_(payment|guard)_receipt_mismatch/,
      );
      assert.equal(
        (await f.store.credits(learner.accountId))[0].payment_id,
        payment.paymentId,
      );
    }
    f.guards.set(payment.guardNonce, proof);
    const results = await Promise.all([
      f.payments.reconcile(payment.paymentId),
      f.payments.outcome(payment.paymentId, "attempt_002", "error"),
    ]);
    assert.ok(results.every((r) => r.state === "confirmed"));
    assert.equal(
      (await f.store.credits(learner.accountId))[0].paid_atomic,
      payment.amountAtomic,
    );
    assert.equal(
      (
        await f.store
          .statement("SELECT paid_atomic FROM reward_inventory")
          .first()
      )?.paid_atomic,
      payment.amountAtomic,
    );
  } finally {
    await f.dispose();
  }
});

test("an invariant that fails on a torn read is retried after another batch commits, and stands otherwise", async () => {
  const f = await manualRewardsFixture();
  try {
    let calls = 0;
    const value = await f.store.atomic(async () => {
      calls++;
      if (calls === 1) {
        // Another writer commits between this build's reads.
        await f.store.atomic(async () => ({ value: null, statements: [] }));
        throw new Error("reward_reservation_corrupt");
      }
      return { value: "retried", statements: [] };
    });
    assert.equal(value, "retried");
    assert.equal(calls, 2);
    let stable = 0;
    await assert.rejects(
      f.store.atomic(async () => {
        stable++;
        throw new Error("reward_reservation_corrupt");
      }),
      /reward_reservation_corrupt/,
    );
    assert.equal(stable, 1);
    // Under sustained contention the invariant itself is reported.
    let contended = 0;
    await assert.rejects(
      f.store.atomic(async () => {
        contended++;
        await f.store.atomic(async () => ({ value: null, statements: [] }));
        throw new Error("reward_reservation_corrupt");
      }),
      /reward_reservation_corrupt/,
    );
    assert.equal(contended, 8);
  } finally {
    await f.dispose();
  }
});
