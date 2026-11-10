import test from "node:test";
import assert from "node:assert/strict";
import {
  danceQualificationEntries,
  type CanonicalDancePass,
} from "../packages/dance/categorical-source.ts";
import {
  DANCE_SOURCE,
  DANCE_VERSION,
  type DanceCapture,
} from "../packages/dance/contracts.ts";
import { dh } from "./dance-fixture.ts";

// Modeled canonical adapter records exercise the proposed reader contract.
// They do not establish a deployed contract or any real chain acceptance.
const capture: DanceCapture = {
  version: DANCE_VERSION,
  captureId: "capture",
  communityId: dh(1),
  accountId: "learner",
  identityId: "learner_identity",
  accountRevision: 1,
  wallet: `0x${"11".repeat(20)}`,
  songKey: dh(2),
  songRevision: 1,
  audioSha256: dh(3),
  mediaPolicyVersion: "pirate.dance-private/1",
  reference: null,
  startSample: 0,
  durationSamples: 480000,
  policy: "moderator-review-policy-v2",
  rulesHash: dh(4),
  termsHash: dh(5),
  rubricHash: dh(6),
  expiresAtMs: 2000000,
  offer: {
    offerId: "offer",
    inputHash: dh(7),
    sourceId: dh(8),
    opensAtMs: 1000000,
    cutoffAtMs: 2000000,
  },
};
const record = (time: number): CanonicalDancePass => ({
  version: DANCE_SOURCE,
  capture,
  recordingSha256: dh(9),
  verdict: {
    version: DANCE_SOURCE,
    verdict: "passed",
    reviewerAccountId: "owner",
    reviewerIdentityId: "owner_identity",
    authority: "owner:assignment",
    committedAtMs: time,
    cue: "not_required",
    score: null,
    rewardReason: "candidate_held",
    chainAdmission: "canonical",
  },
  evidenceHash: dh(10),
  sourceId: dh(8),
  canonicalBlockHash: dh(11),
  canonicalBlockNumber: "100",
  committedAtMs: time,
});
const offer = {
  offerId: "offer",
  inputHash: dh(7),
  songKey: dh(2),
  sourceId: dh(8),
  opensAt: 1000,
  cutoffAt: 2000,
};

test("categorical reader refuses local held records and preserves exact offer boundaries", () => {
  const held = record(1000000);
  held.verdict.chainAdmission = "held";
  assert.throws(
    () => danceQualificationEntries([held], offer),
    /dance_chain_admission_held/,
  );
  assert.throws(
    () => danceQualificationEntries([record(999999)], offer),
    /outside_window/,
  );
  assert.equal(
    danceQualificationEntries([record(1000000)], offer)[0].completedAt,
    1000,
  );
  assert.equal(
    danceQualificationEntries([record(1999999)], offer)[0].completedAt,
    1999,
  );
  assert.throws(
    () => danceQualificationEntries([record(2000000)], offer),
    /outside_window/,
  );
  assert.throws(
    () =>
      danceQualificationEntries([record(1000000)], {
        ...offer,
        inputHash: dh(99),
      }),
    /binding_mismatch/,
  );
  const wrongMediaPolicy = record(1000000);
  wrongMediaPolicy.capture = {
    ...wrongMediaPolicy.capture,
    mediaPolicyVersion: "song-clip/1",
  };
  assert.throws(
    () => danceQualificationEntries([wrongMediaPolicy], offer),
    /dance_policy_mismatch/,
  );
  const sameIdentity = record(1000000);
  sameIdentity.verdict.reviewerIdentityId = sameIdentity.capture.identityId;
  assert.throws(
    () => danceQualificationEntries([sameIdentity], offer),
    /binding_mismatch/,
  );
});
