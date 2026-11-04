// Operator side of OperatorPayments purchases (docs/operator-payments.md 3.3, 5.3).
import {
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  recoverAddress,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { check, supportedChain, type Signed, type Ticket } from "../packages/protocol/index.ts";
import {
  admissionUnit,
  paymentsAbi,
  purchaseDigestOf,
  purchaseMessage,
  quoteIdOf,
  segmentUnit,
  unitHash,
  CLOCK_SKEW_S,
  MAX_AUTHORIZATION_LIFETIME_S,
  ZERO_BYTES32,
  type KaraokeManifest,
  type OperatorQuote,
  type Purchase,
  type RedemptionRef,
  type SignedPurchase,
} from "../packages/protocol/payments.ts";
import { getLogs, readPayments } from "./chain.ts";
import { dispatch, enqueue, intentOf, refresh } from "./operator-tx.ts";
import type { Env, Store } from "./runtime.ts";

export function operatorQuote(env: Env): OperatorQuote {
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  return {
    operator: env.OPERATOR_ADDRESS,
    recipient: env.OPERATOR_ADDRESS,
    chainId: supportedChain(Number(env.PAYMENT_CHAIN_ID ?? 31337)),
    payments: (env.PAYMENTS_CONTRACT ?? zero) as Address,
    token: (env.PAYMENT_TOKEN ?? zero) as Address,
    admissionPrice: "2000",
    segmentPrice: env.SEGMENT_PRICE ?? "1000",
    scoringPolicy: "karaoke-scoring/5",
    maxSegmentMs: 10000,
    maxUnpaidRun: 2,
    validFrom: 1800000000,
    validUntil: 1900000000,
  };
}

export interface RedemptionRow {
  unit: Hex;
  digest: Hex;
  purchase: Purchase;
  signature: Hex;
  state: "submitted" | "confirmed" | "already_paid" | "failed";
  segmentId: string | null;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const redemptionRow = (store: Store, unit: Hex) =>
  store.get<RedemptionRow>(`redemption:${unit}`);

export type PurchaseScope =
  | { kind: "segment"; socketTicketId?: string }
  | { kind: "admission"; jobId: Hex };

/** Reads contract state to settle a row; the stored digest is authoritative. */
async function resolve(env: Env, store: Store, unit: Hex) {
  const row = redemptionRow(store, unit)!;
  if (row.state !== "submitted") return row;
  const quote = operatorQuote(env);
  const onChain = await readPayments<Hex>(env.RPC_URL, quote.payments, "redemption", [
    row.purchase.community,
    unit,
  ]);
  const intent = intentOf(store, "redeem", unit);
  const tx = intent?.nonce == null ? undefined : await refresh(env, store, intent.nonce);
  const state: RedemptionRow["state"] =
    onChain === row.digest
      ? "confirmed"
      : onChain !== ZERO_BYTES32
        ? "already_paid"
        : tx?.mined || row.purchase.expiresAt <= store.now()
          ? "failed"
          : "submitted";
  const next = { ...redemptionRow(store, unit)!, state };
  store.set(`redemption:${unit}`, next);
  return next;
}
const outcome = (row: RedemptionRow) => {
  if (row.state === "confirmed") return { state: row.state, segmentId: row.segmentId };
  throw new Error(
    row.state === "already_paid"
      ? "already_paid"
      : row.state === "failed"
        ? "redemption_failed"
        : "redemption_pending",
  );
};

/**
 * Section 3.3: checks the purchase against the quote and ticket, recovers its
 * signer against the contract, then redeems it. `gate` runs synchronously
 * just before the row is written, so finalization can refuse late purchases.
 */
export async function acceptPurchase(
  env: Env,
  store: Store,
  input: SignedPurchase,
  scope: PurchaseScope,
  gate: () => void = () => {},
) {
  const p = input?.purchase;
  const quote = operatorQuote(env);
  const quoteId = quoteIdOf(quote);
  check(
    p &&
      same(p.operator, quote.operator) &&
      same(p.recipient, quote.recipient) &&
      same(p.token, quote.token) &&
      p.quoteId === quoteId &&
      Number.isSafeInteger(p.validAfter) &&
      Number.isSafeInteger(p.expiresAt) &&
      p.expiresAt - p.validAfter <= MAX_AUTHORIZATION_LIFETIME_S &&
      p.validAfter <= store.now() + CLOCK_SKEW_S,
    "invalid_purchase",
  );
  check(p.expiresAt > store.now(), "purchase_expired");
  let segmentId: string | null = null;
  if (scope.kind === "segment") {
    const ticket = store.get<Signed<Ticket>>(`ticket:${p.ticketId}`)?.body;
    check(
      ticket &&
        same(ticket.community, p.community) &&
        ticket.quoteId === quoteId &&
        ticket.operator === quote.operator &&
        p.expiresAt <= ticket.expiresAt &&
        (scope.socketTicketId === undefined || scope.socketTicketId === p.ticketId),
      "invalid_purchase",
    );
    const manifest = store.get<KaraokeManifest>(`manifest:${ticket.manifestSha256}`)!;
    segmentId =
      manifest.segments.find(
        (s) => unitHash(segmentUnit(ticket.ticketId, s.segmentId, 0)) === p.unit,
      )?.segmentId ?? null;
    check(segmentId && p.amount === quote.segmentPrice, "invalid_purchase");
  } else
    check(
      p.ticketId === ZERO_BYTES32 &&
        p.unit === unitHash(admissionUnit(scope.jobId)) &&
        p.amount === quote.admissionPrice,
      "invalid_purchase",
    );
  const digest = purchaseDigestOf(p, quote.chainId, quote.payments);
  let recovered: Address;
  try {
    recovered = await recoverAddress({ hash: digest, signature: input.signature });
  } catch {
    throw new Error("invalid_purchase");
  }
  const signer = await readPayments<Address>(env.RPC_URL, quote.payments, "signer", [
    p.community,
  ]);
  check(signer !== zeroAddress && same(recovered, signer), "invalid_purchase");
  const key = `redemption:${p.unit}`;
  const existing = redemptionRow(store, p.unit);
  if (existing) {
    check(existing.digest === digest, "already_paid");
    // A retry pushes accepted work forward, including an intent that an RPC
    // failure left without a nonce.
    if (existing.state === "submitted")
      await dispatch(env, store, "redeem", p.unit).catch(() => undefined);
    return outcome(await resolve(env, store, p.unit));
  }
  const onChain = await readPayments<Hex>(env.RPC_URL, quote.payments, "redemption", [
    p.community,
    p.unit,
  ]);
  check(onChain === ZERO_BYTES32 || onChain === digest, "already_paid");
  if (onChain === ZERO_BYTES32) {
    const deposit = await readPayments<bigint>(env.RPC_URL, quote.payments, "balance", [
      p.community,
      p.token,
    ]);
    check(deposit >= BigInt(p.amount), "insufficient_deposit");
  }
  const shifted = store.get<number>("fault:clock-after-verify");
  if (shifted !== undefined) {
    store.delete("fault:clock-after-verify");
    store.set("clock", shifted);
  }
  // Synchronous from the gate to the row write: acceptance and finalization
  // cannot interleave.
  gate();
  const raced = redemptionRow(store, p.unit);
  if (raced) {
    check(raced.digest === digest, "already_paid");
    return outcome(await resolve(env, store, p.unit));
  }
  store.set(key, {
    unit: p.unit,
    digest,
    purchase: p,
    signature: input.signature,
    state: onChain === digest ? "confirmed" : "submitted",
    segmentId,
  } satisfies RedemptionRow);
  // Persisted in the same synchronous step as the row, before any RPC call.
  if (onChain === ZERO_BYTES32)
    enqueue(
      store,
      "redeem",
      p.unit,
      quote.payments,
      encodeFunctionData({
        abi: paymentsAbi,
        functionName: "redeem",
        args: [purchaseMessage(p), input.signature],
      }),
      300_000n,
    );
  if (onChain === ZERO_BYTES32) await dispatch(env, store, "redeem", p.unit);
  return outcome(await resolve(env, store, p.unit));
}

export const closeTicketData = (community: Address, ticketId: Hex) =>
  encodeFunctionData({ abi: paymentsAbi, functionName: "closeTicket", args: [community, ticketId] });
/**
 * Reconciles every segment from contract state at the closure block: a
 * segment is paid when its stored digest matches a Purchased event that names
 * this operator and the quoted terms, whoever redeemed it.
 */
export async function reconcile(
  env: Env,
  ticket: Ticket,
  manifest: KaraokeManifest,
  block: number,
) {
  const quote = operatorQuote(env);
  const blockTag = toHex(block);
  const paid = new Map<string, RedemptionRef>();
  for (const segment of manifest.segments) {
    const unit = unitHash(segmentUnit(ticket.ticketId, segment.segmentId, 0));
    const onChain = await readPayments<Hex>(
      env.RPC_URL,
      quote.payments,
      "redemption",
      [ticket.community, unit],
      blockTag,
    );
    if (onChain === ZERO_BYTES32) continue;
    const logs = await getLogs(env.RPC_URL, {
      address: quote.payments,
      fromBlock: "0x0",
      toBlock: blockTag,
      topics: encodeEventTopics({
        abi: paymentsAbi,
        eventName: "Purchased",
        args: { community: ticket.community, unit },
      }),
    });
    for (const log of logs) {
      const { args } = decodeEventLog({
        abi: paymentsAbi,
        eventName: "Purchased",
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (
        args.digest === onChain &&
        same(args.operator, quote.operator) &&
        same(args.recipient, quote.recipient) &&
        same(args.token, quote.token) &&
        args.amount === BigInt(quote.segmentPrice) &&
        args.quoteId === ticket.quoteId &&
        args.ticketId === ticket.ticketId
      )
        paid.set(segment.segmentId, {
          chainId: quote.chainId,
          payments: quote.payments,
          unit,
          digest: onChain,
          txHash: log.transactionHash,
        });
    }
  }
  return paid;
}
