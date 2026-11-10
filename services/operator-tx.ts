// The operator's durable transaction sender (docs/operator-payments.md 8).
// Work is persisted as an intent, keyed by kind and reference, before any RPC
// call. Dispatching an intent allocates its nonce exactly once; transaction
// status is then tracked per nonce until the nonce is consumed on chain, even
// after the purchase it was meant for has been confirmed or has failed.
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  serializeTransaction,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { check } from "../packages/protocol/index.ts";
import {
  receiptSucceeded,
  type Receipt,
} from "../packages/protocol/payments.ts";
import {
  gasPrice,
  latestNonce,
  pendingNonce,
  receiptOf,
  sendRaw,
  rpc,
} from "./chain.ts";
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
  | "record_authorize"
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
  /**
   * Record results only, set at allocation: "none" until the first send
   * attempt, then "attempted". While "none", the row's signed bytes have not
   * been given to any RPC: the data fee is priced from the unsigned bytes. A
   * row without it was written before this field existed; whether it was sent
   * is unknown unless it was never signed (no raw bytes and no hash), since
   * every send path signs and stores the bytes first.
   */
  broadcast?: "none" | "attempted";
  /**
   * Set when the work's permission was withdrawn before this row was mined.
   * Its own bytes are never sent again; only its receipt is reconciled.
   */
  withheld?: {
    reason: string;
    at: number;
    /**
     * The head at which the operator's nonce was first seen past this row
     * with no receipt and no known transaction for the row or its
     * cancellation; cleared when either is seen again.
     */
    unexplainedSince?: number;
    /** Journal time this row was recorded superseded, and last re-checked. */
    supersededAt?: number;
    recheckedAt?: number;
  };
  /**
   * For a withheld row proven never sent: the zero-value transfer to the
   * operator's own address, with empty calldata, that consumes the nonce in
   * its place. The row's own fields stay as evidence of the withheld work.
   */
  cancellation?: Cancellation;
  /**
   * "cancelled": the nonce was consumed by the row's cancellation.
   * "superseded": a withheld row whose nonce the chain shows consumed with no
   * receipt or known transaction for the row's own transaction or its
   * cancellation, on reads WITHHELD_SETTLEMENT_DEPTH blocks apart; `block` is
   * the head of the later read. It is an inference, re-checked (see
   * recheckSuperseded). Neither is ever a success.
   */
  mined: null | {
    status: "success" | "reverted" | "cancelled" | "superseded";
    block: number;
  };
}
export interface Cancellation {
  to: Address;
  gas: string;
  gasPrice: string;
  raw?: Hex;
  hash?: Hex;
  status?: "success" | "reverted";
}
/**
 * Withdrawal checks for record work, given by the learning results service.
 * Both answer false for work they do not cover. Payment work passes none.
 */
