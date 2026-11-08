import { test } from "node:test";
import assert from "node:assert/strict";
import {
  manualRewardsFixture,
  rewardHash,
  rewardTestProfile,
} from "./manual-rewards-fixture.ts";
import { RewardOffers } from "../packages/rewards/offers.ts";
import { RewardStore } from "../packages/rewards/store.ts";
import {
  rehearsalTerms,
  withRewardRehearsal,
} from "../packages/rewards/rehearsal.ts";
import { rewardProfile } from "../packages/rewards/validation.ts";
import type {
  RewardOfferInput,
  RewardSources,
  RewardsProfile,
} from "../packages/rewards/contracts.ts";
import { applicationRewardsBindings } from "../apps/community-wizard/infra/rewards-bindings.ts";

const config = {
  schema: "pirate.reward-rehearsal/1" as const,
  offerId: "rehearsal_001",
  prizeUsdcAtomic: "30000",
};
function profile(): RewardsProfile {
  return rewardProfile(
    JSON.stringify({
      ...rewardTestProfile,
      mode: "live-testnet",
      operatorWallet: rewardTestProfile.payoutWallet,
      decimals: 18,
      rehearsal: config,
    }),
  );
}
function input(p: RewardsProfile, now: number): RewardOfferInput {
  const terms = rehearsalTerms(p)!;
  return {
    offerId: terms.offerId,
    drawingId: terms.drawingId,
    purchaseHash: terms.purchaseHash,
    ticketIds: terms.ticketIds,
    songKey: rewardHash(500),
    opensAt: now + 1000,
    cutoffAt: now + 10000,
  };
}

test("rehearsal is an explicit immutable testnet profile option, with exact amounts and no implicit global mode switch", async () => {
  const p = profile();
  assert.deepEqual(p.rehearsal, config);
  assert.equal(p.mode, "live-testnet");
  assert.equal(rehearsalTerms(rewardTestProfile), null);
  for (const change of [
    { mode: "simulated" },
    { chainId: 1 },
    { rehearsal: null },
    { rehearsal: { ...config, extra: true } },
    { rehearsal: { ...config, prizeUsdcAtomic: "0.03" } },
    { rehearsal: { ...config, prizeUsdcAtomic: (2n ** 256n - 1n).toString() } },
    { rehearsal: { ...config, offerId: "short" } },
  ])
    assert.throws(() => rewardProfile(JSON.stringify({ ...p, ...change })));
  const env = {
    REWARDS_PROFILE_JSON: JSON.stringify(p),
    REWARDS_RESULT_SOURCE_JSON: JSON.stringify({
      schema: "pirate.reward-result-source/1",
    }),
  };
  assert.deepEqual(applicationRewardsBindings(env), env);
  for (const r of [
    { ...config, prizeUsdcAtomic: "-1" },
    { ...config, prizeUsdcAtomic: (2n ** 256n - 1n).toString() },
    { ...config, offerId: "short" },
    { ...config, extra: 1 },
  ])
    assert.throws(
      () =>
        applicationRewardsBindings({
          ...env,
          REWARDS_PROFILE_JSON: JSON.stringify({ ...p, rehearsal: r }),
        }),
      /reward_release_binding_invalid/,
    );
  const f = await manualRewardsFixture(p);
  try {
    await assert.rejects(
      new RewardStore(f.db, {
        ...p,
        rehearsal: { ...config, prizeUsdcAtomic: "31000" },
      }).init(),
      /reward_program_configuration_changed/,
    );
  } finally {
    await f.dispose();
  }
});

test("only the declared offer gets mock external evidence; real provider and qualifier calls retain their paths", async () => {
  const p = profile(),
    offer = input(p, 1000);
  let purchases = 0,
    winnings = 0,
    qualifiers = 0;
  const live: RewardSources = {
    mode: "live-testnet",
    purchase: async () => {
      purchases++;
      return { mode: "live-testnet", receiptHash: rewardHash(1) };
    },
    winnings: async () => {
      winnings++;
      return {
        mode: "live-testnet",
        usdcAtomic: "0",
        receiptHash: rewardHash(2),
      };
    },
    qualifiers: async () => {
      qualifiers++;
      return [];
    },
  };
  const source = withRewardRehearsal(p, live);
  assert.equal((await source.purchase(offer, p)).mode, "simulated");
  const win = await source.winnings(offer, p);
  assert.equal(win.mode, "simulated");
  assert.equal(win.usdcAtomic, "30000");
  assert.equal(win.transactionHash, undefined);
  assert.equal(purchases, 0);
  assert.equal(winnings, 0);
  await source.qualifiers(offer);
  assert.equal(qualifiers, 1);
  for (const bad of [
    { ...offer, purchaseHash: rewardHash(9) },
    { ...offer, ticketIds: ["1"] },
    { ...offer, drawingId: "1" },
  ])
    await assert.rejects(
      source.purchase(bad, p),
      /reward_rehearsal_offer_changed/,
    );
  for (const hash of ["", rewardHash(7)])
    await assert.rejects(
      source.winnings(offer, p, hash),
      /no_collection_transaction/,
    );
  await source.purchase({ ...offer, offerId: "ordinary_001" }, p);
  await source.winnings({ ...offer, offerId: "ordinary_001" }, p);
  assert.equal(purchases, 1);
  assert.equal(winnings, 1);
  await assert.rejects(
    source.purchase(offer, {
      ...p,
      rehearsal: { ...config, prizeUsdcAtomic: "40000" },
    }),
    /profile_changed/,
  );
});

