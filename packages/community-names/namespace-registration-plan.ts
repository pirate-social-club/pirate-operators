import { getAbiItem, hashTypedData, type Address, type Hex } from "viem";
import { bindingKey, namespaceBinding, type NamespaceBinding, type NamespaceBindingPort } from "./namespace-import.ts";
import { NamespaceError, NamespaceRegistryAdapter, address, freeze, hash, identifier, label, namespaceDigest,
  namespaceRegistryAbi, requireNamespace, seconds, sharedNameKeyFor, sharedTokenIdFor,
  uint, type FreeClaim, type NamespaceObservation, type SharedQuote } from "./namespace-registry-adapter.ts";

export interface NamespaceRegistrationRequest { requestId: Hex; label: string; authorizationRef: string }
export interface NamespaceGasBudget {
  policyId: string; periodId: string; payer: Address; submitter: Address; gasLimit: bigint;
  maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; maxTotalWei: bigint;
}
export interface NamespaceMemberAuthorization {
  authorizationRef: string; requestId: Hex; label: string; bindingKey: Hex;
  memberId: string; eligibilitySubject: Hex; membershipRevision: string;
  recipient: Address; evidenceDigest: Hex; validUntil: number; gas: NamespaceGasBudget;
}
/** Existing member service owns authentication, membership, recipient proof,
 * one-use authorization and sponsor eligibility. No member API or policy is
 * implemented by this adapter. Recovery access does not authorize new spending. */
export interface NamespaceMemberAuthorizationPort {
  authorize(binding: NamespaceBinding, request: NamespaceRegistrationRequest): Promise<NamespaceMemberAuthorization>;
  revalidate(binding: NamespaceBinding, original: NamespaceMemberAuthorization): Promise<void>;
  authorizeRecovery(binding: NamespaceBinding, original: NamespaceMemberAuthorization): Promise<void>;
}
export interface NamespaceClaimTiming { collectionMarginSeconds: number; signingMarginSeconds: number; inclusionMarginSeconds: number }
/** Structural accepted SDK PreparedSharedClaim, retaining its original bigint
 * fields. The durable journal must use an explicit lossless bigint codec. */
export interface NamespacePreparedClaim {
  schema: "pirate.member-name-claim/3"; sourceSha256: string; chainId: number; registry: Address;
  claim: FreeClaim; requestHash: Hex; expectedTokenId: bigint; renewalToken: Address;
  annualRenewalPrice: bigint; quoteBlock: { number: bigint; hash: Hex; timestamp: bigint };
  timing: NamespaceClaimTiming; submitBy: bigint;
}
export interface NamespaceRecovery {
  sourceSha256: string; registry: Address; chainId: number; requestHash: Hex;
  state: "pending" | "expired-unconsumed" | "consumed";
  automaticReissueAllowed: false;
  original?: { tokenId: bigint; generation: bigint; recipient: Address; expiry: bigint; annualRenewalPrice: bigint; renewalToken: Address };
  transactionHash?: Hex; expectedTransactionHash?: Hex; transactionHashChanged?: boolean;
  resolutionEligibility?: "not-checked";
  current?: { state: "unavailable"; detail?: string } | { state: "observed"; tokenId: bigint; generation: bigint;
    status: number; registrant: string; expiry: bigint; currentTokenId: bigint; currentGeneration: bigint; currentNameStatus: number };
}
/** Required Root closures around source56 prepareSharedClaim/reconcileSharedClaim
 * with independently selected options. No signer, RPC URL, SDK import or send
 * implementation is accepted from the browser or a different checkout. */