export interface SendGate {
  /** Synchronous: a withdrawal this journal already records for the work. */
  recorded(kind: TxKind, ref: string): boolean;
  /** Also reads the chain; throws when it cannot tell, so nothing is sent. */
  withheld(kind: TxKind, ref: string): Promise<boolean>;
  reason: string;
  /** The fee limits a cancellation must meet, as any dispatch does. */
  limits(): FeeLimits | undefined;
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
/** A cancelled row costs at most its cancellation; its own bytes are never sent. */
export const maximumFee = (row: TxRow) =>
  row.cancellation
    ? BigInt(row.cancellation.gas) * BigInt(row.cancellation.gasPrice)
    : BigInt(row.gas) *
  (row.authorizationList
    ? BigInt(row.maxFeePerGas ?? (BigInt(row.gasPrice) * 2n).toString())
    : BigInt(row.gasPrice));
const intentKey = (kind: TxKind, ref: string) => `intent:${kind}:${ref}`;
const txKey = (nonce: number) => `tx:${String(nonce).padStart(10, "0")}`;
export const intentOf = (store: TxStore, kind: TxKind, ref: string) =>
  store.get<Intent>(intentKey(kind, ref));
export const txRow = (store: TxStore, nonce: number) =>
  store.get<TxRow>(txKey(nonce));
/**
 * Proven never sent: marked "none" by this code, or a row from before the
 * marker that was never signed. Nothing else counts as evidence.
 */
export const provenUnsent = (row: TxRow) =>
  row.broadcast === "none" ||
  (row.broadcast === undefined && row.raw === undefined && row.hash === undefined);
/**
 * A withheld row that cannot publish: its nonce went to its cancellation or
 * to another transaction, or it was proven never sent. A withheld row whose
 * own transaction is mined is a publication, reported as such.
 */
export const withheldUnpublished = (row: TxRow | undefined) =>
  !!row?.withheld &&
  (row.mined
    ? row.mined.status === "cancelled" || row.mined.status === "superseded"
    : provenUnsent(row));
const realtime = (env: Env) => env.REALTIME_RPC === "1";
/** The journal's own clock when it has one (the operator's store does). */
const journalNow = (store: TxStore) =>
  (store as { now?: () => number }).now?.() ?? Math.floor(Date.now() / 1000);
const dataFeeAbi = parseAbi(["function getL1Fee(bytes data) view returns (uint256)"]);
/**
 * Prices the data fee of `priced`: a row's signed bytes as before, or, for a
 * row still "none" and for a cancellation, the unsigned serialization the
 * oracle accepts, so those signed bytes never reach an RPC before their send.
 */
async function checkDataFee(env: Env, chainId: number, priced: () => Hex) {
  if (!env.RESULTS_V2_CONTRACT || chainId === 31337) return;
  check(env.SPONSOR_DATA_FEE_WEI && /^\d+$/.test(env.SPONSOR_DATA_FEE_WEI), "data_fee_limit_unconfigured");
  const data = encodeFunctionData({ abi: dataFeeAbi, functionName: "getL1Fee", args: [priced()] });
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

/**
 * Removes an intent that never received a nonce, so no path can dispatch it:
 * recovery never allocates for record intents, and a dispatch already past
 * its fee read finds no intent to allocate. Returns false, changing nothing,
 * once a nonce is allocated, because the signed transaction may then be on
 * its way. Call it inside the caller's transaction.
 */
export function discardUnallocated(store: TxStore, kind: TxKind, ref: string) {
  const intent = intentOf(store, kind, ref);
  if (intent?.nonce != null) return false;
  if (intent) store.delete(intentKey(kind, ref));
  return true;
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
/** The nonce was consumed by the cancellation, never by the withheld work. */
function markCancelled(store: TxStore, nonce: number, receipt: Receipt) {
  const row = txRow(store, nonce)!;
  store.set(txKey(nonce), {
    ...row,
    cancellation: {
      ...row.cancellation!,
      status: receiptSucceeded(receipt) ? "success" : "reverted",
    },
    mined: { status: "cancelled", block: Number(BigInt(receipt.blockNumber)) },
  });
}
const unsignedOwn = (row: TxRow) =>
  serializeTransaction({
    type: "legacy",
    chainId: row.chainId,
    nonce: row.nonce,
    to: row.to,
    data: row.data,
    gas: BigInt(row.gas),
    gasPrice: BigInt(row.gasPrice),
    value: 0n,
  });
const ownPriced = (row: TxRow) => () =>
  row.broadcast === "none" ? unsignedOwn(row) : row.raw!;
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
  const current = txRow(store, nonce)!;
  const next: TxRow = {
    ...current,
    raw,
    hash: keccak256(raw),
    // A result row from before the marker, signed only now, was never sent.
    ...(current.kind === "record_result" &&
    current.broadcast === undefined &&
    current.raw === undefined &&
    current.hash === undefined
      ? { broadcast: "none" as const }
      : {}),
  };
  store.set(txKey(nonce), next);
  return next;
}

/**
 * Moves an intent forward: allocates its nonce once, signs, broadcasts and
 * records the receipt. Safe to call repeatedly; an RPC failure before
 * allocation leaves the intent for the next call or recovery. With a gate,
 * a withdrawal the journal records stops the allocation itself, and every
 * send re-checks it (see send). An intent discarded meanwhile allocates
 * nothing.
 */
export async function dispatch(
  env: Env,
  store: TxStore,
  kind: TxKind,
  ref: string,
  limits?: FeeLimits,
  gate?: SendGate,
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
    const allocated = store.transaction(() => {
      const current = intentOf(store, kind, ref);
      if (!current || current.nonce !== null) return current;
      if (gate?.recorded(kind, ref)) return undefined;
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
        ...(kind === "record_result" ? { broadcast: "none" as const } : {}),
        mined: null,
      } satisfies TxRow);
      const next = { ...current, nonce };
      store.set(intentKey(kind, ref), next);
      return next;
    });
    if (!allocated) return undefined;
    intent = allocated;
  }
  const nonce = intent.nonce!;
  if (!txRow(store, nonce)!.withheld) {
    const row = await signed(env, store, nonce);
    if (row.mined) return row;
    if (store.get("fault:crash-before-broadcast")) {
      store.delete("fault:crash-before-broadcast");
      throw new Error("simulated_crash_before_broadcast");
    }
  }
  return send(env, store, nonce, gate);
}

