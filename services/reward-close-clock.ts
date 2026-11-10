import { insist } from "../packages/community/common.ts";

export interface RewardCloseClock {
  chainId(): Promise<number>;
  safeTimestampSeconds(): Promise<bigint>;
}

/** Uses the same safe-head source as qualification. No transaction is submitted. */
export async function confirmedRewardTimestamp(
  clock: RewardCloseClock,
  expectedChainId: number,
): Promise<number> {
  insist(
    (await clock.chainId()) === expectedChainId,
    "wrong_reward_close_chain",
    503,
  );
  const milliseconds = (await clock.safeTimestampSeconds()) * 1000n;
  insist(
    milliseconds >= 0n && milliseconds <= BigInt(Number.MAX_SAFE_INTEGER),
    "invalid_reward_close_clock",
    503,
  );
  return Number(milliseconds);
}
