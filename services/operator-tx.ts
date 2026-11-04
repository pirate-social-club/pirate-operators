// The operator's durable transaction sender (docs/operator-payments.md 8).
// Transaction status is tracked per nonce, separately from purchase status:
// a nonce stays tracked until it is consumed on chain, even after the
// purchase it was meant for has been confirmed or has failed.
import { keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Receipt } from "../packages/protocol/payments.ts";
import { receiptSucceeded } from "../packages/protocol/payments.ts";
import { gasPrice, pendingNonce, receiptOf, sendRaw } from "./chain.ts";
import type { Env, Store } from "./runtime.ts";

export interface TxRow {
  nonce: number;
  kind: "redeem" | "close";
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
const txKey = (nonce: number) => `tx:${String(nonce).padStart(10, "0")}`;
export const txRow = (store: Store, nonce: number) => store.get<TxRow>(txKey(nonce));
const realtime = (env: Env) => env.REALTIME_RPC === "1";

function markMined(store: Store, nonce: number, receipt: Receipt) {
  const row = txRow(store, nonce)!;
  store.set(txKey(nonce), {
    ...row,
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

/** Allocates a nonce and persists the transaction before any broadcast. */
export async function send(
  env: Env,
  store: Store,
  kind: TxRow["kind"],
  ref: string,
  to: Address,
  data: Hex,
  gas: bigint,
) {
  const account = privateKeyToAccount(env.PRIVATE_KEY);
  const fee = await gasPrice(env.RPC_URL);
  if (store.get("op:nonce") === undefined) {
    const nonce = await pendingNonce(env.RPC_URL, account.address);
    if (store.get("op:nonce") === undefined) store.set("op:nonce", nonce);
  }
  // Synchronous: allocate and persist the intent before signing or broadcasting.
  const nonce = store.get<number>("op:nonce")!;
  store.set("op:nonce", nonce + 1);
  store.set(txKey(nonce), {
    nonce,
    kind,
    ref,
    chainId: Number(env.PAYMENT_CHAIN_ID),
    to,
    data,
    gas: gas.toString(),
    gasPrice: fee.toString(),
    mined: null,
  } satisfies TxRow);
  const row = await signed(env, store, nonce);
  if (store.get("fault:crash-before-broadcast")) {
    store.delete("fault:crash-before-broadcast");
    throw new Error("simulated_crash_before_broadcast");
  }
  const receipt = await sendRaw(env.RPC_URL, row.raw!, row.hash!, realtime(env));
  if (receipt) markMined(store, nonce, receipt);
  return { nonce, receipt };
}

/**
 * Resolves every unmined nonce in order by rebroadcasting its stored bytes.
 * A redemption that became moot reverts and still consumes its nonce, so a
 * later closure can execute. It never signs a new transaction for a nonce.
 */
export async function recoverTransactions(env: Env, store: Store) {
  let resolved = 0;
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
/** Refreshes one row's mined state from its receipt without rebroadcasting. */
export async function refresh(env: Env, store: Store, nonce: number) {
  const row = txRow(store, nonce);
  if (!row || row.mined || !row.hash) return row;
  const receipt = await receiptOf(env.RPC_URL, row.hash);
  if (receipt) markMined(store, nonce, receipt);
  return txRow(store, nonce);
}
