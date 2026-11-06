// Community side of OperatorPayments purchases (docs/operator-payments.md 5, 7).
// The community signs purchases and sends no per-line transaction. Every
// state change that must happen together lives in one record: a wallet's
// open ticket and usage share its wallet record, and a purchase row is
// inserted by one statement that also enforces the ticket's purchase count.
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { check, sign, verify, type Signed, type Ticket } from "../packages/protocol/index.ts";
import {
  admissionUnit,
  paymentWindow,
  purchaseDigestOf,
  purchaseDomain,
  purchaseMessage,
  purchaseTypes,
  quoteIdOf,
  segmentUnit,
  unitHash,
  CLOCK_SKEW_S,
  ZERO_BYTES32,
  type AttemptStart,
  type KaraokeManifest,
  type OperatorQuote,
  type Purchase,
  type SignedPurchase,
} from "../packages/protocol/payments.ts";
import { readPayments } from "./chain.ts";
import type { Env } from "./runtime.ts";
import { call, signatureChainId } from "./service-call.ts";
import type { AsyncStore } from "./storage.ts";

/** Per-wallet sponsorship allowance. The contract deposit caps the community. */
export const WALLET_ALLOWANCE = 100_000n;

/** Everything a ticket is built from, so its signed body can always be rebuilt. */
export interface Reservation {
  ticketId: Hex;
  songHash: Hex;
  sessionKey: Address;
  quoteId: Hex;
  manifestSha256: Hex;
  maxPaidSegments: number;
  maxAmount: string;
  maxDurationMs: number;
  issuedAt: number;
  expiresAt: number;
  startedAt: number | null;
}
export interface WalletState {
  usage: string;
  sequence: number;
  open: Reservation | null;
}
const walletKey = (wallet: Address) => `wallet:${wallet}`;
const purchasePrefix = (ticketId: Hex) => `purchase:${ticketId}:`;
const add = (a: string, b: bigint) => (BigInt(a) + b).toString();

/**
 * One compare-and-set reserves the ticket's maximum and records the open
 * ticket. A retry with the same song and key returns the same reservation.
 */
export async function openTicket(
  store: AsyncStore,
  wallet: Address,
  spec: Omit<Reservation, "ticketId" | "startedAt">,
  ticketIdFor: (sequence: number) => Hex,
) {
  const state = await store.update<WalletState>(walletKey(wallet), (current) => {
    const w = current ?? { usage: "0", sequence: 0, open: null };
    if (w.open) {
      check(w.open.songHash === spec.songHash, "open_ticket_exists");
      check(w.open.sessionKey === spec.sessionKey, "different_session_key");
      return w;
    }
    check(BigInt(w.usage) + BigInt(spec.maxAmount) <= WALLET_ALLOWANCE, "wallet_allowance_exhausted");
    return {
      usage: add(w.usage, BigInt(spec.maxAmount)),
      sequence: w.sequence + 1,
      open: { ...spec, ticketId: ticketIdFor(w.sequence), startedAt: null },
    };
  });
  return state.open!;
}

/** Rebuilds, signs and delivers the ticket; deterministic, so safe to repeat. */
export async function ensureTicket(
  env: Env,
  store: AsyncStore,
  wallet: Address,
  open: Reservation,
) {
  const manifest = (await store.get<KaraokeManifest>(`manifest:${open.manifestSha256}`))!;
  const body: Ticket = {
    ticketId: open.ticketId,
    communityId: env.COMMUNITY_ID,
    participant: wallet,
    songHash: open.songHash,
    manifestSha256: open.manifestSha256,
    sessionKey: open.sessionKey,
    operator: env.OPERATOR_ADDRESS,
    quoteId: open.quoteId,
    community: env.COMMUNITY_ADDRESS as Address,
    mode: "performance",
    maxPaidSegments: open.maxPaidSegments,
    maxDurationMs: open.maxDurationMs,
    issuedAt: open.issuedAt,
    expiresAt: open.expiresAt,
  };
  const ticket = await sign("ticket", body, env.PRIVATE_KEY, signatureChainId(env));
  await store.set(`ticket:${open.ticketId}`, ticket);
  await call(env.OPERATOR, "/prepare", { ticket, manifest });
  return ticket;
}

