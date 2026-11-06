// The operator's durable transaction sender (docs/operator-payments.md 8).
// Work is persisted as an intent, keyed by kind and reference, before any RPC
// call. Dispatching an intent allocates its nonce exactly once; transaction
// status is then tracked per nonce until the nonce is consumed on chain, even
// after the purchase it was meant for has been confirmed or has failed.
import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { check } from "../packages/protocol/index.ts";
import {
  receiptSucceeded,
  type Receipt,
} from "../packages/protocol/payments.ts";
import { gasPrice, pendingNonce, receiptOf, sendRaw, rpc } from "./chain.ts";
import type { Env, Store } from "./runtime.ts";

/** Record intents are sent in order by the publisher (services/records.ts), never by recovery. */
export type TxKind =
  | "redeem"
  | "close"
  | "record_activate"
  | "record_initialize"
  | "record_open"
  | "record_line"
  | "record_complete"
  | "record_enroll"
  | "record_revoke"
  | "record_result";
/** A signed EIP-7702 authorization, as JSON stores it. */
export interface StoredAuthorization {
  address: Address;
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
}
export interface Intent {
  kind: TxKind;
  ref: string;
  to: Address;
  data: Hex;
  gas: string;
  nonce: number | null;
  /** Present only for an EIP-7702 transaction, such as a learner account's activation. */
  authorizationList?: StoredAuthorization[];
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
  maxFeePerGas?: string;
  authorizationList?: StoredAuthorization[];
  raw?: Hex;
  hash?: Hex;
  mined: null | { status: "success" | "reverted"; block: number };
}
/** A structural store also lets the manual runner use a private SQLite journal. */
export type TxStore = Pick<
  Store,
  "get" | "set" | "delete" | "entries" | "transaction"
>;
export interface FeeLimits {
  maxFeePerGas: bigint;
  maxTotalFee: bigint;
}
export const maximumFee = (row: TxRow) =>
  BigInt(row.gas) *
  (row.authorizationList
    ? BigInt(row.maxFeePerGas ?? (BigInt(row.gasPrice) * 2n).toString())
    : BigInt(row.gasPrice));
const intentKey = (kind: TxKind, ref: string) => `intent:${kind}:${ref}`;
const txKey = (nonce: number) => `tx:${String(nonce).padStart(10, "0")}`;
export const intentOf = (store: TxStore, kind: TxKind, ref: string) =>
  store.get<Intent>(intentKey(kind, ref));
export const txRow = (store: TxStore, nonce: number) =>
  store.get<TxRow>(txKey(nonce));
const realtime = (env: Env) => env.REALTIME_RPC === "1";
const dataFeeAbi = parseAbi(["function getL1Fee(bytes data) view returns (uint256)"]);
async function checkDataFee(env: Env, row: TxRow) {
  if (!env.RESULTS_V2_CONTRACT || row.chainId === 31337) return;
  check(env.SPONSOR_DATA_FEE_WEI && /^\d+$/.test(env.SPONSOR_DATA_FEE_WEI), "data_fee_limit_unconfigured");
  const data = encodeFunctionData({ abi: dataFeeAbi, functionName: "getL1Fee", args: [row.raw!] });
  const response = await rpc<Hex>(env.RPC_URL, "eth_call", [{ to: "0x420000000000000000000000000000000000000F", data }, "latest"]);
  const fee = decodeFunctionResult({ abi: dataFeeAbi, functionName: "getL1Fee", data: response });
  check(fee <= BigInt(env.SPONSOR_DATA_FEE_WEI), "data_fee_above_limit");
}

/** Synchronous and idempotent: records the work before anything can fail. */
export function enqueue(
  store: TxStore,
  kind: TxKind,
  ref: string,
  to: Address,
  data: Hex,
  gas: bigint,
  authorizationList?: StoredAuthorization[],
) {
  const existing = intentOf(store, kind, ref);
  if (existing) return existing;
  const intent: Intent = {
    kind,
    ref,
    to,
    data,
    gas: gas.toString(),
    nonce: null,
    ...(authorizationList ? { authorizationList } : {}),
  };
  store.set(intentKey(kind, ref), intent);
  return intent;
}