/**
 * Sends one row: a withheld row is settled (see settleWithheld), any other
 * row's own bytes are sent after the gate's checks (see sendOwn).
 */
async function send(env: Env, store: TxStore, nonce: number, gate?: SendGate) {
  const row = txRow(store, nonce)!;
  if (row.mined) return row;
  if (row.withheld) return settleWithheld(env, store, nonce, gate);
  return sendOwn(env, store, nonce, gate);
}

/** Synchronous: records the withdrawal on a row not yet mined or withheld. */
function markWithheld(store: TxStore, nonce: number, reason: string) {
  const current = txRow(store, nonce)!;
  if (current.mined || current.withheld) return current;
  const next: TxRow = {
    ...current,
    withheld: { reason, at: journalNow(store) },
  };
  store.set(txKey(nonce), next);
  return next;
}

/**
 * Records a withdrawal for a row not yet mined. Whether the row was sent is
 * decided from the row as it stands at that moment, in the same synchronous
 * step as the record, so it never races a send.
 */
async function withhold(
  env: Env,
  store: TxStore,
  nonce: number,
  gate: SendGate,
) {
  const row = txRow(store, nonce)!;
  if (row.mined || row.withheld) return row;
  if (
    !gate.recorded(row.kind, row.ref) &&
    !(await gate.withheld(row.kind, row.ref))
  )
    return txRow(store, nonce)!;
  return markWithheld(store, nonce, gate.reason);
}

/**
 * The row's own bytes. The gate's chain read is the last asynchronous step,
 * after the data fee and receipt reads, and the journal's withdrawal is
 * re-checked synchronously just before the send.
 */
async function sendOwn(
  env: Env,
  store: TxStore,
  nonce: number,
  gate?: SendGate,
): Promise<TxRow> {
  const row = await signed(env, store, nonce);
  if (row.mined) return row;
  await checkDataFee(env, row.chainId, ownPriced(row));
  const known = await receiptOf(env.RPC_URL, row.hash!);
  if (known) {
    markMined(store, nonce, known);
    return txRow(store, nonce)!;
  }
  if (gate) await withhold(env, store, nonce, gate);
  // Synchronous from this read to the send.
  let current = txRow(store, nonce)!;
  if (current.mined) return current;
  if (gate?.recorded(current.kind, current.ref))
    current = markWithheld(store, nonce, gate.reason);
  if (current.withheld) return settleWithheld(env, store, nonce, gate);
  if (current.broadcast === "none")
    store.set(txKey(nonce), { ...current, broadcast: "attempted" });
  const receipt = await sendRaw(
    env.RPC_URL,
    current.raw!,
    current.hash!,
    realtime(env),
  );
  if (receipt) markMined(store, nonce, receipt);
  return txRow(store, nonce)!;
}

const warn = (event: string, row: TxRow, extra: Record<string, unknown> = {}) =>
  console.warn(
    JSON.stringify({
      event,
      nonce: row.nonce,
      kind: row.kind,
      ref: row.ref,
      hash: row.hash ?? null,
      broadcast: row.broadcast ?? "unknown",
      reason: row.withheld?.reason ?? null,
      ...extra,
    }),
  );