test("generic offer paths freeze rehearsal refs/mode and allocate once; real and mock credit provenance survives one aggregate payment", async () => {
  const p = profile(),
    f = await manualRewardsFixture(p);
  try {
    const [learner] = f.principals;
    await f.offers.approve(learner.accountId, learner.wallet);
    f.sources.winnings = async () => ({
      mode: "live-testnet",
      usdcAtomic: "1110000",
      receiptHash: rewardHash(901),
      transactionHash: rewardHash(902),
      blockHash: rewardHash(903),
      blockNumber: "10",
    });
    const source = withRewardRehearsal(p, f.sources),
      offers = new RewardOffers(f.store, source, f.now),
      mock = input(p, f.now());
    const attached = await offers.attach(mock);
    assert.equal(attached.evidenceMode, "simulated");
    assert.equal((await offers.attach(mock)).evidenceMode, "simulated");
    await assert.rejects(
      offers.attach({ ...mock, purchaseHash: rewardHash(77) }),
      /reward_offer_conflict/,
    );
    const normal = {
      ...mock,
      offerId: "ordinary_001",
      drawingId: "1",
      purchaseHash: rewardHash(88),
      ticketIds: ["1"],
    };
    assert.equal((await offers.attach(normal)).evidenceMode, "live-testnet");
    f.setCandidates([
      {
        ...learner,
        evidenceHash: rewardHash(600),
        completedAt: mock.opensAt + 1,
      },
    ]);
    f.setNow(mock.cutoffAt);
    await offers.close(mock.offerId);
    await offers.close(normal.offerId);
    await assert.rejects(
      offers.settle(mock.offerId, rewardHash(80)),
      /no_collection_transaction/,
    );
    const wrongMode = new RewardOffers(
      f.store,
      {
        ...source,
        winnings: async () => ({
          mode: "live-testnet",
          usdcAtomic: "30000",
          receiptHash: rewardHash(81),
        }),
      },
      f.now,
    );
    await assert.rejects(
      wrongMode.settle(mock.offerId),
      /settlement_mode_mismatch/,
    );
    const wrongAmount = new RewardOffers(
      f.store,
      {
        ...source,
        winnings: async () => ({
          mode: "simulated",
          usdcAtomic: "30001",
          receiptHash: rewardHash(81),
        }),
      },
      f.now,
    );
    await assert.rejects(
      wrongAmount.settle(mock.offerId),
      /rehearsal_settlement_changed/,
    );
    assert.equal((await f.store.credits(learner.accountId)).length, 0);
    assert.equal(
      (await offers.settle(mock.offerId)).payoutAtomic,
      "30000000000000000",
    );
    for (const hash of ["", rewardHash(905)])
      await assert.rejects(
        offers.settle(mock.offerId, hash),
        /no_collection_transaction/,
      );
    await offers.settle(mock.offerId);
    await offers.settle(normal.offerId, rewardHash(904));
    const credits = await f.store.credits(learner.accountId);
    assert.equal(credits.length, 2);
    const tickets = await f.store
      .statement(
        "SELECT source_ticket_id FROM reward_tickets ORDER BY source_ticket_id",
      )
      .all<{ source_ticket_id: string }>();
    assert.equal(tickets.results[0].source_ticket_id, "84532:1");
    assert.ok(
      tickets.results[1].source_ticket_id.startsWith(
        `simulated:${p.programId}:`,
      ),
    );
    const intent = await f.claims.intent(learner);
    f.subjects.set("provider_1", "77");
    await f.claims.readIntent(learner, intent.intent_id);
    for (const credit of credits)
      await f.claims.claim(learner, credit.credit_id);
    const fundHash = rewardHash(200);
    f.transfers.set(fundHash, {
      ...f.receipt(fundHash, p.payoutWallet, "2000000000000000000"),
      blockNumber: "90",
      sender: `0x${"77".repeat(20)}`,
    });
    await f.payments.fund("funding_001", fundHash, 2, {
      kind: "prefunding",
      sourceUsdcAtomic: "0",
      sourceTransactionHash: null,
      feeUsdcAtomic: "0",
    });
    f.setBalance("2000000000000000000");
    const payment = await f.payments.prepare("payment_001", learner.accountId);
    assert.equal(payment.amountAtomic, "1140000000000000000");
    await f.payments.dispatch(payment.paymentId, "pay", "attempt_001");
    const hash = rewardHash(201);
    f.guard(payment, hash, [
      f.receipt(hash, learner.wallet, payment.amountAtomic),
    ]);
    await f.payments.reconcile(payment.paymentId);
    const items = await f.store
      .statement(
        "SELECT c.credit_id,c.amount_atomic,o.purchase_evidence FROM reward_payment_items i JOIN reward_credits c ON c.credit_id=i.credit_id JOIN reward_offers o ON o.program_id=c.program_id AND o.offer_id=c.offer_id WHERE i.payment_id=?",
        payment.paymentId,
      )
      .all<{
        credit_id: string;
        amount_atomic: string;
        purchase_evidence: string;
      }>();
    assert.equal(items.results.length, 2);
    assert.deepEqual(
      new Set(items.results.map((r) => JSON.parse(r.purchase_evidence).mode)),
      new Set(["simulated", "live-testnet"]),
    );
    assert.ok(
      (await f.store.credits(learner.accountId)).every(
        (c) => c.paid_atomic === c.amount_atomic,
      ),
    );
  } finally {
    await f.dispose();
  }
});
