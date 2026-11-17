/** Composition doubles, not canonical verdict/provider evidence. The separate
 * V2-reader fixture supplies actual ABI-encoded RPC observations when requested. */
import assert from "node:assert/strict";
import { hashJson } from "../../packages/community/common.ts";
import type { QualificationEntry, RewardOfferInput, RewardsProfile } from "../../packages/rewards/contracts.ts";
import { offerInput } from "../../packages/rewards/offers.ts";
import { rewardTestProfile } from "../manual-rewards-fixture.ts";
import { rewardDanceV2Fixture, word } from "./reward-dance-v2.ts";
import type { CategoricalRewardReader, CategoricalRewardSourcesInput } from "../../services/reward-sources.ts";

export function categoricalSelectionFixture() {
  const chain = rewardDanceV2Fixture();
  const original = word(4100), a = chain.source.sourceHash, b = word(4102);
  const profile: RewardsProfile = { ...rewardTestProfile, mode: "live-testnet", resultSourceHash: original };
  type Cutoff = Parameters<CategoricalRewardReader["verifyAt"]>[0];
  const state = {
    entries: new Map<string, QualificationEntry[]>([[a, []], [b, []]]),
    policies: new Map([[a, word(4110)], [b, word(4111)]]),
    reads: [] as { hash: string; offer: RewardOfferInput; inputHash: string; fromBlock: bigint; cutoff: Cutoff }[],
    verifies: [] as { hash: string; cutoff: Cutoff }[],
    unavailable: new Set<string>(),
    afterRead: undefined as (() => void) | undefined,
  };
  const categorical = new Map<string, CategoricalRewardReader>();
  for (const hash of [a, b]) categorical.set(hash, {
    fromBlock: chain.source.pin.deploymentBlock,
    async verifyAt(cutoff) {
      state.verifies.push({ hash, cutoff: structuredClone(cutoff) });
      if (state.unavailable.has(hash)) throw Error("fixture_categorical_unavailable");
      return state.policies.get(hash)!;
    },
    async read(offer, inputHash, fromBlock, cutoff) {
      assert.equal(inputHash, hashJson(offerInput(offer)), "read uses the attached offer hash, never selection defaults");
      state.reads.push({ hash, offer: structuredClone(offer), inputHash, fromBlock, cutoff: structuredClone(cutoff) });
      if (state.unavailable.has(hash)) throw Error("fixture_categorical_unavailable");
      state.afterRead?.();
      return structuredClone(state.entries.get(hash)!);
    },
  });
  const input: CategoricalRewardSourcesInput = {
    profile, reads: { client: chain.client }, categorical, current: a, defaults: [a],
  };
  return { chain, profile, original, a, b, state, categorical, input };
}