/**
 * Blocks a withheld row's settlement waits for. MegaETH produces an EVM block
 * about every second, so 64 blocks is about a minute: far beyond the seconds
 * a lagging or load-balanced RPC replica trails the head, and beyond the 12
 * blocks this operator already uses to call a publication confirmed, while a
 * settled row still waits only about a minute. A receipt for the row or its
 * cancellation settles it only once it is this deep, so a short reorg cannot
 * leave a wrong terminal status; a nonce consumed with no receipt and no
 * known transaction is inferred superseded only on two reads at least this
 * many blocks apart.
 */
export const WITHHELD_SETTLEMENT_DEPTH = 64;
/** A superseded row's own receipt is re-read at most this often, for 30 days. */
const SUPERSEDED_RECHECK_S = 600,
  SUPERSEDED_RECHECK_FOR_S = 30 * 86400;
const knownTransaction = async (env: Env, hash?: Hex) =>
  !!hash &&
  (await rpc<unknown>(env.RPC_URL, "eth_getTransactionByHash", [hash])) !==
    null;

/**
 * A withheld row, settled from receipts and chain state only; its own bytes
 * are never sent. Reads are pinned to one head: the operator's nonce at that
 * head, then receipts. Once the nonce is past the row, the row is recorded as
 * mined by its own transaction or its cancellation when that receipt is
 * WITHHELD_SETTLEMENT_DEPTH blocks deep. With no receipt and neither
 * transaction known to the node, the first such read records its head, and
 * only a read at least that depth later that still finds nothing records the
 * row superseded. Before the nonce is passed, a row proven never sent gets a
 * cancellation within the gate's fee limits; when the limits refuse, it waits
 * like any dispatch. A row that may have been sent only waits, and every
 * later nonce waits behind it. Every waiting state is logged.
 */
async function settleWithheld(
  env: Env,
  store: TxStore,
  nonce: number,
  gate?: SendGate,
): Promise<TxRow> {
  let row = txRow(store, nonce)!;
  if (row.mined) return row;
  try {
    const operator = privateKeyToAccount(env.PRIVATE_KEY).address;
    const head = Number(
      BigInt(await rpc<Hex>(env.RPC_URL, "eth_blockNumber", [])),
    );
    const next = Number(
      BigInt(
        await rpc<Hex>(env.RPC_URL, "eth_getTransactionCount", [
          operator,
          "0x" + head.toString(16),
        ]),
      ),
    );
    const note = (unexplainedSince?: number) => {
      const current = txRow(store, nonce)!;
      if (current.mined || current.withheld?.unexplainedSince === unexplainedSince)
        return current;
      const withheld = { ...current.withheld! };
      if (unexplainedSince === undefined) delete withheld.unexplainedSince;
      else withheld.unexplainedSince = unexplainedSince;
      const updated: TxRow = { ...current, withheld };
      store.set(txKey(nonce), updated);
      return updated;
    };
    if (next > nonce) {
      const own = row.hash ? await receiptOf(env.RPC_URL, row.hash) : null;
      const cancelled =
        !own && row.cancellation?.hash
          ? await receiptOf(env.RPC_URL, row.cancellation.hash)
          : null;
      const found = own ?? cancelled;
      if (found) {
        note(undefined);
        const block = Number(BigInt(found.blockNumber));
        if (block + WITHHELD_SETTLEMENT_DEPTH <= head) {
          if (own) markMined(store, nonce, own);
          else markCancelled(store, nonce, found);
          return txRow(store, nonce)!;
        }
        warn("operator_nonce_settling", row, {
          block,
          head,
          depth: WITHHELD_SETTLEMENT_DEPTH,
          by: own ? "own" : "cancellation",
        });
        return txRow(store, nonce)!;
      }
      if (
        (await knownTransaction(env, row.hash)) ||
        (await knownTransaction(env, row.cancellation?.hash))
      ) {
        note(undefined);
        warn("operator_nonce_settling", row, { head, receipt: null });
        return txRow(store, nonce)!;
      }
      const since = row.withheld!.unexplainedSince;
      if (since === undefined || since > head) {
        row = note(head);
        warn("operator_nonce_unexplained", row, {
          head,
          action: `superseded only if still unexplained at block ${head + WITHHELD_SETTLEMENT_DEPTH}`,
        });
        return row;
      }
      if (head < since + WITHHELD_SETTLEMENT_DEPTH) {
        warn("operator_nonce_unexplained", row, { head, since });
        return txRow(store, nonce)!;
      }
      const current = txRow(store, nonce)!;
      if (current.mined) return current;
      store.set(txKey(nonce), {
        ...current,
        withheld: { ...current.withheld!, supersededAt: journalNow(store) },
        mined: { status: "superseded", block: head },
      });
      warn("operator_nonce_superseded", current, { block: head, since });
      return txRow(store, nonce)!;
    }
    if (row.withheld!.unexplainedSince !== undefined) row = note(undefined);
    if (!provenUnsent(row)) {
      warn("operator_nonce_withheld", row, {
        action:
          "not resent after withdrawal; this and every later operator nonce wait until this nonce is consumed on chain",
      });
      return row;
    }
    if (!row.cancellation) {
      const limits = gate?.limits();
      if (!limits) {
        warn("operator_cancellation_waiting", row, {
          error: "sponsor_limits_unconfigured",
        });
        return row;
      }
      row = await prepareCancellation(env, store, nonce, limits);
      if (row.mined || !row.cancellation) return row;
    }
    row = await signedCancellation(env, store, nonce);
    const cancellation = row.cancellation!;
    await checkDataFee(env, row.chainId, () => unsignedCancellation(row));
    // Its receipt settles the row only once deep enough (above).
    if (!(await receiptOf(env.RPC_URL, cancellation.hash!)))
      await sendRaw(
        env.RPC_URL,
        cancellation.raw!,
        cancellation.hash!,
        realtime(env),
      );
    warn("operator_cancellation_pending", row, {
      cancellation: cancellation.hash,
    });
    return txRow(store, nonce)!;
  } catch (error) {
    warn(
      provenUnsent(row) ? "operator_cancellation_waiting" : "operator_nonce_withheld",
      row,
      { error: (error as Error).message },
    );
    throw error;
  }
}
/**
 * Re-reads a superseded row's own receipt, and its cancellation's, and
 * records the row as truly mined when one exists. With `force` (a caller that
 * found the result on chain) it reads at once; otherwise at most every
 * SUPERSEDED_RECHECK_S, for SUPERSEDED_RECHECK_FOR_S after the inference.
 * The application's publication views never depend on it: they read the
 * result's commitment on chain.
 */
