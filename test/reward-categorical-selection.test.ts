import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hashJson } from "../packages/community/common.ts";
import type { RewardOfferInput } from "../packages/rewards/contracts.ts";
import { RewardOffers, offerInput } from "../packages/rewards/offers.ts";
import { rehearsalTerms } from "../packages/rewards/rehearsal.ts";
import { categoricalRewardSources } from "../services/reward-sources.ts";
import { rewardDanceV2Reader } from "../services/reward-dance-v2-reader.ts";
import { categoricalSelectionFixture } from "./fixtures/reward-categorical-selection.ts";
import { manualRewardsFixture } from "./manual-rewards-fixture.ts";
import { word } from "./fixtures/reward-dance-v2.ts";

test("explicit categorical-only composition needs no scored source, legacy configuration or account resolver", async () => {
  const f = categoricalSelectionFixture(), v2 = f.chain; v2.add();
  f.categorical.set(f.a, rewardDanceV2Reader(v2));
  const source = categoricalRewardSources(f.input);
  assert.deepEqual(source.resultSources, { accepted: [f.a, f.b], current: f.a, defaults: [f.a] });
  assert.ok(source.closure);
  const found = await source.closure.scan(v2.offer, v2.inputHash);
  assert.equal(found.entries.length, 1);
  assert.deepEqual(found.captured, new Set(found.entries.map(hashJson)));
  assert.deepEqual(found.evidence.sources.map(s => s.sourceHash), [f.a]);
  assert.equal(found.evidence.cutoffNumber, "15");
  assert.equal(found.evidence.cutoffHash, v2.cutoff.hash);
  await source.closure.verify(v2.offer, found.evidence);
});

for (const kind of ["empty readers", "unknown current", "empty defaults", "unknown default", "duplicate defaults", "current omitted", "too many defaults", "nonlive"] as const)
  test(`categorical-only selection rejects ${kind} before any source or RPC read`, () => {
    const f = categoricalSelectionFixture();
    if (kind === "empty readers") f.categorical.clear();
    if (kind === "unknown current") f.input.current = word(4999);
    if (kind === "empty defaults") f.input.defaults = [];
    if (kind === "unknown default") f.input.defaults = [f.a, word(4999)];
    if (kind === "duplicate defaults") f.input.defaults = [f.a, f.a];
    if (kind === "current omitted") f.input.defaults = [f.b];
    if (kind === "too many defaults") {
      const added = Array.from({ length: 8 }, (_, i) => word(4900 + i));
      for (const hash of added) f.categorical.set(hash, f.categorical.get(f.a)!);
      f.input.defaults = [f.a, ...added];
    }
    if (kind === "nonlive") f.profile.mode = "simulated";
    assert.throws(() => categoricalRewardSources(f.input), /reward_categorical_selection_invalid|reward_result_profile_changed/);
    assert.deepEqual(f.chain.state.reads, []); assert.deepEqual(f.state.reads, []);
  });

test("an unavailable historical implicit source never becomes a future categorical default", async () => {
  const f = categoricalSelectionFixture(), source = categoricalRewardSources({ ...f.input, current: f.b, defaults: [f.b] });
  const legacy = offerInput(f.chain.offer); delete legacy.resultSources;
  assert.equal(Object.hasOwn(legacy, "resultSources"), false);
  assert.equal(source.closure!.requires(legacy), false);
  await assert.rejects(source.qualifiers(legacy), /reward_result_source_unavailable/);
  assert.deepEqual(f.state.reads, []); assert.deepEqual(f.state.verifies, []);
  assert.equal(Object.hasOwn(legacy, "resultSources"), false);
});

test("historical implicit identity stays original even when a retained original categorical reader exists", async () => {
  const f = categoricalSelectionFixture(); f.profile.resultSourceHash = f.a;
  const source = categoricalRewardSources({ ...f.input, current: f.b, defaults: [f.b] });
  const legacy = offerInput(f.chain.offer); delete legacy.resultSources;
  assert.equal(source.closure!.requires(legacy), true);
  await source.closure!.scan(legacy, hashJson(legacy));
  assert.deepEqual(f.state.reads.map(r => r.hash), [f.a]);
  assert.deepEqual(f.state.verifies.map(r => r.hash), [f.a]);
  assert.equal(Object.hasOwn(f.state.reads[0].offer, "resultSources"), false);
});

test("future defaults and caller-owned maps/profile cannot change a composed source's historical identity", async () => {
  const f = categoricalSelectionFixture(), source = categoricalRewardSources(f.input);
  f.profile.resultSourceHash = f.b; f.input.current = f.b; f.input.defaults = [f.b];
  f.categorical.clear();
  assert.deepEqual(source.resultSources, { accepted: [f.a, f.b], current: f.a, defaults: [f.a] });
  const legacy = offerInput(f.chain.offer); delete legacy.resultSources;
  await assert.rejects(source.qualifiers(legacy), /reward_result_source_unavailable/);
  await source.closure!.scan(f.chain.offer, f.chain.inputHash);
  assert.deepEqual(f.state.reads.map(r => r.hash), [f.a]);
});