function markMined(store: TxStore, nonce: number, receipt: Receipt) {
  store.set(txKey(nonce), {
    ...txRow(store, nonce)!,
    mined: {
      status: receiptSucceeded(receipt) ? "success" : "reverted",
      block: Number(BigInt(receipt.blockNumber)),
    },
  });
}
/** Signing is deterministic, so a crash before storing the bytes re-signs identically. */
async function signed(env: Env, store: TxStore, nonce: number) {
  const row = txRow(store, nonce)!;
  if (row.raw && row.hash) return row;
  const account = privateKeyToAccount(env.PRIVATE_KEY);
  const common = {
    chainId: row.chainId,
    nonce: row.nonce,
    to: row.to,
    data: row.data,
    gas: BigInt(row.gas),
    value: 0n,
  };
  const raw = row.authorizationList
    ? await account.signTransaction({
        ...common,
        type: "eip7702",
        maxFeePerGas: BigInt(
          row.maxFeePerGas ?? (BigInt(row.gasPrice) * 2n).toString(),
        ),
        maxPriorityFeePerGas: BigInt(row.gasPrice),
        authorizationList: row.authorizationList.map((a) => ({
          ...a,
          yParity: a.yParity,
        })),
      })
    : await account.signTransaction({
        ...common,
        type: "legacy",
        gasPrice: BigInt(row.gasPrice),
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
export async function dispatch(
  env: Env,
  store: TxStore,
  kind: TxKind,
  ref: string,
  limits?: FeeLimits,
) {
  let intent = intentOf(store, kind, ref);
  if (!intent) return undefined;
  if (intent.nonce === null) {
    const fee = await gasPrice(env.RPC_URL);
    check(!limits || fee <= limits.maxFeePerGas, "gas_price_above_limit");
    if (store.get("op:nonce") === undefined) {
      const nonce = await pendingNonce(
        env.RPC_URL,
        privateKeyToAccount(env.PRIVATE_KEY).address,
      );
      if (store.get("op:nonce") === undefined) store.set("op:nonce", nonce);
    }
    // Local fault injection: fails the allocation after the nonce advances.
    const failAllocation = store.get("fault:fail-allocation") === true;
    if (failAllocation) store.delete("fault:fail-allocation");
    // Synchronous, so a concurrent dispatch that got here first already
    // allocated; and atomic, so the nonce never advances without its
    // transaction row and the intent's link to it.
    intent = store.transaction(() => {
      const current = intentOf(store, kind, ref)!;
      if (current.nonce !== null) return current;
      const maxFeePerGas = current.authorizationList
        ? limits && limits.maxFeePerGas < fee * 2n
          ? limits.maxFeePerGas
          : fee * 2n
        : fee;
      if (limits) {
        const reserved = store
          .entries("tx:")
          .reduce((sum, { value }) => sum + maximumFee(value as TxRow), 0n);
        check(
          reserved + BigInt(current.gas) * maxFeePerGas <= limits.maxTotalFee,
          "total_fee_limit",
        );
      }
      const nonce = store.get<number>("op:nonce")!;
      store.set("op:nonce", nonce + 1);
      if (failAllocation) throw new Error("simulated_allocation_failure");
      store.set(txKey(nonce), {
        nonce,
        kind,
        ref,
        chainId: Number(env.PAYMENT_CHAIN_ID),
        to: current.to,
        data: current.data,
        gas: current.gas,
        gasPrice: fee.toString(),
        ...(current.authorizationList
          ? { maxFeePerGas: maxFeePerGas.toString() }
          : {}),
        ...(current.authorizationList
          ? { authorizationList: current.authorizationList }
          : {}),
        mined: null,
      } satisfies TxRow);
      const allocated = { ...current, nonce };
      store.set(intentKey(kind, ref), allocated);
      return allocated;
    });
  }
  const row = await signed(env, store, intent.nonce!);
  if (row.mined) return row;
  if (store.get("fault:crash-before-broadcast")) {
    store.delete("fault:crash-before-broadcast");
    throw new Error("simulated_crash_before_broadcast");
  }
  await checkDataFee(env, row);
  const receipt =
    (await receiptOf(env.RPC_URL, row.hash!)) ??
    (await sendRaw(env.RPC_URL, row.raw!, row.hash!, realtime(env)));
  if (receipt) markMined(store, row.nonce, receipt);
  return txRow(store, row.nonce);
}

/**
 * Dispatches payment intents that never got a nonce, then resolves every unmined
 * nonce in order by rebroadcasting its stored bytes. A redemption that became
 * moot reverts and still consumes its nonce, so a later closure can execute.
 */
export async function recoverTransactions(
  env: Env, store: TxStore,
  readyToBroadcast: (row: TxRow) => Promise<boolean> = async () => true,
) {
  let resolved = 0;
  for (const { value } of store.entries("intent:")) {
    const intent = value as Intent;
    if (intent.nonce === null && !intent.kind.startsWith("record_"))
      await dispatch(env, store, intent.kind, intent.ref).catch(
        () => undefined,
      );
  }
  for (const { value } of store.entries("tx:")) {
    const row = value as TxRow;
    if (row.mined) continue;
    // Keep the nonce prefix intact while a caller's frozen work is not ready.
    if (!(await readyToBroadcast(row))) break;
    const ready = await signed(env, store, row.nonce);
    await checkDataFee(env, ready);
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
export async function refresh(env: Env, store: TxStore, nonce: number) {
  const row = txRow(store, nonce);
  if (!row || row.mined || !row.hash) return row;
  const receipt = await receiptOf(env.RPC_URL, row.hash);
  if (receipt) markMined(store, nonce, receipt);
  return txRow(store, nonce);
}