const signPurchase = (env: Env, quote: OperatorQuote, purchase: Purchase) =>
  privateKeyToAccount(env.PRIVATE_KEY).signTypedData({
    domain: purchaseDomain(quote.chainId, quote.payments),
    types: purchaseTypes,
    primaryType: "Purchase",
    message: purchaseMessage(purchase),
  });

/**
 * Section 5.4: returns an existing purchase before any limit, otherwise checks
 * the limits and inserts the purchase in one statement that also enforces the
 * ticket's purchase count.
 */
export async function signSegmentPurchase(
  env: Env,
  store: AsyncStore,
  wallet: Address,
  input: { ticketId: Hex; segmentId: string; take: number; attemptStart?: Signed<AttemptStart> },
): Promise<SignedPurchase> {
  check(Number.isSafeInteger(input.take) && input.take >= 0, "unknown_segment");
  const key = `${purchasePrefix(input.ticketId)}${unitHash(segmentUnit(input.ticketId, input.segmentId, input.take))}`;
  const existing = await store.get<SignedPurchase>(key);
  if (existing) {
    const owner = await store.get<Signed<Ticket>>(`ticket:${input.ticketId}`);
    check(owner?.body.participant === wallet, "ticket_not_found");
    return existing;
  }
  let open = (await store.get<WalletState>(walletKey(wallet)))?.open;
  check(open && open.ticketId === input.ticketId, "ticket_closed");
  const manifest = (await store.get<KaraokeManifest>(`manifest:${open.manifestSha256}`))!;
  const quote = (await store.get<OperatorQuote>(`quote:${open.quoteId}`))!;
  const segment = manifest.segments.find((s) => s.segmentId === input.segmentId);
  check(segment, "unknown_segment");
  if (input.attemptStart && open.startedAt === null) {
    const start = await verify(
      input.attemptStart,
      "attempt_start",
      env.OPERATOR_ADDRESS,
      signatureChainId(env),
    );
    check(start.ticketId === open.ticketId, "attempt_start_mismatch");
    const state = await store.update<WalletState>(walletKey(wallet), (w) =>
      w?.open?.ticketId === open!.ticketId && w.open.startedAt === null
        ? { ...w, open: { ...w.open, startedAt: start.startedAt } }
        : w!,
    );
    open = state.open;
    check(open && open.ticketId === input.ticketId, "ticket_closed");
  }
  check(open.startedAt !== null, "attempt_not_started");
  const now = await store.now();
  const window = paymentWindow(open.startedAt, segment, now);
  check(window !== "early", "purchase_window_not_open");
  check(window === "open", "purchase_window_closed");
  check(now < open.expiresAt, "ticket_closed");
  check(input.take === 0, "invalid_take");
  // Deterministic: the same unit always yields the same purchase and signature.
  const purchase: Purchase = {
    community: env.COMMUNITY_ADDRESS as Address,
    unit: unitHash(segmentUnit(open.ticketId, segment.segmentId, input.take)),
    ticketId: open.ticketId,
    quoteId: open.quoteId,
    operator: quote.operator,
    recipient: quote.recipient,
    token: quote.token,
    amount: quote.segmentPrice,
    validAfter: open.issuedAt - CLOCK_SKEW_S,
    expiresAt: open.expiresAt,
  };
  const signed = { purchase, signature: await signPurchase(env, quote, purchase) };
  if (await store.insertIfCountBelow(key, signed, purchasePrefix(open.ticketId), open.maxPaidSegments))
    return signed;
  const raced = await store.get<SignedPurchase>(key);
  check(raced, "purchase_limit_reached");
  return raced;
}

