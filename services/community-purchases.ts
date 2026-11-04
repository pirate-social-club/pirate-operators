// Community side of OperatorPayments purchases (docs/operator-payments.md 5, 7).
// The community signs purchases and sends no per-line transaction.
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { check, verify, type Signed, type Ticket } from "../packages/protocol/index.ts";
import {
  admissionUnit,
  paymentWindow,
  quoteIdOf,
  purchaseDigestOf,
  purchaseDomain,
  purchaseMessage,
  purchaseTypes,
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
import { signatureChainId, type Env } from "./runtime.ts";
import type { AsyncStore } from "./storage.ts";

export const COMMUNITY_BUDGET = 1_000_000n;
export const WALLET_ALLOWANCE = 100_000n;

export interface TicketState {
  ticketId: Hex;
  wallet: Address;
  maxAmount: string;
  maxPaidSegments: number;
  authorizedUnits: Hex[];
  startedAt: number | null;
  ended: boolean;
  settled: boolean;
  expiresAt: number;
}
interface WalletState {
  openTicket: Hex | null;
  usage: string;
  sequence: number;
}
const add = (a: string, b: bigint) => (BigInt(a) + b).toString();

/** Reserves a ticket's maximum once, at issuance, with one open ticket per wallet. */
export async function reserveTicket(
  store: AsyncStore,
  wallet: Address,
  ticketIdFor: (sequence: number) => Hex,
  max: bigint,
) {
  let ticketId: Hex | undefined;
  await store.update<WalletState>(`wallet:${wallet}`, (current) => {
    const state = current ?? { openTicket: null, usage: "0", sequence: 0 };
    check(!state.openTicket, "open_ticket_exists");
    check(BigInt(state.usage) + max <= WALLET_ALLOWANCE, "wallet_allowance_exhausted");
    ticketId = ticketIdFor(state.sequence);
    return { openTicket: ticketId, usage: add(state.usage, max), sequence: state.sequence + 1 };
  });
  try {
    await store.update<string>("usage:community", (current) => {
      check(BigInt(current ?? "0") + max <= COMMUNITY_BUDGET, "community_budget_exhausted");
      return add(current ?? "0", max);
    });
  } catch (error) {
    await store.update<WalletState>(`wallet:${wallet}`, (state) => ({
      ...state!,
      openTicket: null,
      usage: add(state!.usage, -max),
    }));
    throw error;
  }
  return ticketId!;
}

const signPurchase = (env: Env, quote: OperatorQuote, purchase: Purchase) =>
  privateKeyToAccount(env.PRIVATE_KEY).signTypedData({
    domain: purchaseDomain(quote.chainId, quote.payments),
    types: purchaseTypes,
    primaryType: "Purchase",
    message: purchaseMessage(purchase),
  });
const context = async (store: AsyncStore, ticketId: string) => {
  const ticket = (await store.get<Signed<Ticket>>(`ticket:${ticketId}`))?.body;
  check(ticket, "ticket_not_found");
  const quote = (await store.get<OperatorQuote>(`quote:${ticket.quoteId}`))!;
  const manifest = (await store.get<KaraokeManifest>(`manifest:${ticket.manifestSha256}`))!;
  return { ticket, quote, manifest };
};

/**
 * Section 5.4: authenticates, returns an existing purchase before any limit,
 * and otherwise applies the limits atomically before signing.
 */
export async function signSegmentPurchase(
  env: Env,
  store: AsyncStore,
  wallet: Address,
  input: { ticketId: Hex; segmentId: string; take: number; attemptStart?: Signed<AttemptStart> },
): Promise<SignedPurchase> {
  const { ticket, quote, manifest } = await context(store, input.ticketId);
  check(ticket.participant === wallet, "ticket_not_found");
  const segment = manifest.segments.find((s) => s.segmentId === input.segmentId);
  check(segment && Number.isSafeInteger(input.take) && input.take >= 0, "unknown_segment");
  const unit = unitHash(segmentUnit(ticket.ticketId, segment.segmentId, input.take));
  const existing = await store.get<SignedPurchase>(`purchase:${unit}`);
  if (existing) return existing;
  if (input.attemptStart) {
    const start = await verify(
      input.attemptStart,
      "attempt_start",
      env.OPERATOR_ADDRESS,
      signatureChainId(env),
    );
    check(start.ticketId === ticket.ticketId, "attempt_start_mismatch");
    await store.update<TicketState>(`kt:${ticket.ticketId}`, (state) => ({
      ...state!,
      startedAt: state!.startedAt ?? start.startedAt,
    }));
  }
  const now = await store.now();
  await store.update<TicketState>(`kt:${ticket.ticketId}`, (state) => {
    check(state && state.startedAt !== null, "attempt_not_started");
    const window = paymentWindow(state.startedAt, segment, now);
    check(window !== "early", "purchase_window_not_open");
    check(window === "open", "purchase_window_closed");
    check(!state.ended && now < state.expiresAt, "ticket_closed");
    check(input.take === 0, "invalid_take");
    check(state.authorizedUnits.length < state.maxPaidSegments, "purchase_limit_reached");
    return { ...state, authorizedUnits: [...state.authorizedUnits, unit] };
  });
  // Deterministic: the same unit always yields the same purchase and signature.
  const purchase: Purchase = {
    community: ticket.community,
    unit,
    ticketId: ticket.ticketId,
    quoteId: ticket.quoteId,
    operator: quote.operator,
    recipient: quote.recipient,
    token: quote.token,
    amount: quote.segmentPrice,
    validAfter: ticket.issuedAt - CLOCK_SKEW_S,
    expiresAt: ticket.expiresAt,
  };
  const signed = { purchase, signature: await signPurchase(env, quote, purchase) };
  if (!(await store.insertIfAbsent(`purchase:${unit}`, signed))) {
    await store.update<TicketState>(`kt:${ticket.ticketId}`, (state) => ({
      ...state!,
      authorizedUnits: state!.authorizedUnits.filter((u, i, all) => u !== unit || all.indexOf(u) !== i),
    }));
    return (await store.get<SignedPurchase>(`purchase:${unit}`))!;
  }
  return signed;
}

/** Section 4: one purchase per song revision, counted against the community budget. */
export async function signAdmissionPurchase(
  env: Env,
  store: AsyncStore,
  quote: OperatorQuote,
  jobId: Hex,
) {
  const unit = unitHash(admissionUnit(jobId));
  const existing = await store.get<SignedPurchase>(`purchase:${unit}`);
  if (existing) return existing;
  const price = BigInt(quote.admissionPrice);
  await store.update<string>("usage:community", (current) => {
    check(BigInt(current ?? "0") + price <= COMMUNITY_BUDGET, "community_budget_exhausted");
    return add(current ?? "0", price);
  });
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
  if (!(await store.insertIfAbsent(`purchase:${unit}`, signed))) {
    await store.update<string>("usage:community", (current) => add(current ?? "0", -price));
    return (await store.get<SignedPurchase>(`purchase:${unit}`))!;
  }
  return signed;
}

export async function markTicketEnded(env: Env, store: AsyncStore, ticketId: string) {
  await store.update<TicketState>(`kt:${ticketId}`, (state) => ({ ...state!, ended: true }));
  await settleTicket(env, store, ticketId);
}
/**
 * Once a ticket's purchases can no longer be redeemed, because its result was
 * signed after closure or its purchases expired, the reserved maximum is
 * replaced by what the contract actually paid for those exact purchases.
 */
export async function settleTicket(env: Env, store: AsyncStore, ticketId: string) {
  const state = await store.get<TicketState>(`kt:${ticketId}`);
  if (!state || state.settled) return;
  if (!state.ended && (await store.now()) < state.expiresAt) return;
  const { ticket, quote } = await context(store, ticketId);
  let paid = 0n;
  for (const unit of state.authorizedUnits) {
    const signed = await store.get<SignedPurchase>(`purchase:${unit}`);
    if (!signed) continue;
    const onChain = await readPayments<Hex>(env.RPC_URL, quote.payments, "redemption", [
      ticket.community,
      unit,
    ]);
    if (onChain === purchaseDigestOf(signed.purchase, quote.chainId, quote.payments))
      paid += BigInt(signed.purchase.amount);
  }
  const released = BigInt(state.maxAmount) - paid;
  // The settled flag is the compare-and-set gate, so usage is released once.
  try {
    await store.update<TicketState>(`kt:${ticketId}`, (current) => {
      check(!current!.settled, "already_settled");
      return { ...current!, settled: true };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "already_settled") return;
    throw error;
  }
  await store.update<string>("usage:community", (current) => add(current ?? "0", -released));
  await store.update<WalletState>(`wallet:${state.wallet}`, (wallet) => ({
    ...wallet!,
    usage: add(wallet!.usage, -released),
    openTicket: wallet!.openTicket === ticketId ? null : wallet!.openTicket,
  }));
}
export async function communityTick(env: Env, store: AsyncStore) {
  if (!env.RPC_URL) return;
  for (const { key } of await store.entries("kt:")) await settleTicket(env, store, key.slice(3));
}