export async function recheckSuperseded(
  env: Env,
  store: TxStore,
  nonce: number,
  force = false,
) {
  const row = txRow(store, nonce);
  if (row?.mined?.status !== "superseded") return row;
  const now = journalNow(store),
    since = row.withheld?.supersededAt ?? now;
  if (
    !force &&
    (now - since > SUPERSEDED_RECHECK_FOR_S ||
      now - (row.withheld?.recheckedAt ?? since) < SUPERSEDED_RECHECK_S)
  )
    return row;
  store.set(txKey(nonce), {
    ...row,
    withheld: { ...row.withheld!, recheckedAt: now },
  });
  const own = row.hash ? await receiptOf(env.RPC_URL, row.hash) : null;
  const cancelled =
    !own && row.cancellation?.hash
      ? await receiptOf(env.RPC_URL, row.cancellation.hash)
      : null;
  if (own) {
    markMined(store, nonce, own);
    warn("operator_nonce_superseded_corrected", row, { by: "own" });
  } else if (cancelled) {
    markCancelled(store, nonce, cancelled);
    warn("operator_nonce_superseded_corrected", row, { by: "cancellation" });
  }
  return txRow(store, nonce);
}
/**
 * Settles every withheld row not yet mined, in nonce order, from receipts
 * and chain state, sends pending cancellations, and re-checks superseded
 * rows; nothing else is sent. The regular alarm runs it, so a waiting
 * cancellation or a consumed nonce does not wait for /recover. Failures are
 * logged and left for the next run.
 */
export async function settleWithheldTransactions(
  env: Env,
  store: TxStore,
  gate: SendGate,
) {
  for (const { value } of store.entries("tx:")) {
    const row = value as TxRow;
    if (!row.withheld) continue;
    if (row.mined?.status === "superseded")
      await recheckSuperseded(env, store, row.nonce).catch(() => undefined);
    else if (!row.mined)
      await settleWithheld(env, store, row.nonce, gate).catch(() => undefined);
  }
}