/** Section 4: one purchase per song revision, bounded by the contract deposit. */
export async function signAdmissionPurchase(
  env: Env,
  store: AsyncStore,
  quote: OperatorQuote,
  jobId: Hex,
) {
  const unit = unitHash(admissionUnit(jobId));
  const key = `purchase:admission:${unit}`;
  const existing = await store.get<SignedPurchase>(key);
  if (existing) return existing;
  const now = await store.now();
  const purchase: Purchase = {
    community: env.COMMUNITY_ADDRESS as Address,
    unit,
    ticketId: ZERO_BYTES32,
    quoteId: quoteIdOf(quote),
    operator: quote.operator,
    recipient: quote.recipient,
    token: quote.token,
    amount: quote.admissionPrice,
    validAfter: now - CLOCK_SKEW_S,
    expiresAt: now + 600,
  };
  const signed = { purchase, signature: await signPurchase(env, quote, purchase) };
  if (await store.insertIfAbsent(key, signed)) return signed;
  return (await store.get<SignedPurchase>(key))!;
}

/**
 * Once a ticket's purchases can no longer be redeemed, because its result was
 * signed after closure or its purchases expired, one compare-and-set replaces
 * its reserved maximum with what the contract paid for its exact purchases
 * and closes it. Interrupted, it simply runs again.
 */
export async function settleTicket(
  env: Env,
  store: AsyncStore,
  wallet: Address,
  ticketId: Hex,
  ended: boolean,
) {
  const open = (await store.get<WalletState>(walletKey(wallet)))?.open;
  if (!open || open.ticketId !== ticketId) return;
  if (!ended && (await store.now()) < open.expiresAt) return;
  const quote = (await store.get<OperatorQuote>(`quote:${open.quoteId}`))!;
  let paid = 0n;
  for (const { value } of await store.entries(purchasePrefix(ticketId))) {
    const signed = value as SignedPurchase;
    const onChain = await readPayments<Hex>(env.RPC_URL, quote.payments, "redemption", [
      signed.purchase.community,
      signed.purchase.unit,
    ]);
    if (onChain === purchaseDigestOf(signed.purchase, quote.chainId, quote.payments))
      paid += BigInt(signed.purchase.amount);
  }
  await store.update<WalletState>(walletKey(wallet), (w) =>
    w?.open?.ticketId === ticketId
      ? { ...w, usage: add(w.usage, paid - BigInt(w.open.maxAmount)), open: null }
      : w!,
  );
}
export async function communityTick(env: Env, store: AsyncStore) {
  if (!env.RPC_URL) return;
  const now = await store.now();
  for (const { key, value } of await store.entries("wallet:")) {
    const open = (value as WalletState).open;
    if (open && now >= open.expiresAt)
      await settleTicket(env, store, key.slice("wallet:".length) as Address, open.ticketId, false);
  }
}

/** Fetches and checks the operator's quote against the community's payment profile. */
export async function trustedQuote(env: Env, store: AsyncStore) {
  const signed = await call<Signed<OperatorQuote>>(env.OPERATOR, "/quote", {});
  const quote = await verify(signed, "quote", env.OPERATOR_ADDRESS, signatureChainId(env));
  const now = await store.now();
  check(
    quote.operator.toLowerCase() === env.OPERATOR_ADDRESS.toLowerCase() &&
      quote.chainId === Number(env.PAYMENT_CHAIN_ID) &&
      (quote.serviceMode === "internal") === (env.SERVICE_MODE === "internal") &&
      quote.token.toLowerCase() === env.PAYMENT_TOKEN?.toLowerCase() &&
      quote.payments.toLowerCase() === env.PAYMENTS_CONTRACT?.toLowerCase() &&
      quote.validFrom <= now &&
      now < quote.validUntil,
    "untrusted_quote",
  );
  await store.set(`quote:${quoteIdOf(quote)}`, quote);
  return quote;
}
