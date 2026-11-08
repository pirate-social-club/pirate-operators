import { test } from "node:test";
import assert from "node:assert/strict";
import {
  manualRewardsFixture,
  rewardHash,
  rewardTestProfile,
} from "./manual-rewards-fixture.ts";
import {
  rewardProgramScope,
  rewardProfile,
} from "../packages/rewards/validation.ts";
import { RewardTreasury } from "../packages/rewards/treasury.ts";

test("daily credits remain held until verified; several credits reconcile to one exact payment", async () => {
  const f = await manualRewardsFixture();
  try {
    const [a, b] = f.principals;
    await f.settle("offer_0001", "1");
    f.setPrize("120000");
    await f.settle("offer_0002", "2");
    const credits = await f.store.credits(a.accountId);
    assert.equal(credits.length, 2);
    assert.equal(
      credits.reduce((s, c) => s + BigInt(c.amount_atomic), 0n),
      615000n,
    );
    assert.equal(
      (await f.claims.claim(a, credits[0].credit_id)).outcome,
      "verification_missing",
    );
    await assert.rejects(
      f.claims.claim(b, credits[0].credit_id),
      /reward_credit_not_found/,
    );
    const intent = await f.claims.intent(a);
    assert.equal(f.openings(), 1);
    assert.equal((await f.claims.intent(a)).intent_id, intent.intent_id);
    f.subjects.set("provider_1", "77");
    assert.equal(
      (await f.claims.readIntent(a, intent.intent_id)).state,
      "verified",
    );
    for (const c of credits) {
      assert.equal((await f.claims.claim(a, c.credit_id)).outcome, "accepted");
      assert.equal((await f.claims.claim(a, c.credit_id)).outcome, "accepted");
    }
    await assert.rejects(
      f.payments.prepare("payment_001", a.accountId),
      /reward_reserve_not_funded/,
    );
    const fundingHash = rewardHash(200);
    f.transfers.set(fundingHash, {
      ...f.receipt(fundingHash, rewardTestProfile.payoutWallet, "2000000"),
      blockNumber: "90",
      sender: `0x${"77".repeat(20)}`,
    });
    await f.payments.fund("funding_001", fundingHash, 2, {
      kind: "prefunding",
      sourceUsdcAtomic: "0",
      sourceTransactionHash: null,
      feeUsdcAtomic: "0",
    });
    const prepared = await f.payments.prepare("payment_001", a.accountId);
    assert.equal(prepared.amountAtomic, "615000");
    assert.equal(prepared.creditIds.length, 2);
    await assert.rejects(
      f.payments.prepare("payment_002", a.accountId),
      /reward_payout_account_busy/,
    );
    const cancelled = await f.payments.cancelPrepared(prepared.paymentId);
    assert.equal(cancelled.creditIds.length, 2);
    const payment = await f.payments.prepare("payment_003", a.accountId);
    await f.payments.dispatch(payment.paymentId, "pay", "attempt_001");
    await f.payments.dispatch(payment.paymentId, "pay", "attempt_001");
    assert.equal(
      (await f.store.paymentView(await f.store.payment(payment.paymentId)))
        .attempts.length,
      1,
    );
    await assert.rejects(
      f.payments.cancelPrepared(payment.paymentId),
      /reward_payment_cancellation_needs_reconciliation/,
    );
    const hash = rewardHash(201);
    await assert.rejects(
      f.payments.recover(payment.paymentId, rewardHash(202)),
      /reward_recovery_guard_not_confirmed/,
    );
    assert.equal(
      (await f.store.payment(payment.paymentId)).transaction_hash,
      null,
    );
    await f.payments.attach(payment.paymentId, hash, "attempt_001");
    assert.equal(
      (await f.payments.reconcile(payment.paymentId)).state,
      "submitted",
    );
    f.guard(payment, hash, [f.receipt(hash, a.wallet, "1")]);
    await assert.rejects(
      f.payments.reconcile(payment.paymentId),
      /reward_payment_receipt_mismatch/,
    );
    f.guard(payment, hash, [f.receipt(hash, a.wallet, payment.amountAtomic)]);
    assert.equal(
      (await f.payments.reconcile(payment.paymentId)).state,
      "confirmed",
    );
    await f.payments.reconcile(payment.paymentId);
    const paid = await f.store.credits(a.accountId);
    assert.ok(paid.every((c) => c.paid_atomic === c.amount_atomic));
    assert.equal(
      (await f.store.credits(b.accountId)).reduce(
        (s, c) => s + BigInt(c.paid_atomic),
        0n,
      ),
      0n,
    );
  } finally {
    await f.dispose();
  }
});

