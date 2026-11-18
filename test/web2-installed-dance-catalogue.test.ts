import assert from "node:assert/strict";
import test from "node:test";
import { assertInstalledRewardDanceSource } from "../services/web2-installed-dance-song.ts";
import { address, rewardDanceV2Fixture, word } from "./fixtures/reward-dance-v2.ts";

test("installed Dance rewards admit the exact complete V2 pin", () => {
  const { source } = rewardDanceV2Fixture();
  const signed = { source, sourceHash: source.sourceHash };
  assert.doesNotThrow(() => assertInstalledRewardDanceSource(signed, structuredClone(source)));
  for (const changed of [
    { ...source, domain: { ...source.domain, communityId: word(90) } },
    { ...source, pin: { ...source.pin, posts: address(91) } },
    { ...source, pin: { ...source.pin, reviewerConsentPolicyHash: word(92) } },
    { ...source, capturePolicy: address(93) },
    { ...source, capturePolicyRuntimeHash: word(94) },
  ]) {
    assert.throws(() => assertInstalledRewardDanceSource(signed, changed), /dance_reward_source_changed/);
  }
});
