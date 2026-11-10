import type { RewardWalletView } from "../../../../packages/rewards/contracts.ts";
import { parseRewardTransactionResult } from "../../../../packages/rewards/transaction-result.ts";
import {
  connectRewardWallet,
  type RewardMoss,
  type RewardWalletOutcome,
} from "../live/reward-wallet.ts";

export interface HostedSendRecord {
  schema: "pirate.hosted-send/1";
  attemptId: string;
  sender: string;
  token: string;
  chainId: 6343;
  startedAt: number;
  outcome: "opening" | "unknown" | "submitted";
  hash?: string;
}
export type SendStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface SendLock {
  exclusive<T>(key: string, work: () => Promise<T>): Promise<T>;
}
export function hostedSendKey(view: RewardWalletView) {
  if (
    view.schema !== "pirate.learner-wallet/1" ||
    view.chainId !== 6343 ||
    !/^0x[0-9a-fA-F]{40}$/.test(view.address) ||
    BigInt(view.address) === 0n ||
    !/^0x[0-9a-fA-F]{40}$/.test(view.token) ||
    BigInt(view.token) === 0n
  )
    throw Error("This wallet is available on testnet only.");
  return `pirate.hosted-send/1:${view.chainId}:${view.address.toLowerCase()}:${view.token.toLowerCase()}`;
}
export function readHostedSend(
  view: RewardWalletView,
  storage: SendStorage,
): HostedSendRecord | null {
  const raw = storage.getItem(hostedSendKey(view));
  if (raw === null) return null;
  let value: HostedSendRecord;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Error(
      "Saved Send status cannot be read. Check MOSS history before another Send.",
    );
  }
  if (
    !value ||
    value.schema !== "pirate.hosted-send/1" ||
    value.chainId !== 6343 ||
    value.sender !== view.address.toLowerCase() ||
    value.token !== view.token.toLowerCase() ||
    typeof value.attemptId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(value.attemptId) ||
    !Number.isSafeInteger(value.startedAt) ||
    value.startedAt < 0 ||
    !["opening", "unknown", "submitted"].includes(value.outcome) ||
    (value.hash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(value.hash))
  )
    throw Error(
      "Saved Send status cannot be read. Check MOSS history before another Send.",
    );
  return value;
}
export function browserSendLock(): SendLock {
  return {
    async exclusive(key, work) {
      if (!navigator.locks)
        throw Error(
          "This browser cannot safely coordinate Send. Open MOSS to send and check its history.",
        );
      return navigator.locks.request(
        key,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw Error("Send is already open in another tab.");
          return work();
        },
      );
    },
  };
}
/** Hosted plain transfers have no idempotency key: never automatically reopen or retry. */
export async function sendHostedReward(
  view: RewardWalletView,
  storage: SendStorage,
  lock: SendLock,
  load: () => Promise<RewardMoss> = async () =>
    (await import("@megaeth-labs/wallet-sdk")).mega,
  signal?: AbortSignal,
): Promise<RewardWalletOutcome> {
  const key = hostedSendKey(view);
  return lock.exclusive(key, async () => {
    if (readHostedSend(view, storage))
      throw Error(
        "A previous Send needs a wallet history check. It will not be repeated.",
      );
    const moss = await connectRewardWallet(view.address, load);
    if (signal?.aborted) throw Error("Send was closed before dispatch.");
    if (!moss.send)
      throw Error("MOSS Send is unavailable. Open your wallet to continue.");
    const record: HostedSendRecord = {
      schema: "pirate.hosted-send/1",
      attemptId: crypto.randomUUID(),
      sender: view.address.toLowerCase(),
      token: view.token.toLowerCase(),
      chainId: 6343,
      startedAt: Date.now(),
      outcome: "opening",
    };
    // A storage failure must prevent a request from reaching the wallet.
    storage.setItem(key, JSON.stringify(record));
    let result: unknown;
    try {
      result = await moss.send({ token: view.token as `0x${string}` });
    } catch {
      result = null;
    }
    const parsed = parseRewardTransactionResult(result, {
      network: "testnet",
      expectedAccountVerified: true,
    });
    const declined = parsed.outcome === "cancelled" && !parsed.hash;
    if (declined) storage.removeItem(key);
    else
      storage.setItem(
        key,
        JSON.stringify({
          ...record,
          outcome: parsed.hash ? "submitted" : "unknown",
          ...(parsed.hash ? { hash: parsed.hash } : {}),
        }),
      );
    return {
      outcome:
        parsed.outcome === "cancelled" && parsed.hash
          ? "unknown"
          : parsed.outcome,
      ...(parsed.hash ? { hash: parsed.hash } : {}),
    };
  });
}