test("unmatched outgoing transfers stop new payments; exact operator cost records debit inventory once", async () => {
  const f = await manualRewardsFixture();
  try {
    const [a] = f.principals;
    await f.settle("offer_0001", "1");
    const intent = await f.claims.intent(a);
    f.subjects.set("provider_1", "77");
    await f.claims.readIntent(a, intent.intent_id);
    await f.claims.claim(a, (await f.store.credits(a.accountId))[0].credit_id);
    const fundingHash = rewardHash(210);
    f.transfers.set(fundingHash, {
      ...f.receipt(fundingHash, rewardTestProfile.payoutWallet, "2000000"),
      blockNumber: "90",
      sender: `0x${"77".repeat(20)}`,
    });
    await f.payments.fund("funding_001", fundingHash, 2, {
      kind: "prefunding",
      sourceUsdcAtomic: "0",
      sourceTransactionHash: null,
      feeUsdcAtomic: "0",
    });
    const expenseHash = rewardHash(211);
    f.transfers.set(expenseHash, {
      ...f.receipt(expenseHash, `0x${"88".repeat(20)}`, "1000"),
      blockNumber: "95",
    });
    await assert.rejects(
      f.payments.prepare("payment_001", a.accountId),
      /reward_unmatched_outgoing/,
    );
    const treasury = new RewardTreasury(f.store, f.chain);
    assert.equal((await treasury.unmatched()).length, 1);
    await treasury.cost("cost_0001", expenseHash, 2);
    await treasury.cost("cost_0001", expenseHash, 2);
    assert.equal((await treasury.unmatched()).length, 0);
    assert.equal(
      (
        await f.store
          .statement("SELECT cost_atomic FROM reward_inventory")
          .first<{ cost_atomic: string }>()
      )?.cost_atomic,
      "1000",
    );
    const payment = await f.payments.prepare("payment_001", a.accountId);
    await f.payments.dispatch(payment.paymentId, "pay", "attempt_001");
    const hash = rewardHash(212);
    f.guard(payment, hash, [f.receipt(hash, a.wallet, payment.amountAtomic)]);
    f.setPosition("101");
    await treasury.audit();
    await assert.rejects(
      treasury.cost("cost_0002", hash, 2),
      /reward_cost_matches_payment/,
    );
    await f.payments.attach(payment.paymentId, hash, "attempt_001");
    await f.payments.reconcile(payment.paymentId);
    assert.equal((await treasury.unmatched()).length, 0);
  } finally {
    await f.dispose();
  }
});

test("one program subject cannot claim another account's allocations; held money is not recycled", async () => {
  const f = await manualRewardsFixture();
  try {
    const [a, b] = f.principals;
    await f.settle("offer_0001", "1");
    for (const [index, p] of [a, b].entries()) {
      const intent = await f.claims.intent(p);
      f.subjects.set(`provider_${index + 1}`, "123");
      const view = await f.claims.readIntent(p, intent.intent_id);
      assert.equal(view.state, index === 0 ? "verified" : "subject_conflict");
    }
    const row = (await f.store.credits(b.accountId))[0];
    assert.equal(
      (await f.claims.claim(b, row.credit_id)).outcome,
      "subject_conflict",
    );
    assert.equal(row.amount_atomic, "555000");
    assert.equal(row.paid_atomic, "0");
    const held = await f.claims.intent(a);
    f.setNow(held.expires_at + 1);
    await f.claims.expire();
    const expired = await f.store
      .statement(
        "SELECT key_hex,launch_url,state FROM reward_verification_intents WHERE intent_id=?",
        held.intent_id,
      )
      .first<{ key_hex: string; launch_url: string; state: string }>();
    assert.equal(expired?.key_hex, "");
    assert.equal(expired?.launch_url, "");
    assert.equal(expired?.state, "expired");
  } finally {
    await f.dispose();
  }
});

