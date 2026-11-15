import { exact, insist, object } from "../community/common.ts";

export type MemberHex = `0x${string}`;
export type NativeProfileDigest = string & { readonly nativeProfileDigest: unique symbol };
/** Exact native canonical SHA256 wire, without prefixing or rehashing. */
export function nativeProfileDigest(value: unknown): NativeProfileDigest {
  memberRequire(typeof value==="string" && value.length===64 && !/[^0-9a-f]/.test(value),"service_unavailable",503);
  return value as NativeProfileDigest;
}
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface JoinInput { idempotencyKey: string }
export type CommunityJoinView = { schema: "pirate.community-join/1"; ownerScope: string; revision: number } & (
  | { state: "not_joined" }
  | { state: "accepted"; receipt: { joinId: string; acceptedAtMs: number } }
  | { state: "unknown"; retryAfterMs: number }
  | { state: "blocked"; reason: "admission_refused" | "policy_unavailable" | "service_unavailable"; correction: string }
);
export interface PrepareNameInput { idempotencyKey: string; label: string }
export interface ConsentNameInput { planDigest: MemberHex; recipientSignature: MemberHex }
export interface ReconcileNameInput { planDigest: MemberHex }
export interface NameClaimRef { requestId: MemberHex; planDigest: MemberHex; label: string; name: string }
export interface NameTerms {
  initialPriceAtomic: "0"; initialTermDays: 365;
  annualRenewal: { token: MemberHex; amountAtomic: string };
  gas: { payerAddress: MemberHex; maxTotalWei: string };
}
/** Exact reviewed successor payload comes from required preparation/verification
 * ports. Phase1 neither transcribes an unselected V4 tuple nor uses V3 fallback. */
export interface ClaimAcceptanceWire {
  domain: { name: string; version: string; chainId: 6343 | 31337; verifyingContract: MemberHex };
  primaryType: "ClaimAcceptance";
  types: { [name: string]: { name: string; type: string }[] };
  message: { [key: string]: Json };
}
export interface NameReceipt { transactionHash: MemberHex; tokenId: string; generation: string; expiryMs: number; blockNumber: string; blockHash: MemberHex }
export type NameRefusal = "invalid_label" | "name_taken" | "name_reserved" | "not_free" | "budget_exhausted" |
  "authority_changed" | "issuer_unavailable" | "recipient_unsupported" | "request_conflict" | "service_unavailable";
export type MemberNameView = { schema: "pirate.member-name/1"; ownerScope: string; revision: number; recipient: MemberHex; tld: string } & (
  | { state: "idle"; claim: null }
  | { state: "awaiting_consent"; claim: NameClaimRef; terms: NameTerms; consent: { digest: MemberHex; expiresAtMs: number; typedData: ClaimAcceptanceWire } }
  | { state: "queued" | "pending" | "unknown"; claim: NameClaimRef; terms: NameTerms; retryAfterMs: number }
  | { state: "blocked" | "expired_unconsumed"; claim: NameClaimRef | null; reason: NameRefusal; correction: string }
  | { state: "consumed"; claim: NameClaimRef; terms: NameTerms; receipt: NameReceipt; usability: "not_checked" | "usable" | "not_usable" | "unknown" }
);
export class MemberError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}
export function memberRequire(value: unknown, code: string, status = 409): asserts value { if (!value) throw new MemberError(code, status); }
export function idempotency(value: unknown): string {
  memberRequire(typeof value === "string" && value.length >= 16 && value.length <= 128 && !/[^a-zA-Z0-9_-]/.test(value), "request_conflict", 400); return value;
}
export function memberDigest(value: unknown): MemberHex {
  memberRequire(typeof value === "string" && value.length === 66 && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0+$/.test(value), "request_conflict", 400);
  return value as MemberHex;
}
export function canonicalMemberLabel(value: unknown): string {
  memberRequire(typeof value === "string" && value.length >= 8 && value.length <= 63 &&
    /^(?!..--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) && !/[^a-z0-9-]/.test(value), "invalid_label", 422);
  return value;
}
export function parseJoin(value: unknown): JoinInput {
  const o = object(value); exact(o, ["idempotencyKey"]); return { idempotencyKey: idempotency(o.idempotencyKey) };
}
export function parsePrepare(value: unknown): PrepareNameInput {
  const o = object(value); exact(o, ["idempotencyKey", "label"]);
  return { idempotencyKey: idempotency(o.idempotencyKey), label: canonicalMemberLabel(o.label) };
}
export function parseConsent(value: unknown): ConsentNameInput {
  const o = object(value); exact(o, ["planDigest", "recipientSignature"]);
  memberRequire(typeof o.recipientSignature === "string" && o.recipientSignature.length <= 32770 && o.recipientSignature.length % 2 === 0 && /^0x(?:[a-fA-F0-9]{2})+$/.test(o.recipientSignature) && !/[^a-fA-F0-9]/.test(o.recipientSignature.slice(2)), "recipient_unsupported", 422);
  return { planDigest: memberDigest(o.planDigest), recipientSignature: o.recipientSignature as MemberHex };
}
export function parseReconcile(value: unknown): ReconcileNameInput {
  const o = object(value); exact(o, ["planDigest"]); return { planDigest: memberDigest(o.planDigest) };
}
export function decimal(value: unknown): string {
  memberRequire(typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && !/[^0-9]/.test(value) && BigInt(value) < 2n ** 256n, "service_unavailable", 503); return value;
}
export function epoch(value: number): number { insist(Number.isSafeInteger(value) && value >= 0, "invalid_member_time", 503); return value; }
export function safeJson(value: unknown, maxBytes = 65536): string {
  // Explicit JSON codec; bigint requires caller's reviewed decimal wire codec.
  function check(v:unknown,depth:number) {
    memberRequire(depth<=48,"service_unavailable",503);
    if(v===null || typeof v==="string" || typeof v==="boolean")return;
    if(typeof v==="number") { memberRequire(Number.isFinite(v),"service_unavailable",503);return; }
    memberRequire(v && typeof v==="object","service_unavailable",503);
    if(Array.isArray(v)) { for(const item of v)check(item,depth+1);return; }
    memberRequire(Object.getPrototypeOf(v)===Object.prototype,"service_unavailable",503);
    for(const [key,item] of Object.entries(v)) { memberRequire(!["__proto__","prototype"].includes(key),"service_unavailable",503);check(item,depth+1); }
  }
  check(value,0);
  let text: string;
  try { text = JSON.stringify(value); } catch { throw new MemberError("service_unavailable", 503); }
  memberRequire(typeof text === "string" && new TextEncoder().encode(text).length <= maxBytes, "service_unavailable", 503);
  memberRequire(!/"(?:__proto__|prototype)"\s*:/.test(text), "service_unavailable", 503); return text;
}