export interface NamespaceSdkPort {
  prepare(input: { binding: NamespaceBinding; requestId: Hex; label: string; recipient: Address;
    timing: NamespaceClaimTiming }): Promise<NamespacePreparedClaim>;
  reconcile(input: { binding: NamespaceBinding; operation: NamespacePreparedClaim;
    authorizeRecovery: () => Promise<void>; expectedTransactionHash?: Hex }): Promise<NamespaceRecovery>;
}
export interface NamespaceRegistrationPlan {
  schema: "pirate.namespace-registration-plan/3"; operationKey: Hex; slot: Hex; requestDigest: Hex;
  request: Readonly<NamespaceRegistrationRequest>; binding: Readonly<NamespaceBinding>;
  authorization: Readonly<NamespaceMemberAuthorization>; prepared: NamespacePreparedClaim;
  nameKey: Hex; name: string; grantSigner: Address; submitter: Address;
  authorityId: Hex; planDigest: Hex; initialTermSeconds: 31536000;
  initialPrice: "0"; maxCost: "0"; nativeValue: "0";
  transactionReady: false; approvalPrepared: false;
}
export interface NamespaceRegistrationRecord {
  plan: NamespaceRegistrationPlan;
  outcome: "prepared" | "pending" | "unknown" | "consumed" | "expired-unconsumed";
  /** Original durable signed-transaction hash; a discovered canonical receipt
   * transaction is separate and must never replace these original send bytes. */
  transactionHash?: Hex; recovery?: NamespaceRecovery | { state: "unknown"; reason: "recovery_unavailable"; automaticReissueAllowed: false };
}
/** Required durable atomic journal. UNIQUE(operationKey), UNIQUE(slot) remain
 * held across grants, member/account changes, revisions, timeouts and restores.
 * claim also atomically reserves the Root-authorized eligibility/period gas
 * allowance; it must not replenish it on retries or credential recreation.
 * Never release/reassign an uncertain slot or overwrite original plan/raw/hash.
 * recordRecovery uses original planDigest CAS and preserves consumed outcomes;
 * an absent receipt, late timeout or changed live holder is not a release grant.
 * Root's sender must persist original signed bytes/hash/nonce before broadcast
 * and recheck membership, epochs, source, scope and bounded gas before effects. */
export interface NamespaceRegistrationJournal {
  find(operationKey: Hex): Promise<NamespaceRegistrationRecord | undefined>;
  claim(plan: NamespaceRegistrationPlan): Promise<{ kind: "created" | "existing"; record: NamespaceRegistrationRecord } | { kind: "conflict" }>;
  recordRecovery(operationKey: Hex, originalPlanDigest: Hex, result: NamespaceRegistrationRecord["recovery"]): Promise<NamespaceRegistrationRecord>;
}

// Exact SDK typed-data derivation: fields are selected from the compiler ABI,
// not a handwritten competing FreeClaim tuple. No signing function lives here.
export function namespaceClaimTypedData(chainId: number, registry: Address, claim: FreeClaim) {
  const fields = getAbiItem({ abi: namespaceRegistryAbi, name: "claimFreeName" }).inputs[0].components.map(f => ({ name: f.name, type: f.type }));
  return { domain: { name: "PirateSharedNames", version: "3", chainId, verifyingContract: registry },
    primaryType: "FreeClaim" as const, types: { FreeClaim: fields }, message: claim };
}
function timing(input: NamespaceClaimTiming): Readonly<NamespaceClaimTiming> {
  const values = [input.collectionMarginSeconds, input.signingMarginSeconds, input.inclusionMarginSeconds];
  requireNamespace(values.every(n => Number.isSafeInteger(n) && n > 0) && values.reduce((a, b) => a + b, 0) <= 900, "invalid_timing_policy");
  return freeze({ collectionMarginSeconds: input.collectionMarginSeconds, signingMarginSeconds: input.signingMarginSeconds, inclusionMarginSeconds: input.inclusionMarginSeconds });
}
function digestPlan(plan: Omit<NamespaceRegistrationPlan, "planDigest">): Hex {
  const { schema, operationKey, slot, requestDigest, request, binding, authorization, prepared, nameKey, name,
    grantSigner, submitter, authorityId, initialTermSeconds, initialPrice, maxCost, nativeValue, transactionReady, approvalPrepared } = plan;
  return namespaceDigest([schema, operationKey, slot, requestDigest, request, bindingKey(binding), authorization, prepared,
    nameKey, name, grantSigner, submitter, authorityId, initialTermSeconds, initialPrice, maxCost, nativeValue, transactionReady, approvalPrepared]);
}
function request(input: NamespaceRegistrationRequest): Readonly<NamespaceRegistrationRequest> {
  hash(input.requestId); label(input.label, 8); identifier(input.authorizationRef);
  return freeze({ requestId: input.requestId, label: input.label, authorizationRef: input.authorizationRef });
}