test("offer windows, duplicate tickets, zero prizes and indivisible remainders preserve accounting", async () => {
  const f = await manualRewardsFixture();
  try {
    const [a, b] = f.principals;
    const input = await f.offer("offer_0001", "1");
    await assert.rejects(
      f.offers.close(input.offerId),
      /reward_cutoff_not_reached/,
    );
    await assert.rejects(
      f.offers.attach({
        ...input,
        offerId: "offer_0002",
        songKey: rewardHash(501),
      }),
      /UNIQUE constraint/,
    );
    f.setCandidates(
      [a, b, a].map((p, i) => ({
        ...p,
        evidenceHash: rewardHash(600 + i),
        completedAt: input.opensAt + 1000,
      })),
    );
    f.setNow(input.cutoffAt);
    f.setPrize("1110001");
    const closed = await f.offers.close(input.offerId);
    assert.equal(closed.entries?.length, 2);
    const settled = await f.offers.settle(input.offerId);
    assert.equal(settled.remainderAtomic, "1");
    assert.equal((await f.offers.attach(input)).state, "settled");
    await f.offers.settle(input.offerId);
    assert.equal((await f.store.credits(a.accountId)).length, 1);
    f.setPrize("0");
    const loss = await f.settle("offer_0003", "3");
    assert.equal((await f.offers.settle(loss.offerId)).state, "no_prize");
    assert.equal((await f.store.credits(a.accountId)).length, 1);
  } finally {
    await f.dispose();
  }
});

test("program scope is stable across claims and profile rejects unsupported networks", () => {
  const scope = rewardProgramScope(rewardTestProfile.programId);
  assert.equal(
    scope.externalNullifier,
    rewardProgramScope(rewardTestProfile.programId).externalNullifier,
  );
  assert.notEqual(scope.scope, rewardProgramScope(rewardHash(5)).scope);
  assert.throws(
    () =>
      rewardProfile(JSON.stringify({ ...rewardTestProfile, chainId: 84532 })),
    /rewards_profile_invalid/,
  );
  assert.deepEqual(
    rewardProfile(JSON.stringify(rewardTestProfile)),
    rewardTestProfile,
  );
});

test("racing payment preparations reserve the learner's credits exactly once", async () => {
  const f = await manualRewardsFixture();
  try {
    const [a] = f.principals;
    await f.settle("offer_0001", "1");
    const intent = await f.claims.intent(a);
    f.subjects.set("provider_1", "77");
    await f.claims.readIntent(a, intent.intent_id);
    await f.claims.claim(a, (await f.store.credits(a.accountId))[0].credit_id);
    const hash = rewardHash(220);
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
    const outcomes = await Promise.allSettled([
      f.payments.prepare("payment_001", a.accountId),
      f.payments.prepare("payment_002", a.accountId),
    ]);
    const wins = outcomes.filter((r) => r.status === "fulfilled");
    assert.equal(wins.length, 1);
    const paid = wins[0];
    assert.equal(paid.status, "fulfilled");
    if (paid.status !== "fulfilled") throw Error("missing result");
    assert.equal(
      (
        await f.store
          .statement("SELECT reserved_atomic FROM reward_inventory")
          .first<{ reserved_atomic: string }>()
      )?.reserved_atomic,
      paid.value.amountAtomic,
    );
    await f.payments.cancelPrepared(paid.value.paymentId);
    assert.equal(
      (
        await f.store
          .statement("SELECT reserved_atomic FROM reward_inventory")
          .first<{ reserved_atomic: string }>()
      )?.reserved_atomic,
      "0",
    );
    assert.equal((await f.store.credits(a.accountId))[0].payment_id, null);
  } finally {
    await f.dispose();
  }
});

test("any signed-in account earns without operator approval, but only from its own MOSS wallet", async () => {
  const f = await manualRewardsFixture();
  try {
    const [a, b] = f.principals;
    const open = await f.offer("offer_open_01", "7");
    f.setCandidates([
      {
        ...a,
        evidenceHash: rewardHash(700),
        completedAt: open.opensAt + 1000,
      },
    ]);
    f.setNow(open.cutoffAt);
    const closed = await f.offers.close("offer_open_01");
    assert.deepEqual(
      closed.entries!.map((e) => e.accountId),
      [a.accountId],
    );
    const approvals = await f.db
      .prepare("SELECT count(*) AS n FROM reward_participants")
      .first<{ n: number }>();
    assert.equal(approvals!.n, 0);
    const foreign = await f.offer("offer_open_02", "8");
    f.setCandidates([
      {
        ...b,
        wallet: a.wallet,
        evidenceHash: rewardHash(701),
        completedAt: foreign.opensAt + 1000,
      },
    ]);
    f.setNow(foreign.cutoffAt);
    await assert.rejects(
      f.offers.close("offer_open_02"),
      /reward_qualifier_wallet_changed/,
    );
  } finally {
    await f.dispose();
  }
});
