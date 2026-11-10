import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rewardCloseReadiness,
  closeAvailability,
} from "../apps/web/src/wallet/close-readiness.ts";
import { rewardCutoffBlock } from "../services/reward-sources.ts";

test("projected close availability matches actual chain-safe cutoff acceptance, including the exact second", async () => {
  const cutoffAt = 1000000,
    offer = { offerId: "offer_001", state: "open", cutoffAt };
  const read = async (number: bigint) => ({
    number,
    timestamp: 998n + number,
    hash: `0x${"11".repeat(32)}` as `0x${string}`,
  });
  const waiting = rewardCloseReadiness(
    [offer],
    cutoffAt + 1000,
    cutoffAt - 1000,
  );
  assert.equal(closeAvailability(offer, waiting, cutoffAt + 1000).ready, false);
  await assert.rejects(
    rewardCutoffBlock(0n, { number: 1n, timestamp: 999n }, cutoffAt, read),
    /reward_cutoff_not_confirmed/,
  );
  const at = rewardCloseReadiness([offer], cutoffAt, cutoffAt);
  assert.equal(closeAvailability(offer, at, cutoffAt).ready, true);
  // Even though confirmation is inclusive, the last accepted entry block is strictly before cutoff.
  assert.equal(
    (
      await rewardCutoffBlock(
        0n,
        { number: 2n, timestamp: 1000n },
        cutoffAt,
        read,
      )
    ).number,
    1n,
  );
  assert.equal(
    rewardCloseReadiness([offer], cutoffAt - 1, cutoffAt).offers.offer_001
      .state,
    "before_cutoff",
  );
  assert.equal(
    rewardCloseReadiness([offer], cutoffAt, null).offers.offer_001.state,
    "unavailable",
  );
});
