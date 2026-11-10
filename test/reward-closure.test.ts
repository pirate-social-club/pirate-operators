import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { hashJson } from "../packages/community/common.ts";
import type { RewardSources } from "../packages/rewards/contracts.ts";
import { RewardOffers } from "../packages/rewards/offers.ts";
import { RewardPayments } from "../packages/rewards/payments.ts";
import { manualRewardsFixture, rewardHash } from "./manual-rewards-fixture.ts";

test("closure stores entries and evidence together, fences payment, and reconciles a spent guard after reorg", async () => {
  const f = await manualRewardsFixture();
  try {
    const [learner] = f.principals;
    const sourceHash = rewardHash(2001);
    const pin = {
      chainId: 6343 as const,
      cutoffNumber: "95",
      cutoffTimestampSeconds: String(Math.floor(f.now() / 1000) + 9),
      cutoffHash: rewardHash(2002),
      sources: [{ sourceHash, policyEvidenceHash: rewardHash(2003) }],
    };
    const input = {
      offerId: "offer_closure",
      drawingId: "29",
      songKey: rewardHash(500),
      opensAt: f.now() + 1000,
      cutoffAt: f.now() + 10000,
      purchaseHash: rewardHash(2004),
      ticketIds: ["29"],
    };
    const entry = {
      ...learner,
      evidenceHash: rewardHash(2005),
      completedAt: input.opensAt,
    };
    let canonical = true;
    let reorgDuringWinnings = false;
    const sources: RewardSources = {
      ...f.sources,
      resultSources: { accepted: [sourceHash], current: sourceHash },
      closure: {
        requires: () => true,
        scan: async () => ({
          evidence: pin,
          entries: [entry],
          captured: new Set([hashJson(entry)]),
        }),
        verify: async (_, expected) => {
          assert.deepEqual(expected, pin);
          if (!canonical) throw new Error("fixture_cutoff_replaced");
        },
      },
      winnings: async (...args) => {
        if (reorgDuringWinnings) canonical = false;
        return f.sources.winnings(...args);
      },
    };
    const offers = new RewardOffers(f.store, sources, f.now);
    const payments = new RewardPayments(f.store, f.chain, f.now, sources);
    const attached = await offers.attach(input);
    assert.deepEqual(attached.resultSources, [sourceHash]);
    f.setNow(input.cutoffAt);
    await assert.rejects(
      offers.close(input.offerId),
      /reward_closure_snapshots/,
    );
    assert.equal((await f.store.offer(input.offerId)).state, "open");

    const migration = await readFile(
      new URL(
        "../apps/community-wizard/infra/migrations/0014_reward_closure_snapshots.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await f.db.prepare(migration).run();
    // Unlinking does not erase the authenticated wallet captured by the Dance source.
    await f.db
      .prepare("DELETE FROM credential_bindings WHERE account_id=?")
      .bind(learner.accountId)
      .run();
    const closed = await offers.close(input.offerId);
    assert.deepEqual(closed.entries, [entry]);
    const saved = await f.db
      .prepare(
        "SELECT snapshot_hash,snapshot_json FROM reward_closure_snapshots",
      )
      .first<{ snapshot_hash: string; snapshot_json: string }>();
    assert.ok(saved);
    const snapshot = JSON.parse(saved.snapshot_json);
    assert.equal(saved.snapshot_hash, hashJson(snapshot));
    assert.equal(snapshot.entriesHash, hashJson([entry]));
    assert.deepEqual(snapshot.evidence, pin);

    reorgDuringWinnings = true;
    await assert.rejects(
      offers.settle(input.offerId),
      /fixture_cutoff_replaced/,
    );
    assert.equal((await f.store.offer(input.offerId)).state, "closed");
    assert.deepEqual(await f.store.credits(learner.accountId), []);
    canonical = true;
    reorgDuringWinnings = false;
    const withoutReader = new RewardOffers(
      f.store,
      { ...sources, closure: undefined },
      f.now,
    );
    await assert.rejects(
      withoutReader.settle(input.offerId),
      /reward_closure_unavailable/,
    );
    await offers.settle(input.offerId);
    const [credit] = await f.store.credits(learner.accountId);
    // Exercise payment reservation independently of provider verification.
    await f.db
      .prepare(
        "UPDATE reward_credits SET claim_state='accepted' WHERE credit_id=?",
      )
      .bind(credit.credit_id)
      .run();
    const fundingHash = rewardHash(2006);
    f.transfers.set(fundingHash, {
      ...f.receipt(fundingHash, f.store.profile.payoutWallet, "2000000"),
      blockNumber: "90",
      sender: `0x${"77".repeat(20)}`,
    });
    await payments.fund("funding_closure", fundingHash, 2, {
      kind: "prefunding",
      sourceUsdcAtomic: "0",
      sourceTransactionHash: null,
      feeUsdcAtomic: "0",
    });
    canonical = false;
    await assert.rejects(
      payments.prepare("payment_closure", learner.accountId),
      /fixture_cutoff_replaced/,
    );
    assert.equal(
      (await f.store.credits(learner.accountId))[0].payment_id,
      null,
    );
    canonical = true;
    const payment = await payments.prepare(
      "payment_closure",
      learner.accountId,
    );
    canonical = false;
    await assert.rejects(
      payments.prepare(payment.paymentId, learner.accountId),
      /fixture_cutoff_replaced/,
    );
    const missing = new RewardPayments(f.store, f.chain, f.now);
    await assert.rejects(
      missing.prepare(payment.paymentId, learner.accountId),
      /reward_closure_unavailable/,
    );
    await assert.rejects(
      payments.dispatch(payment.paymentId, "pay", "attempt_closure"),
      /fixture_cutoff_replaced/,
    );
    assert.equal((await f.store.payment(payment.paymentId)).dispatch_at, null);
    canonical = true;
    await payments.dispatch(payment.paymentId, "pay", "attempt_closure");
    canonical = false;
    await assert.rejects(
      payments.dispatch(payment.paymentId, "pay", "attempt_closure"),
      /fixture_cutoff_replaced/,
    );
    const paidHash = rewardHash(2007);
    f.guard(payment, paidHash, [
      f.receipt(paidHash, learner.wallet, payment.amountAtomic),
    ]);
    const reconciled = await payments.recover(payment.paymentId, paidHash);
    assert.equal(reconciled.state, "confirmed");
    assert.equal(
      (await missing.prepare(payment.paymentId, learner.accountId)).state,
      "confirmed",
    );
    assert.equal(
      (await f.store.credits(learner.accountId))[0].paid_atomic,
      payment.amountAtomic,
    );
    await assert.rejects(
      payments.dispatch(payment.paymentId, "pay", "attempt_closure_2"),
      /reward_payment_already_resolved/,
    );
    assert.deepEqual(
      await f.db
        .prepare(
          "SELECT snapshot_hash,snapshot_json FROM reward_closure_snapshots",
        )
        .first(),
      saved,
    );
  } finally {
    await f.dispose();
  }
});