/**
 * Fixes the cancellation's fee within the limits a dispatch uses: the fee
 * read must not exceed maxFeePerGas, its gas must fit the withheld row's own
 * gas limit, and the journal's total, counting this row by its cancellation
 * alone, must stay within maxTotalFee.
 */
async function prepareCancellation(
  env: Env,
  store: TxStore,
  nonce: number,
  limits: FeeLimits,
) {
  const operator = privateKeyToAccount(env.PRIVATE_KEY).address;
  const fee = await gasPrice(env.RPC_URL);
  check(fee <= limits.maxFeePerGas, "gas_price_above_limit");
  const gas = BigInt(
    await rpc<Hex>(env.RPC_URL, "eth_estimateGas", [
      { from: operator, to: operator, value: "0x0" },
    ]),
  );
  return store.transaction(() => {
    const row = txRow(store, nonce)!;
    if (row.mined || row.cancellation || !row.withheld || !provenUnsent(row))
      return row;
    check(gas <= BigInt(row.gas), "cancellation_gas_above_limit");
    const others = store
      .entries("tx:")
      .filter(({ value }) => (value as TxRow).nonce !== nonce)
      .reduce((sum, { value }) => sum + maximumFee(value as TxRow), 0n);
    check(others + gas * fee <= limits.maxTotalFee, "total_fee_limit");
    const next: TxRow = {
      ...row,
      cancellation: { to: operator, gas: gas.toString(), gasPrice: fee.toString() },
    };
    store.set(txKey(nonce), next);
    return next;
  });
}
const unsignedCancellation = (row: TxRow) =>
  serializeTransaction({
    type: "legacy",
    chainId: row.chainId,
    nonce: row.nonce,
    to: row.cancellation!.to,
    data: "0x",
    gas: BigInt(row.cancellation!.gas),
    gasPrice: BigInt(row.cancellation!.gasPrice),
    value: 0n,
  });
/** Deterministic, like `signed`: a crash before storing the bytes re-signs identically. */
async function signedCancellation(env: Env, store: TxStore, nonce: number) {
  const row = txRow(store, nonce)!;
  const cancellation = row.cancellation!;
  if (cancellation.raw && cancellation.hash) return row;
  const raw = await privateKeyToAccount(env.PRIVATE_KEY).signTransaction({
    type: "legacy",
    chainId: row.chainId,
    nonce,
    to: cancellation.to,
    value: 0n,
    data: "0x",
    gas: BigInt(cancellation.gas),
    gasPrice: BigInt(cancellation.gasPrice),
  });
  const current = txRow(store, nonce)!;
  const next: TxRow = {
    ...current,
    cancellation: { ...current.cancellation!, raw, hash: keccak256(raw) },
  };
  store.set(txKey(nonce), next);
  return next;
}

/**
 * Dispatches payment intents that never got a nonce, then resolves every unmined
 * nonce in order by rebroadcasting its stored bytes. A redemption that became
 * moot reverts and still consumes its nonce, so a later closure can execute.
 * With a gate, a withheld row is settled instead (see settleWithheld); while
 * it stays open, later nonces wait behind it.
 */
export async function recoverTransactions(
  env: Env, store: TxStore,
  readyToBroadcast: (row: TxRow) => Promise<boolean> = async () => true,
  gate?: SendGate,
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
    let row = value as TxRow;
    if (row.mined) continue;
    // A failed withdrawal read throws here, before anything is sent.
    if (gate) row = await withhold(env, store, row.nonce, gate);
    if (row.mined) continue;
    if (row.withheld) {
      // Logged inside; an open withheld nonce holds every later one.
      const settled = await settleWithheld(env, store, row.nonce, gate).catch(
        () => row,
      );
      if (!settled.mined) break;
      resolved += 1;
      continue;
    }
    // Keep the nonce prefix intact while a caller's frozen work is not ready.
    if (!(await readyToBroadcast(row))) break;
    const sent = await sendOwn(env, store, row.nonce, gate);
    if (sent.mined) resolved += 1;
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
