// The operator's durable transaction sender (docs/operator-payments.md 8).
// Work is persisted as an intent, keyed by kind and reference, before any RPC
// call. Dispatching an intent allocates its nonce exactly once; transaction
// status is then tracked per nonce until the nonce is consumed on chain, even
// after the purchase it was meant for has been confirmed or has failed.
import { keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { receiptSucceeded, type Receipt } from "../packages/protocol/payments.ts";
import { gasPrice, pendingNonce, receiptOf, sendRaw } from "./chain.ts";
import type { Env, Store } from "./runtime.ts";

export type TxKind = "redeem" | "close";
export interface Intent {
  kind: TxKind;
  ref: string;
  to: Address;
  data: Hex;
  gas: string;
  nonce: number | null;
}
export interface TxRow {
  nonce: number;
  kind: TxKind;
  ref: string;
  chainId: number;
  to: Address;
  data: Hex;
  gas: string;
  gasPrice: string;
  raw?: Hex;
  hash?: Hex;
  mined: null | { status: "success" | "reverted"; block: number };
}
const intentKey = (kind: TxKind, ref: string) => `intent:${kind}:${ref}`;
const txKey = (nonce: number) => `tx:${String(nonce).padStart(10, "0")}`;
export const intentOf = (store: Store, kind: TxKind, ref: string) =>
  store.get<Intent>(intentKey(kind, ref));
export const txRow = (store: Store, nonce: number) => store.get<TxRow>(txKey(nonce));
const realtime = (env: Env) => env.REALTIME_RPC === "1";

/** Synchronous and idempotent: records the work before anything can fail. */
export function enqueue(store: Store, kind: TxKind, ref: string, to: Address, data: Hex, gas: bigint) {
  const existing = intentOf(store, kind, ref);
  if (existing) return existing;
  const intent: Intent = { kind, ref, to, data, gas: gas.toString(), nonce: null };
  store.set(intentKey(kind, ref), intent);
  return intent;
}

function markMined(store: Store, nonce: number, receipt: Receipt) {
  store.set(txKey(nonce), {
    ...txRow(store, nonce)!,
    mined: {
      status: receiptSucceeded(receipt) ? "success" : "reverted",
      block: Number(BigInt(receipt.blockNumber)),
    },
  });
}
/** Signing is deterministic, so a crash before storing the bytes re-signs identically. */
async function signed(env: Env, store: Store, nonce: number) {
  const row = txRow(store, nonce)!;
  if (row.raw && row.hash) return row;
  const raw = await privateKeyToAccount(env.PRIVATE_KEY).signTransaction({
    type: "legacy",
    chainId: row.chainId,
    nonce: row.nonce,
    to: row.to,
    data: row.data,
    gas: BigInt(row.gas),
    gasPrice: BigInt(row.gasPrice),
    value: 0n,
  });
  const next = { ...txRow(store, nonce)!, raw, hash: keccak256(raw) };
  store.set(txKey(nonce), next);
  return next;
}

/**
 * Moves an intent forward: allocates its nonce once, signs, broadcasts and
 * records the receipt. Safe to call repeatedly; an RPC failure before
 * allocation leaves the intent for the next call or recovery.
 */
export async function dispatch(env: Env, store: Store, kind: TxKind, ref: string) {
  let intent = intentOf(store, kind, ref);
  if (!intent) return undefined;
  if (intent.nonce === null) {
    const fee = await gasPrice(env.RPC_URL);
    if (store.get("op:nonce") === undefined) {
      const nonce = await pendingNonce(env.RPC_URL, privateKeyToAccount(env.PRIVATE_KEY).address);
      if (store.get("op:nonce") === undefined) store.set("op:nonce", nonce);
    }
    // Synchronous: a concurrent dispatch that got here first already allocated.
    intent = intentOf(store, kind, ref)!;
    if (intent.nonce === null) {
      const nonce = store.get<number>("op:nonce")!;
      store.set("op:nonce", nonce + 1);
      store.set(txKey(nonce), {
        nonce,
        kind,
        ref,
        chainId: Number(env.PAYMENT_CHAIN_ID),
        to: intent.to,
        data: intent.data,
        gas: intent.gas,
        gasPrice: fee.toString(),
        mined: null,
      } satisfies TxRow);
      intent = { ...intent, nonce };
      store.set(intentKey(kind, ref), intent);
    }
  }
  const row = await signed(env, store, intent.nonce!);
  if (row.mined) return row;
  if (store.get("fault:crash-before-broadcast")) {
    store.delete("fault:crash-before-broadcast");
    throw new Error("simulated_crash_before_broadcast");
  }
  const receipt =
    (await receiptOf(env.RPC_URL, row.hash!)) ??
    (await sendRaw(env.RPC_URL, row.raw!, row.hash!, realtime(env)));
  if (receipt) markMined(store, row.nonce, receipt);
  return txRow(store, row.nonce);
}

/**
 * Dispatches intents that never got a nonce, then resolves every unmined
 * nonce in order by rebroadcasting its stored bytes. A redemption that became
 * moot reverts and still consumes its nonce, so a later closure can execute.
 */
export async function recoverTransactions(env: Env, store: Store) {
  let resolved = 0;
  for (const { value } of store.entries("intent:")) {
    const intent = value as Intent;
    if (intent.nonce === null)
      await dispatch(env, store, intent.kind, intent.ref).catch(() => undefined);
  }
  for (const { value } of store.entries("tx:")) {
    const row = value as TxRow;
    if (row.mined) continue;
    const ready = await signed(env, store, row.nonce);
    const receipt =
      (await receiptOf(env.RPC_URL, ready.hash!)) ??
      (await sendRaw(env.RPC_URL, ready.raw!, ready.hash!, realtime(env)));
    if (receipt) {
      markMined(store, row.nonce, receipt);
      resolved += 1;
    }
  }
  return { resolved };
}
/** Refreshes one nonce's mined state from its receipt without rebroadcasting. */
export async function refresh(env: Env, store: Store, nonce: number) {
  const row = txRow(store, nonce);
  if (!row || row.mined || !row.hash) return row;
  const receipt = await receiptOf(env.RPC_URL, row.hash);
  if (receipt) markMined(store, nonce, receipt);
  return txRow(store, nonce);
}