export class NamespaceRegistrationPlanner {
  #adapter: NamespaceRegistryAdapter; #binding?: NamespaceBindingPort; #membership?: NamespaceMemberAuthorizationPort;
  #sdk?: NamespaceSdkPort; #journal: NamespaceRegistrationJournal; #timing: Readonly<NamespaceClaimTiming>;
  constructor(options: { adapter: NamespaceRegistryAdapter; binding: NamespaceBindingPort | undefined;
    membership: NamespaceMemberAuthorizationPort | undefined; sdk: NamespaceSdkPort | undefined;
    journal: NamespaceRegistrationJournal; timing: NamespaceClaimTiming }) {
    requireNamespace(options.journal && typeof options.journal.find === "function" && typeof options.journal.claim === "function" &&
      typeof options.journal.recordRecovery === "function", "durable_journal_required");
    this.#adapter = options.adapter; this.#binding = options.binding; this.#membership = options.membership;
    this.#sdk = options.sdk; this.#journal = options.journal; this.#timing = timing(options.timing);
  }
  async #context() {
    requireNamespace(this.#binding, "namespace_binding_unavailable");
    return namespaceBinding(await this.#binding.currentBinding());
  }
  #key(b: NamespaceBinding, id: Hex) { return namespaceDigest([b.installationId, b.communityId, id]); }
  async #prepareSdk(input: Parameters<NamespaceSdkPort["prepare"]>[0]) {
    try { return await this.#sdk!.prepare(input); }
    catch (error) { if (error instanceof Error && "code" in error && typeof error.code === "string" &&
      ["free_quote_unavailable", "stale_observation", "authority_read_failed"].includes(error.code)) throw error;
      throw new NamespaceError("shared_claim_preparation_failed"); }
  }
  #authorization(a: NamespaceMemberAuthorization, b: NamespaceBinding, r: NamespaceRegistrationRequest, o: NamespaceObservation) {
    identifier(a.memberId); identifier(a.membershipRevision); hash(a.eligibilitySubject); hash(a.evidenceDigest);
    requireNamespace(a.authorizationRef === r.authorizationRef && a.requestId === r.requestId && a.label === r.label &&
      a.bindingKey === bindingKey(b) && address(a.recipient) === a.recipient, "member_authorization_mismatch");
    requireNamespace(seconds(a.validUntil) > this.#adapter.now(), "member_authorization_expired");
    const g = a.gas; identifier(g.policyId); identifier(g.periodId); address(g.payer);
    for (const n of [g.gasLimit, g.maxFeePerGas, g.maxPriorityFeePerGas, g.maxTotalWei]) uint(n);
    // A contract submitter may have a separately authorized outer gas payer.
    // Root's actual execution port must qualify that path before any send.
    requireNamespace(address(g.submitter) === address(o.scope.submitter) && g.gasLimit > 0n && g.maxFeePerGas > 0n &&
      g.maxPriorityFeePerGas <= g.maxFeePerGas && g.gasLimit * g.maxFeePerGas <= g.maxTotalWei, "gas_budget_exceeded");
  }
  #prepared(p: NamespacePreparedClaim, b: NamespaceBinding, r: NamespaceRegistrationRequest, recipient: Address) {
    const c = p.claim;
    requireNamespace(p.schema === "pirate.member-name-claim/3" && p.sourceSha256 === b.sourceSha256 &&
      p.chainId === this.#adapter.profile.source.chainId && address(p.registry) === this.#adapter.profile.source.registry &&
      c.requestId === r.requestId && c.communityId === b.communityId && c.namespaceId === b.namespaceId &&
      c.label === r.label && address(c.recipient) === recipient && c.years_ === 1 && c.maxCost === 0n, "prepared_claim_mismatch");
    for (const n of [c.generation, c.authorityRevision, c.policyRevision, c.scopeRevision, c.issuedAt, c.deadline]) uint(n, 64);
    requireNamespace(c.generation > 0n && c.deadline >= c.issuedAt && c.deadline - c.issuedAt <= 900n &&
      c.issuedAt === p.quoteBlock.timestamp && p.requestHash === hashTypedData(namespaceClaimTypedData(p.chainId, p.registry, c)) &&
      p.expectedTokenId === sharedTokenIdFor(sharedNameKeyFor(c.namespaceId, c.label), c.generation), "prepared_identity_mismatch");
    hash(p.quoteBlock.hash); uint(p.quoteBlock.number); uint(p.quoteBlock.timestamp); uint(p.annualRenewalPrice);
    requireNamespace(address(p.renewalToken) === this.#adapter.profile.source.constructor.paymentToken &&
      namespaceDigest(timing(p.timing)) === namespaceDigest(this.#timing) &&
      p.submitBy === c.deadline - BigInt(this.#timing.signingMarginSeconds + this.#timing.inclusionMarginSeconds), "prepared_terms_mismatch");
  }
  #quote(p: NamespacePreparedClaim, q: SharedQuote, o: NamespaceObservation) {
    const c = p.claim;
    requireNamespace(q.authorityRevision === c.authorityRevision && q.policyRevision === c.policyRevision && q.scopeRevision === c.scopeRevision &&
      q.generation === c.generation && q.annualRenewalPrice === p.annualRenewalPrice && address(q.renewalToken) === p.renewalToken &&
      (q.reservedFor === "0x0000000000000000000000000000000000000000" || address(q.reservedFor) === address(c.recipient)) &&
      c.deadline < o.authority.validUntil, "quote_changed");
  }
  #window(p: NamespacePreparedClaim) {
    const required = this.#timing.collectionMarginSeconds + this.#timing.signingMarginSeconds + this.#timing.inclusionMarginSeconds;
    requireNamespace(p.claim.issuedAt <= BigInt(this.#adapter.now()) && p.claim.deadline - BigInt(this.#adapter.now()) >= BigInt(required), "claim_window_insufficient");
  }
  #record(record: NamespaceRegistrationRecord) {
    const p = record.plan;
    requireNamespace(p.schema === "pirate.namespace-registration-plan/3" && p.planDigest === digestPlan(p) &&
      ["prepared", "pending", "unknown", "consumed", "expired-unconsumed"].includes(record.outcome) &&
      p.initialTermSeconds === 31536000 && p.initialPrice === "0" && p.maxCost === "0" && p.nativeValue === "0" &&
      p.transactionReady === false && p.approvalPrepared === false, "corrupt_original_plan");
    if (record.transactionHash) hash(record.transactionHash);
    if (record.outcome === "consumed") {
      requireNamespace(record.recovery?.state === "consumed", "receipt_missing");
      this.#recovery(p.prepared, record.recovery);
    }
    // Preserve recorded source, community and claim independently of current
    // installation selection. Root's original-source SDK validates recovery.
    const c = p.prepared.claim;
    requireNamespace(p.operationKey === this.#key(p.binding, p.request.requestId) && p.requestDigest === namespaceDigest(p.request) &&
      p.slot === namespaceDigest([p.binding.installationId, p.binding.namespaceId, p.nameKey]) &&
      p.nameKey === sharedNameKeyFor(p.binding.namespaceId, p.request.label) && p.name === `${p.request.label}.${p.binding.issuanceTld}` &&
      c.requestId === p.request.requestId && c.communityId === p.binding.communityId && c.namespaceId === p.binding.namespaceId &&
      c.label === p.request.label && c.recipient === p.authorization.recipient && c.years_ === 1 && c.maxCost === 0n &&
      p.prepared.sourceSha256 === p.binding.sourceSha256 && p.prepared.expectedTokenId === sharedTokenIdFor(p.nameKey, c.generation) &&
      p.prepared.requestHash === hashTypedData(namespaceClaimTypedData(p.prepared.chainId, p.prepared.registry, c)), "corrupt_original_plan");
  }
  #recovery(p: NamespacePreparedClaim, result: NamespaceRecovery) {
    const c = p.claim;
    requireNamespace(result.sourceSha256 === p.sourceSha256 && result.chainId === p.chainId && address(result.registry) === address(p.registry) &&
      result.requestHash === p.requestHash && result.automaticReissueAllowed === false &&
      ["pending", "expired-unconsumed", "consumed"].includes(result.state), "receipt_identity_mismatch");
    if (result.state === "consumed") {
      const receipt = result.original; requireNamespace(receipt && result.transactionHash && result.resolutionEligibility === "not-checked", "receipt_missing"); hash(result.transactionHash);
      requireNamespace(receipt.tokenId === p.expectedTokenId && receipt.generation === c.generation && address(receipt.recipient) === address(c.recipient) &&
        receipt.annualRenewalPrice === p.annualRenewalPrice && address(receipt.renewalToken) === address(p.renewalToken), "receipt_identity_mismatch");
      uint(receipt.expiry, 64);
    }
  }
  async prepare(input: NamespaceRegistrationRequest): Promise<NamespaceRegistrationRecord> {
    const r = request(input), b = await this.#context(), key = this.#key(b, r.requestId);
    const existing = await this.#journal.find(key);
    requireNamespace(this.#membership, "member_authorization_unavailable");
    if (existing) {
      this.#record(existing);
      requireNamespace(existing.plan.requestDigest === namespaceDigest(r), "operation_identity_conflict");
      await this.#membership.authorizeRecovery(existing.plan.binding, existing.plan.authorization);
      return freeze(structuredClone(existing));
    }
    requireNamespace(this.#sdk, "shared_sdk_unavailable");
    requireNamespace(b.sourceSha256 === this.#adapter.profile.sourceSha256, "source_pin_mismatch");
    const o = await this.#adapter.observe(b.issuanceTld, b.communityId);
    const a = freeze(structuredClone(await this.#membership.authorize(b, r))); this.#authorization(a, b, r, o);
    const initial = await this.#adapter.quote(o, r.label);
    requireNamespace(initial.reservedFor === "0x0000000000000000000000000000000000000000" || address(initial.reservedFor) === a.recipient, "quote_changed");
    const prepared = freeze(structuredClone(await this.#prepareSdk({ binding: b, requestId: r.requestId, label: r.label, recipient: a.recipient, timing: this.#timing })));
    this.#prepared(prepared, b, r, a.recipient);
    const current = await this.#adapter.observe(b.issuanceTld, b.communityId), quote = await this.#adapter.quote(current, r.label);
    requireNamespace(current.authorityId === o.authorityId, "authority_changed"); this.#quote(prepared, quote, current);
    this.#authorization(a, b, r, current);
    await this.#membership.revalidate(b, a);
    requireNamespace(bindingKey(await this.#context()) === bindingKey(b), "namespace_binding_changed"); this.#window(prepared);
    requireNamespace(this.#adapter.now() < current.validUntil && this.#adapter.now() < a.validUntil, "plan_expired");
    const nameKey = sharedNameKeyFor(b.namespaceId, r.label);
    const fields = { schema: "pirate.namespace-registration-plan/3" as const, operationKey: key,
      slot: namespaceDigest([b.installationId, b.namespaceId, nameKey]), requestDigest: namespaceDigest(r), request: r, binding: b,
      authorization: a, prepared, nameKey, name: `${r.label}.${b.issuanceTld}`, grantSigner: address(current.policy.grantSigner),
      submitter: address(current.scope.submitter), authorityId: current.authorityId, initialTermSeconds: 31536000 as const,
      initialPrice: "0" as const, maxCost: "0" as const, nativeValue: "0" as const, transactionReady: false as const, approvalPrepared: false as const };
    const plan = freeze({ ...fields, planDigest: digestPlan(fields) }); this.#record({ plan, outcome: "prepared" });
    const result = await this.#journal.claim(plan);
    requireNamespace(result.kind !== "conflict", "registration_reconciliation_required"); this.#record(result.record);
    requireNamespace(result.record.plan.requestDigest === plan.requestDigest, "operation_identity_conflict");
    if (result.kind === "existing") await this.#membership.authorizeRecovery(result.record.plan.binding, result.record.plan.authorization);
    return freeze(structuredClone(result.record));
  }
  async reconcile(requestId: Hex): Promise<NamespaceRegistrationRecord> {
    hash(requestId); const b = await this.#context(), key = this.#key(b, requestId), saved = await this.#journal.find(key);
    requireNamespace(saved, "original_operation_unknown"); this.#record(saved);
    requireNamespace(this.#membership, "member_authorization_unavailable");
    const original = freeze(structuredClone(saved));
    const authorizeRecovery = () => this.#membership!.authorizeRecovery(original.plan.binding, original.plan.authorization);
    await authorizeRecovery();
    let recovery: NamespaceRegistrationRecord["recovery"];
    try {
      requireNamespace(this.#sdk, "shared_sdk_unavailable");
      const result = await this.#sdk.reconcile({ binding: original.plan.binding, operation: original.plan.prepared,
        authorizeRecovery, expectedTransactionHash: original.transactionHash });
      this.#recovery(original.plan.prepared, result);
      // Accepted SDK separately qualifies original canonical receipt/events and
      // current holder/status. Current unavailability cannot erase consumption.
      recovery = freeze(structuredClone({ ...result, current: result.current?.state === "unavailable" ? { state: "unavailable" as const } : result.current }));
    } catch {
      // Unknown transport/proof outcome is retained; never allocate a new ID,
      // release a name/budget, infer unused or leak RPC/credential diagnostics.
      recovery = { state: "unknown", reason: "recovery_unavailable", automaticReissueAllowed: false };
    }
    const result = await this.#journal.recordRecovery(key, original.plan.planDigest, recovery); this.#record(result);
    requireNamespace(result.plan.planDigest === original.plan.planDigest, "operation_identity_conflict");
    return freeze(structuredClone(result));
  }
}