test("explicit old offer pins survive new defaults and are never replaced or expanded", async () => {
  const f = categoricalSelectionFixture(), source = categoricalRewardSources({ ...f.input, current: f.b, defaults: [f.b] });
  const original = structuredClone(f.chain.offer);
  await source.closure!.scan(original, f.chain.inputHash);
  assert.deepEqual(f.state.reads.map(r => r.hash), [f.a]);
  assert.deepEqual(f.state.verifies.map(r => r.hash), [f.a]);
  assert.deepEqual(original, f.chain.offer);
});

test("multiple explicit categorical pins share exact cutoff and preserve captured entry identity and pin order", async () => {
  const f = categoricalSelectionFixture(), source = categoricalRewardSources(f.input);
  const offer = { ...f.chain.offer, resultSources: [f.b, f.a] };
  const entry = { accountId: "fixture_retained_private_account", wallet: f.profile.payoutWallet,
    completedAt: offer.opensAt + 1000, evidenceHash: word(4200) };
  f.state.entries.set(f.b, [entry]);
  const found = await source.closure!.scan(offer, hashJson(offer));
  assert.deepEqual(found.entries, [entry]); assert.deepEqual(found.captured, new Set([hashJson(entry)]));
  assert.deepEqual(found.evidence.sources.map(s => s.sourceHash), [f.b, f.a]);
  assert.deepEqual(f.state.reads.map(r => [r.fromBlock, r.cutoff]), [
    [11n, f.chain.cutoff], [11n, f.chain.cutoff],
  ]);
});

test("unknown or duplicate explicit pins fail closed and never fall back to current defaults", async () => {
  for (const resultSources of [[word(4999)], [], [word(4999), word(4999)]]) {
    const f = categoricalSelectionFixture(), source = categoricalRewardSources(f.input);
    await assert.rejects(source.qualifiers({ ...f.chain.offer, resultSources }), /reward_result_source_unavailable|reward_offer_sources_invalid/);
    assert.deepEqual(f.state.reads, []);
  }
});

test("categorical qualification requires the frozen closure path rather than an unfrozen qualifiers call", async () => {
  const f = categoricalSelectionFixture(), source = categoricalRewardSources(f.input);
  await assert.rejects(source.qualifiers(f.chain.offer), /reward_closure_unavailable/);
  assert.deepEqual(f.state.reads, []);
});

test("admission authenticates each selected policy before opening without dispatching any provider operation", async () => {
  const f = categoricalSelectionFixture(), source = categoricalRewardSources(f.input);
  f.chain.state.safeNumber = 10n;
  await source.closure!.admit!(f.chain.offer);
  assert.deepEqual(f.state.verifies.map(v => [v.hash, v.cutoff.number]), [[f.a, 10n]]);
  assert.deepEqual(f.state.reads, []);
  assert.ok(!f.chain.state.reads.some(v => /send|sign/i.test(v)));
});

test("unconfirmed cutoff and history after opening retain fail-closed source behavior", async () => {
  const f = categoricalSelectionFixture(), source = categoricalRewardSources(f.input);
  f.chain.state.safeNumber = 14n;
  await assert.rejects(source.closure!.scan(f.chain.offer, f.chain.inputHash), /reward_cutoff_not_confirmed/);
  f.chain.state.safeNumber = 16n; f.categorical.get(f.a)!.fromBlock = 12n;
  await assert.rejects(source.closure!.scan(f.chain.offer, f.chain.inputHash), /reward_history_starts_after_offer/);
  assert.deepEqual(f.state.reads, []);
});

test("temporary category failure publishes no partial snapshot and ordinary retry preserves the same request", async () => {
  const f = categoricalSelectionFixture(), source = categoricalRewardSources(f.input);
  const offer = { ...f.chain.offer, resultSources: [f.a, f.b] }, hash = hashJson(offer);
  f.state.unavailable.add(f.b);
  await assert.rejects(source.closure!.scan(offer, hash), /fixture_categorical_unavailable/);
  f.state.unavailable.clear();
  const result = await source.closure!.scan(offer, hash);
  assert.deepEqual(result.evidence.sources.map(s => s.sourceHash), [f.a, f.b]);
  assert.equal(hashJson(offer), hash);
});

