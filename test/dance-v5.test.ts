import test from "node:test";
import assert from "node:assert/strict";
import { danceFixture, dh } from "./dance-fixture.ts";
import {
  optionalOffer,
  optionalReference,
  offerIdPreimage,
} from "../packages/dance/wire-values.ts";
import { DANCE_WIRE_PROPOSAL } from "../packages/dance/wire-proposal.ts";
import {
  closureSnapshotDisposition,
  type DanceClosureSnapshot,
} from "../packages/dance/closure-contract.ts";
test("V5 sealed reservation precedes exact consent and media binding excludes final receipt/time", async () => {
  const f = danceFixture();
  let reserved = false;
  const save = f.store.reserveCapture.bind(f.store);
  f.store.reserveCapture = async (...args) => {
    assert.equal(args[0].consent, null);
    await save(...args);
    reserved = true;
    f.store.time += 7;
  };
  const consent = f.store.acceptConsent.bind(f.store);
  f.store.acceptConsent = async (...args) => {
    assert.ok(reserved);
    assert.ok(f.store.captures.has(args[0].captureId));
    return consent(...args);
  };
  let preimage: unknown;
  const binding = f.ports.mediaBindingHash;
  f.ports.mediaBindingHash = async (p) => {
    preimage = p;
    return binding(p);
  };
  const r = await f.prepare({ delayMs: 1000 });
  assert.equal(r.capture.consent!.acceptedAtMs, r.capture.reservedAtMs + 7);
  assert.deepEqual(
    Object.keys(preimage as object).sort(),
    [
      "source",
      "captureHash",
      "mediaId",
      "expectedPostRetentionGeneration",
      "recordingSha256",
    ].sort(),
  );
  assert.equal(
    (preimage as { expectedPostRetentionGeneration: number })
      .expectedPostRetentionGeneration,
    2,
  );
});
test("no-offer zeros and no-reference timing survive; original ASCII offer hash is not inputHash", async () => {
  const f = danceFixture(),
    r = await f.prepare({ offer: false });
  const offer = optionalOffer(r.capture),
    reference = optionalReference(r.capture);
  assert.equal(offer.present, false);
  assert.equal(offer.opensAtMs, 0);
  assert.equal(BigInt(offer.inputHash), 0n);
  assert.equal(reference.present, false);
  assert.equal(reference.startSample, 0);
  assert.equal(reference.durationSamples, 480000);
  assert.equal(reference.revision, 0);
  assert.equal(
    offerIdPreimage("offer_01", f.pin).originalAsciiOfferId,
    "offer_01",
  );
  assert.throws(() => offerIdPreimage("offer å", f.pin));
  assert.equal(DANCE_WIRE_PROPOSAL.version, 5);
  assert.ok(
    DANCE_WIRE_PROPOSAL.orderedTuples.Capture.includes("uint64 reservedAtMs"),
  );
});
test("ordinary sign-in cannot substitute captured authorization; original remains valid until revocation", async () => {
  const f = danceFixture(),
    r = await f.prepare();
  f.principals.learner.authorizationId = dh(900);
  f.validAuthorizations.add(dh(900));
  await f.service.inspect("learner", r.reviewId);
  f.validAuthorizations.delete(r.capture.learner.authorizationId);
  await assert.rejects(
    f.service.inspect("learner", r.reviewId),
    /dance_capture_authorization_changed/,
  );
});
test("closure snapshot mismatch holds settlement without replacing entries or replaying paid obligations", () => {
  const f = danceFixture();
  const frozen: DanceClosureSnapshot = {
    version: "pirate.dance-closure-snapshot/1",
    offerId: "offer_01",
    offerInputHash: dh(2),
    cutoffBlock: { number: "10", hash: dh(3), timestampSeconds: "1800000000" },
    sources: [f.pin],
    retainedBindings: [
      {
        accountId: "learner",
        wallet: f.principals.learner.wallet,
        accountCommitment: f.principals.learner.accountCommitment,
      },
    ],
  };
  assert.equal(
    closureSnapshotDisposition(frozen, structuredClone(frozen)).hold,
    false,
  );
  const result = closureSnapshotDisposition(frozen, {
    ...frozen,
    cutoffBlock: { ...frozen.cutoffBlock, hash: dh(4) },
  });
  assert.deepEqual(result, {
    hold: true,
    preserveEntries: true,
    replayPaid: false,
  });
});
