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
  isRehearsalRollover,
  rehearsalTerms,
  rehearsalTermsFor,
  rewardProfileAncestors,
  withRewardRehearsal,
} from "../packages/rewards/rehearsal.ts";
import { canonical } from "../packages/community/common.ts";
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

test("a rehearsal rollover keeps the program, its stored hash and the retired offer's original terms, and never reverses", async () => {
  const p0 = profile(),
    next = { ...config, offerId: "rehearsal_002" },
    p1 = rewardProfile(
      JSON.stringify({ ...p0, rehearsal: next, rehearsalHistory: [config] }),
    ),
    p2 = rewardProfile(
      JSON.stringify({
        ...p0,
        rehearsal: { ...config, offerId: "rehearsal_003" },
        rehearsalHistory: [config, next],
      }),
    );
  assert.equal(canonical(rewardProfileAncestors(p1)), canonical([p0]));
  assert.equal(canonical(rewardProfileAncestors(p2)), canonical([p1, p0]));
  assert.ok(isRehearsalRollover(p0, p1) && isRehearsalRollover(p1, p2));
  assert.ok(!isRehearsalRollover(p1, p0) && !isRehearsalRollover(p0, p2));
  assert.ok(!isRehearsalRollover(p0, p0));
  assert.ok(
    !isRehearsalRollover(
      p0,
      rewardProfile(
        JSON.stringify({
          ...p1,
          rehearsal: { ...next, prizeUsdcAtomic: "999000000" },
        }),
      ),
    ),
    "a rollover cannot enlarge the simulated prize",
  );
  for (const bad of [
    { ...p0, rehearsalHistory: [] },
    { ...p0, rehearsalHistory: [config] },
    { ...p0, rehearsal: next, rehearsalHistory: [next] },
    { ...p0, rehearsal: next, rehearsalHistory: [config, config] },
    { ...p0, rehearsal: undefined, rehearsalHistory: [config] },
    { ...p0, rehearsal: next, rehearsalHistory: [{ ...config, extra: 1 }] },
  ])
    assert.throws(() => rewardProfile(JSON.stringify(bad)));
  // The retired terms are exactly the ones the original offer was attached with.
  assert.equal(
    canonical(rehearsalTermsFor(p1, config.offerId)),
    canonical(rehearsalTerms(p0)),
  );

  const f = await manualRewardsFixture(p0);
  try {
    const storedHash = async () =>
      (await f.store
        .statement("SELECT profile_hash FROM reward_programs")
        .first<{ profile_hash: string }>())!.profile_hash;
    const before = await storedHash();
    const first = input(p0, f.now());
    await new RewardOffers(
      f.store,
      withRewardRehearsal(p0, f.sources),
      f.now,
    ).attach(first);

    for (const bad of [
      { ...p1, veryAppId: "another_program" },
      { ...p1, rehearsalHistory: [{ ...config, prizeUsdcAtomic: "31000" }] },
    ])
      await assert.rejects(
        new RewardStore(f.db, rewardProfile(JSON.stringify(bad))).init(),
        /reward_program_configuration_changed/,
      );
    const s1 = new RewardStore(f.db, p1);
    await s1.init();
    assert.equal(await storedHash(), before);
    const rows = await f.store
      .statement(
        "SELECT (SELECT COUNT(*) FROM reward_programs) AS programs,(SELECT COUNT(*) FROM reward_inventory) AS inventory",
      )
      .first<{ programs: number; inventory: number }>();
    assert.deepEqual({ ...rows }, { programs: 1, inventory: 1 });

    const offers = new RewardOffers(
      s1,
      withRewardRehearsal(p1, f.sources),
      f.now,
    );
    assert.equal((await offers.attach(first)).evidenceMode, "simulated");
    const second = input(p1, f.now());
    assert.equal(second.offerId, "rehearsal_002");
    assert.notEqual(second.purchaseHash, first.purchaseHash);
    assert.deepEqual([first.drawingId, second.drawingId], ["0", "1"]);
    assert.equal((await offers.attach(second)).evidenceMode, "simulated");

    // The original offer still closes through normal qualification and
    // settles at its own simulated prize under the successor profile.
    f.setCandidates([]);
    f.setNow(first.cutoffAt);
    assert.deepEqual((await offers.close(first.offerId)).entries, []);
    const settled = await offers.settle(first.offerId);
    assert.equal(settled.winningsUsdcAtomic, "30000");
    assert.equal(
      (await s1.offer(second.offerId)).state,
      "open",
      "the new rehearsal is untouched",
    );
    // A later rollover still derives the stored profile. The release gate,
    // not the ledger, limits each release to one step.
    await new RewardStore(f.db, p2).init();

    // Production rollback: the stored hash is the original profile, so the
    // ledger still opens under it, but the newer rehearsal's money stays shut.
    const s0 = new RewardStore(f.db, p0);
    await s0.init();
    const rolledBack = new RewardOffers(
      s0,
      withRewardRehearsal(p0, f.sources),
      f.now,
    );
    f.setNow(second.cutoffAt);
    await rolledBack.close(second.offerId);
    await assert.rejects(
      rolledBack.settle(second.offerId),
      /reward_rehearsal_offer_changed/,
    );
    assert.equal((await s0.offer(second.offerId)).state, "closed");

    // A rehearsal may never name an offer that was attached with real evidence.
    const live = {
      ...first,
      offerId: "live_offer_01",
      drawingId: "11492",
      purchaseHash: rewardHash(4242),
      ticketIds: ["4242"],
      songKey: rewardHash(4243),
      opensAt: f.now() + 1000,
      cutoffAt: f.now() + 9000,
    };
    await new RewardOffers(
      s1,
      withRewardRehearsal(p1, f.sources),
      f.now,
    ).attach(live);
    const conflicting = rewardProfile(
      JSON.stringify({
        ...p1,
        rehearsal: { ...next, offerId: "live_offer_01" },
        rehearsalHistory: [config, next],
      }),
    );
    const sc = new RewardStore(f.db, conflicting);
    await sc.init(); // the rest of the program keeps working
    await assert.rejects(
      new RewardOffers(
        sc,
        withRewardRehearsal(conflicting, f.sources),
        f.now,
      ).settle("live_offer_01"),
      /reward_rehearsal_offer_conflict/,
    );
  } finally {
    await f.dispose();
  }

  const g = await manualRewardsFixture(p1);
  try {
    await assert.rejects(
      new RewardStore(g.db, p0).init(),
      /reward_program_configuration_changed/,
    );
    const offers = new RewardOffers(
      g.store,
      withRewardRehearsal(p1, g.sources),
      g.now,
    );
    const retired = { ...input(p1, g.now()), offerId: config.offerId };
    const terms = rehearsalTermsFor(p1, config.offerId)!;
    await assert.rejects(
      offers.attach({
        ...retired,
        purchaseHash: terms.purchaseHash,
        ticketIds: terms.ticketIds,
      }),
      /reward_rehearsal_retired/,
    );
    await assert.rejects(
      withRewardRehearsal(p1, g.sources).purchase(
        {
          ...retired,
          purchaseHash: terms.purchaseHash,
          ticketIds: terms.ticketIds,
        },
        p1,
      ),
      /reward_rehearsal_retired/,
    );
  } finally {
    await g.dispose();
  }
});
