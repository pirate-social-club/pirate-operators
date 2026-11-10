import type { RewardWalletView } from "../../../../packages/rewards/contracts.ts";
import { parseRewardTransactionResult } from "../../../../packages/rewards/transaction-result.ts";
import {
  connectRewardWallet,
  type RewardMoss,
  type RewardWalletOutcome,
} from "../live/reward-wallet.ts";

export interface SendLock {
  exclusive<T>(key: string, work: () => Promise<T>): Promise<T>;
}
export function rewardWalletIdentity(view: RewardWalletView) {
  if (
    view.schema !== "pirate.learner-wallet/1" ||
    view.chainId !== 6343 ||
    !/^0x[0-9a-fA-F]{40}$/.test(view.address) ||
    BigInt(view.address) === 0n ||
    !/^0x[0-9a-fA-F]{40}$/.test(view.token) ||
    BigInt(view.token) === 0n
  )
    throw Error("This wallet is available on testnet only.");
  return (
    String(view.chainId) +
    ":" +
    view.address.toLowerCase() +
    ":" +
    view.token.toLowerCase()
  );
}
const inFlight = new Set<string>();
export function browserSendLock(): SendLock {
  return {
    async exclusive(key, work) {
      if (navigator.locks)
        return navigator.locks.request(
          "pirate.wallet-navigation/1:" + key,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) throw Error("MOSS is already opening in another tab.");
            return work();
          },
        );
      if (inFlight.has(key)) throw Error("MOSS is already opening.");
      inFlight.add(key);
      try {
        return await work();
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
/** Hosted navigation supplies no recipient, amount or guard and never retries a transfer. */
export async function sendHostedReward(
  view: RewardWalletView,
  lock: SendLock,
  load: () => Promise<RewardMoss> = async () =>
    (await import("@megaeth-labs/wallet-sdk")).mega,
  signal?: AbortSignal,
): Promise<RewardWalletOutcome> {
  return lock.exclusive(rewardWalletIdentity(view), async () => {
    const moss = await connectRewardWallet(view.address, load);
    if (signal?.aborted) throw Error("Send was closed before opening.");
    if (!moss.send)
      throw Error("MOSS Send is unavailable. Open your wallet to continue.");
    let result: unknown;
    try {
      result = await moss.send({ token: view.token as `0x${string}` });
    } catch {
      return { outcome: "unknown" };
    }
    const parsed = parseRewardTransactionResult(result, {
      network: "testnet",
      expectedAccountVerified: true,
    });
    return {
      outcome:
        parsed.outcome === "cancelled" && parsed.hash
          ? "unknown"
          : parsed.outcome,
      ...(parsed.hash ? { hash: parsed.hash } : {}),
    };
  });
}