test("policy replacement and cutoff reorg invalidate stored categorical closure evidence", async () => {
  const f = categoricalSelectionFixture(), source = categoricalRewardSources(f.input);
  const result = await source.closure!.scan(f.chain.offer, f.chain.inputHash);
  f.state.policies.set(f.a, word(4299));
  await assert.rejects(source.closure!.verify(f.chain.offer, result.evidence), /reward_closure_sources_changed/);
  f.chain.blocks.get(15n)!.hash = word(4298);
  await assert.rejects(source.closure!.verify(f.chain.offer, result.evidence), /reward_results_head_changed/);
});

test("reorg during a categorical scan rejects the whole candidate set", async () => {
  const f = categoricalSelectionFixture(), source = categoricalRewardSources(f.input);
  f.state.afterRead = () => { f.chain.blocks.get(15n)!.hash = word(4297); };
  await assert.rejects(source.closure!.scan(f.chain.offer, f.chain.inputHash), /reward_results_head_changed/);
});

test("actual D1 offer attachment freezes defaults; later defaults cannot redirect close, settlement or liabilities", async () => {
  const f = categoricalSelectionFixture();
  const db = await manualRewardsFixture({ ...f.profile, rehearsal: { offerId: f.chain.offer.offerId, prizeUsdcAtomic: "30000" } });
  try {
    const migration = await readFile(new URL("../apps/community-wizard/infra/migrations/0014_reward_closure_snapshots.sql", import.meta.url), "utf8");
    await db.db.prepare(migration).run();
    const profile = db.store.profile, terms = rehearsalTerms(profile)!;
    const input: RewardOfferInput = { ...f.chain.offer, drawingId: terms.drawingId,
      purchaseHash: terms.purchaseHash, ticketIds: terms.ticketIds };
    delete input.resultSources;
    const [learner] = db.principals;
    const entry = { ...learner, completedAt: input.opensAt + 1000, evidenceHash: word(4300) };
    f.state.entries.set(f.a, [entry]);
    const source = categoricalRewardSources({ ...f.input, profile });
    db.setNow(input.opensAt - 1000); f.chain.state.safeNumber = 10n;
    const attached = await new RewardOffers(db.store, source, db.now).attach(input);
    assert.deepEqual(attached.resultSources, [f.a]);
    const originalHash = (await db.store.offer(input.offerId)).input_hash;
    const next = categoricalRewardSources({ ...f.input, profile, current: f.b, defaults: [f.b] });
    const offers = new RewardOffers(db.store, next, db.now);
    f.chain.state.safeNumber = 16n; db.setNow(input.cutoffAt);
    // The authenticated capture, rather than today's mutable credential, owns the entry.
    await db.db.prepare("DELETE FROM credential_bindings WHERE account_id=?").bind(learner.accountId).run();
    const closed = await offers.close(input.offerId);
    assert.deepEqual(closed.entries, [entry]); assert.deepEqual(closed.resultSources, [f.a]);
    await offers.settle(input.offerId);
    const [credit] = await db.store.credits(learner.accountId);
    assert.equal(credit.amount_atomic, "30000"); assert.equal(credit.paid_atomic, "0");
    assert.equal(credit.claim_state, "unclaimed");
    assert.equal((await db.store.offer(input.offerId)).input_hash, originalHash);
    assert.ok(f.state.reads.every(r => r.hash === f.a));
    assert.ok(f.state.verifies.every(r => r.hash === f.a));
  } finally { await db.dispose(); }
});

test("actual historical absent-pin offer stays open and byte-identical when only future readers remain", async () => {
  const f = categoricalSelectionFixture();
  const db = await manualRewardsFixture({ ...f.profile, rehearsal: { offerId: f.chain.offer.offerId, prizeUsdcAtomic: "30000" } });
  try {
    const profile = db.store.profile, terms = rehearsalTerms(profile)!;
    const input = { ...f.chain.offer, drawingId: terms.drawingId, purchaseHash: terms.purchaseHash, ticketIds: terms.ticketIds };
    delete input.resultSources;
    const source = categoricalRewardSources({ ...f.input, profile });
    const { resultSources: _pins, closure: _closure, ...historical } = source;
    db.setNow(input.opensAt - 1000);
    await new RewardOffers(db.store, historical, db.now).attach(input);
    const before = await db.store.offer(input.offerId);
    assert.equal(Object.hasOwn(JSON.parse(before.purchase_evidence), "resultSources"), false);
    db.setNow(input.cutoffAt);
    const future = categoricalRewardSources({ ...f.input, profile, current: f.b, defaults: [f.b] });
    await assert.rejects(new RewardOffers(db.store, future, db.now).close(input.offerId), /reward_result_source_unavailable/);
    assert.deepEqual(await db.store.offer(input.offerId), before);
    assert.deepEqual(await db.store.credits(db.principals[0].accountId), []);
    assert.deepEqual(f.state.reads, []); assert.deepEqual(f.state.verifies, []);
  } finally { await db.dispose(); }
});
