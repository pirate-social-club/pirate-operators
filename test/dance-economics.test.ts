import test from "node:test";
import assert from "node:assert/strict";
import { manualRewardsFixture, rewardHash } from "./manual-rewards-fixture.ts";
import {
  danceQualificationEntries,
  type CanonicalDancePass,
} from "../packages/dance/categorical-source.ts";
import { DANCE_SOURCE, DANCE_VERSION } from "../packages/dance/contracts.ts";

test("existing real offer closure collapses modeled Study/Karaoke/Dance sources to one account share", async () => {
  const f = await manualRewardsFixture();
  try {
    const offer = await f.offer("dance_combined", "1"),
      learner = f.principals[0];
    const record: CanonicalDancePass = {
      version: DANCE_SOURCE,
      sourceId: rewardHash(8),
      canonicalBlockHash: rewardHash(9),
      canonicalBlockNumber: "100",
      recordingSha256: rewardHash(10),
      evidenceHash: rewardHash(11),
      committedAtMs: (offer.opensAt + 2000) * 1000,
      capture: {
        version: DANCE_VERSION,
        captureId: "capture_1",
        communityId: rewardHash(1),
        accountId: learner.accountId,
        identityId: "learner_identity",
        accountRevision: 1,
        wallet: learner.wallet,
        songKey: offer.songKey,
        songRevision: 1,
        audioSha256: rewardHash(3),
        mediaPolicyVersion: "pirate.dance-private/1",
        reference: null,
        startSample: 0,
        durationSamples: 480000,
        policy: "moderator-review-policy-v2",
        rulesHash: rewardHash(4),
        termsHash: rewardHash(5),
        rubricHash: rewardHash(6),
        expiresAtMs: offer.cutoffAt * 1000,
        offer: {
          offerId: offer.offerId,
          inputHash: rewardHash(7),
          sourceId: rewardHash(8),
          opensAtMs: offer.opensAt * 1000,
          cutoffAtMs: offer.cutoffAt * 1000,
        },
      },
      verdict: {
        version: DANCE_SOURCE,
        verdict: "passed",
        reviewerAccountId: "owner",
        reviewerIdentityId: "owner_identity",
        authority: "owner:assignment_1",
        committedAtMs: (offer.opensAt + 2000) * 1000,
        cue: "not_required",
        score: null,
        rewardReason: "candidate_held",
        chainAdmission: "canonical",
      },
    };
    const dance = danceQualificationEntries([record], {
      ...offer,
      inputHash: rewardHash(7),
      sourceId: rewardHash(8),
    });
    f.setCandidates([
      {
        ...learner,
        evidenceHash: rewardHash(20),
        completedAt: offer.opensAt + 1000,
      },
      {
        ...learner,
        evidenceHash: rewardHash(21),
        completedAt: offer.opensAt + 1500,
      },
      ...dance,
    ]);
    f.setNow(offer.cutoffAt);
    const closed = await f.offers.close(offer.offerId);
    assert.equal(closed.entries?.length, 1);
    assert.equal(closed.entries[0].evidenceHash, rewardHash(20));
    assert.equal((await f.offers.close(offer.offerId)).entries?.length, 1);
  } finally {
    await f.dispose();
  }
});
