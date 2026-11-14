import type { D1Database } from "@cloudflare/workers-types";
import { getAddress, type Address } from "viem";
import type { AccountSession } from "../community/accounts.ts";
import { hashJson, bytes32 } from "../community/common.ts";
import { MemberError, memberRequire, epoch, decimal, safeJson, nativeProfileDigest, type NativeProfileDigest, type MemberHex, type Json,
  type ClaimAcceptanceWire, type NameTerms, type NameReceipt } from "./member-api.ts";

export interface AtomicMemberFence { sql: string; values: (string | number | null)[] }
export interface NameBinding {
  namespaceId: MemberHex; tld: string; sourceSha256: string; interfaceDigest: MemberHex;
  /** No selected scope-safe successor exists at admission time. Root must bind
   * its exact reviewed interface later. V3 is deliberately not executable here. */
  protocolVersion: 4;
}
export interface MemberContext {
  /** Directory bytes32 installation, NOT the Linux installation reference. */
  installationId: MemberHex; linuxInstallationId: string;
  communityId: MemberHex; origin: string; profileDigest: NativeProfileDigest;
  fence: AtomicMemberFence; name?: NameBinding;
}
export interface JoinAdmission {
  policyId: string; revision: string; evidenceDigest: MemberHex; validUntilMs: number;
  fence: AtomicMemberFence;
}
export interface CommunityJoinPolicy {
  authorize(context: MemberContext, session: AccountSession, now: number): Promise<JoinAdmission | null>;
  revalidate(context: MemberContext, session: AccountSession, decision: JoinAdmission, now: number): Promise<void>;
}
export interface BudgetGrant { bucket: MemberHex; role: "community" | "subject"; limitWei: string }
export interface NameAdmission extends JoinAdmission { budgets: BudgetGrant[] }
export interface NamePolicyPort {
  authorize(input: { context: MemberContext; session: AccountSession; joinId: MemberHex; requestId: MemberHex; label: string; now: number }): Promise<NameAdmission>;
  revalidate(input: { context: MemberContext; session: AccountSession; original: NameAdmission; now: number }): Promise<void>;
}
export interface NamePreparation {
  requestId: MemberHex; installationId: MemberHex; communityId: MemberHex; namespaceId: MemberHex;
  sourceSha256: string; interfaceDigest: MemberHex; recipient: Address; label: string;
  expectedTokenId: string; generation: string; terms: NameTerms;
  quote: { basePriceAtomic: string; premiumAtomic: string; effectivePriceAtomic: "0"; maxCostAtomic: "0"; digest: MemberHex; validUntilMs: number };
  consent: { digest: MemberHex; expiresAtMs: number; typedData: ClaimAcceptanceWire };
  /** Lossless JSON envelope from selected actual successor preparation. */
  original: { [key: string]: Json };
}
export interface NamePreparationPort {
  /** REQUIRED real successor: current canonical full-name identity, exact
   * source/authority/scope/policy epochs and caps, locked renewal, effective
   * quote including premium overrides and maxCost=0. No local ready flag. */
  prepare(input: { context: MemberContext; session: AccountSession; admission: NameAdmission; requestId: MemberHex; label: string }): Promise<NamePreparation>;
}
export interface NameConsentEvidence {
  requestId: MemberHex; planDigest: MemberHex; recipient: Address; consentDigest: MemberHex;
  evidenceDigest: MemberHex; validUntilMs: number;
}
export interface NameRecipientVerifier {
  verify(input: { preparation: NamePreparation; planDigest: MemberHex; signature: MemberHex; now: number }): Promise<NameConsentEvidence | null>;
}
export interface NameObservation {
  requestId: MemberHex; planDigest: MemberHex; sourceSha256: string; evidenceDigest: MemberHex;
  observedAtMs: number; validUntilMs: number;
  state: "pending" | "unknown" | "expired_unconsumed" | "consumed";
  receipt?: NameReceipt;
  current?: { state: "unknown" | "not_usable" } | { state: "usable"; recipient: Address; tokenId: string; generation: string; expiresAtMs: number };
}
export interface NameObservationPort {
  /** Genuine original-source canonical receipt AND separate current name check.
   * Read-only; no signing, simulation that sends, allocation or broadcast. */
  observe(input: { context: MemberContext; preparation: NamePreparation; planDigest: MemberHex; artifacts: Readonly<Record<string, string>>; now: number }): Promise<NameObservation>;
}
export interface MemberNamePorts {
  policy?: NamePolicyPort; preparation?: NamePreparationPort;
  recipientVerifier?: NameRecipientVerifier; observation?: NameObservationPort;
}
export function fence(value: AtomicMemberFence): AtomicMemberFence {
  memberRequire(value && typeof value.sql === "string" && value.sql.length > 0 && value.sql.length <= 4096 &&
    !/[;]|--|\/\*/.test(value.sql) && Array.isArray(value.values) && value.values.length <= 128 &&
    (value.sql.match(/\?/g)?.length ?? 0) === value.values.length && value.values.every(v => v === null || typeof v === "string" || (typeof v === "number" && Number.isSafeInteger(v))), "policy_unavailable", 503);
  return { sql: value.sql, values: [...value.values] };
}
export function memberContext(value: MemberContext): MemberContext {
  bytes32(value.installationId); bytes32(value.communityId); nativeProfileDigest(value.profileDigest);
  memberRequire(value.installationId.length===66 && value.communityId.length===66 && typeof value.linuxInstallationId==="string" &&
    value.linuxInstallationId.length>0 && value.linuxInstallationId.length<=200 && /^[a-zA-Z0-9]/.test(value.linuxInstallationId) &&
    !/[^a-zA-Z0-9:._/-]/.test(value.linuxInstallationId),"service_unavailable",503);
  const url = new URL(value.origin);
  memberRequire(url.protocol === "https:" && url.origin === value.origin, "service_unavailable", 503);
  return { ...structuredClone(value), fence: fence(value.fence) };
}
export function requireNameBinding(context: MemberContext): NameBinding {
  const n = context.name; memberRequire(n,"issuer_unavailable",503);
  bytes32(n.namespaceId); bytes32(n.interfaceDigest);
  memberRequire(n.namespaceId.length===66 && n.interfaceDigest.length===66 && n.protocolVersion===4 &&
    n.sourceSha256.length===64 && /^[0-9a-f]{64}$/.test(n.sourceSha256) &&
    /^(?!..--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(n.tld) && !/[^a-z0-9-]/.test(n.tld),"issuer_unavailable",503);
  return n;
}
export function ownerScope(c: MemberContext, s: AccountSession): MemberHex {
  return hashJson([c.installationId, c.linuxInstallationId, c.communityId, c.origin, s.account_id, s.binding_id, getAddress(s.wallet)]);
}
export function sessionFence(c: MemberContext, s: AccountSession, now: number): AtomicMemberFence {
  return { sql: `EXISTS(SELECT 1 FROM community_sessions s JOIN credential_bindings k ON k.binding_id=s.binding_id AND k.account_id=s.account_id
    JOIN community_accounts a ON a.account_id=s.account_id WHERE s.session_hash=? AND s.account_id=? AND s.binding_id=? AND s.expires_at>?
    AND s.community_id=? AND s.community_origin=? AND k.namespace='moss' AND k.network=6343 AND lower(k.subject)=lower(?))`,
    values: [s.session_hash, s.account_id, s.binding_id, epoch(now), c.communityId, c.origin, s.wallet] };
}
export function validateAdmission(d: JoinAdmission, now: number) {
  memberRequire(/^[a-zA-Z0-9_-]{1,128}$/.test(d.policyId) && /^[a-zA-Z0-9_-]{1,128}$/.test(d.revision), "policy_unavailable", 503);
  memberRequire(d.policyId.length<=128 && d.revision.length<=128 && !/[^a-zA-Z0-9_-]/.test(d.policyId+d.revision),"policy_unavailable",503);
  bytes32(d.evidenceDigest); memberRequire(d.evidenceDigest.length===66 && epoch(d.validUntilMs) > now, "policy_unavailable", 503); fence(d.fence);
}
export async function assertMemberContext(db: D1Database, c: MemberContext) {
  const native = await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='native_application_original'").first();
  // Existing native schema manifest is CLOSED. Root must review exact new DDL,
  // signed original/current binding and startup guards before this is mounted.
  if (native) throw new MemberError("native_member_schema_not_admitted", 503);
  const row = await db.prepare("SELECT community_id,community_origin FROM application_identity WHERE id=1").first<{ community_id: string; community_origin: string }>();
  memberRequire(row?.community_id === c.communityId && row.community_origin === c.origin, "service_unavailable", 503);
}
export function validatePreparation(p: NamePreparation, c: MemberContext, s: AccountSession, requestId: MemberHex, label: string, now: number) {
  const n = c.name; memberRequire(n, "issuer_unavailable", 503);
  memberRequire(p.requestId === requestId && p.installationId === c.installationId && p.communityId === c.communityId && p.namespaceId === n.namespaceId &&
    p.sourceSha256 === n.sourceSha256 && p.interfaceDigest === n.interfaceDigest && p.label === label && getAddress(p.recipient) === getAddress(s.wallet), "authority_changed");
  memberRequire(p.terms.initialPriceAtomic === "0" && p.terms.initialTermDays === 365, "not_free");
  memberRequire(p.quote.effectivePriceAtomic==="0" && p.quote.maxCostAtomic==="0" && epoch(p.quote.validUntilMs)>now,"not_free");
  decimal(p.quote.basePriceAtomic); decimal(p.quote.premiumAtomic); bytes32(p.quote.digest); memberRequire(p.quote.digest.length===66,"service_unavailable",503);
  decimal(p.terms.annualRenewal.amountAtomic); decimal(p.terms.gas.maxTotalWei);
  getAddress(p.terms.annualRenewal.token); getAddress(p.terms.gas.payerAddress);
  memberRequire(BigInt(decimal(p.generation)) > 0n, "service_unavailable", 503); decimal(p.expectedTokenId);
  bytes32(p.consent.digest); memberRequire(p.consent.digest.length===66 && epoch(p.consent.expiresAtMs) > now && p.consent.typedData.primaryType === "ClaimAcceptance" &&
    (p.consent.typedData.domain.chainId===31337 || p.consent.typedData.domain.chainId===6343), "authority_changed");
  getAddress(p.consent.typedData.domain.verifyingContract);
  // Exact payload/ABI/domain validation belongs to the required reviewed
  // preparation+recipient verifier. Phase1 cannot choose an unreviewed tuple.
  safeJson(p);
}
