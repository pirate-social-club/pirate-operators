import { randomBytes } from "node:crypto";
import { type Hex } from "viem";
import { NamespaceError, NamespaceRegistryAdapter, freeze, hash, identifier, label,
  namespaceDigest, requireNamespace, seconds, sha256, sharedNamespaceIdFor,
  type NamespaceObservation } from "./namespace-registry-adapter.ts";

/** Root-owned Directory/backend selection. communityId is opaque; never derive it
 * from a registry address. A source/namespace change needs explicit reconciliation. */
export interface NamespaceBinding {
  installationId: Hex; revision: number; communityId: Hex;
  hostingOrigin: string; issuanceTld: string; namespaceId: Hex;
  sourceSha256: string; deploymentIdentityDigest: Hex;
}
export interface NamespaceSelection extends NamespaceBinding { principalId: string }
export function namespaceBinding(input: NamespaceBinding): Readonly<NamespaceBinding> {
  hash(input.installationId); hash(input.communityId); hash(input.namespaceId);
  hash(input.deploymentIdentityDigest); sha256(input.sourceSha256); label(input.issuanceTld);
  requireNamespace(Number.isSafeInteger(input.revision) && input.revision >= 1, "invalid_revision");
  requireNamespace(input.namespaceId === sharedNamespaceIdFor(input.issuanceTld), "namespace_mismatch");
  let origin: URL;
  try { origin = new URL(input.hostingOrigin); } catch { throw new NamespaceError("invalid_hosting_origin"); }
  requireNamespace(origin.protocol === "https:" && origin.origin === input.hostingOrigin && !origin.username && !origin.password, "invalid_hosting_origin");
  return freeze({ installationId: input.installationId, revision: input.revision, communityId: input.communityId,
    hostingOrigin: input.hostingOrigin, issuanceTld: input.issuanceTld, namespaceId: input.namespaceId,
    sourceSha256: input.sourceSha256, deploymentIdentityDigest: input.deploymentIdentityDigest });
}
export function namespaceSelection(input: NamespaceSelection): Readonly<NamespaceSelection> {
  identifier(input.principalId); return freeze({ ...namespaceBinding(input), principalId: input.principalId });
}
export function bindingKey(input: NamespaceBinding): Hex {
  const s = namespaceBinding(input);
  return namespaceDigest([s.installationId, s.revision, s.communityId, s.hostingOrigin, s.issuanceTld, s.namespaceId, s.sourceSha256, s.deploymentIdentityDigest]);
}
export function selectionKey(input: NamespaceSelection): Hex { return namespaceDigest([bindingKey(input), identifier(input.principalId)]); }

/** Required typed join to the selected shared Directory. No Directory ABI or
 * implementation is assumed here; absence is an unavailable capability. */
export interface NamespaceBindingPort { currentBinding(): Promise<NamespaceBinding> }
export interface NamespaceImportPolicy { id: string; challengeTtlSeconds: number; grantTtlSeconds: number }
export interface NamespaceChallenge {
  id: Hex; selectionKey: Hex; selection: Readonly<NamespaceSelection>;
  purpose: "bind_community_namespace"; authorityId: Hex; issuedAt: number; expiresAt: number;
  grantExpiresAt: number; policyId: string; message: string;
}
/** Server-owned cryptographic/HNS verification result. A registry admin or
 * Pirate governance signature alone MUST NOT produce either external role. */
export interface NamespaceControlEvidence {
  id: Hex; challengeId: Hex; selectionKey: Hex; namespaceId: Hex;
  installationId: Hex; communityId: Hex; principalId: string; sourceSha256: string;
  externalAuthorityId: Hex; role: "hns_owner" | "hns_delegated_controller";
  provenanceDigest: Hex; observedAt: number; validUntil: number;
}
export interface NamespaceControlPort {
  /** Verify the supported genuine proof over this one-use complete challenge.
   * No inferred proof from hosting, registry admin, old factories or saved keys. */
  verify(challenge: NamespaceChallenge, proof: unknown): Promise<NamespaceControlEvidence>;
  /** Current external control, revocation and evidence freshness, not a flag. */
  revalidate(original: NamespaceControlEvidence, selection: NamespaceSelection): Promise<NamespaceControlEvidence>;
}
export interface StoredNamespaceGrant { challenge: NamespaceChallenge; evidence: NamespaceControlEvidence }
/** Durable/atomic server store. Consume before awaits; retain consumed rows,
 * revocations and grant identities across crashes, backup and restore. */
export interface NamespaceImportStore {
  createChallenge(challenge: NamespaceChallenge): Promise<boolean>;
  consumeChallenge(id: Hex, selectionKey: Hex): Promise<NamespaceChallenge | undefined>;
  createGrant(grant: StoredNamespaceGrant): Promise<boolean>;
  getGrant(id: Hex): Promise<{ grant: StoredNamespaceGrant; revoked: boolean } | undefined>;
}
export interface CurrentNamespaceGrant {
  id: Hex; selection: Readonly<NamespaceSelection>; evidence: NamespaceControlEvidence;
  observation: NamespaceObservation; expiresAt: number;
  purpose: "bind_community_namespace"; memberIssuance: "separate_authorization_required";
}
export function namespaceChallengeMessage(c: Omit<NamespaceChallenge, "message">): string {
  return "Pirate shared namespace binding v3\n" + JSON.stringify([
    c.purpose, c.id, c.selectionKey, bindingKey(c.selection), c.selection.principalId,
    c.authorityId, c.policyId, c.issuedAt, c.expiresAt, c.grantExpiresAt,
    "No member claim, Pirate governance, transaction, holder record or funding authority is granted.",
  ]);
}

export class NamespaceImportController {
  readonly policy: Readonly<NamespaceImportPolicy>;
  #adapter: NamespaceRegistryAdapter; #store: NamespaceImportStore; #control?: NamespaceControlPort;
  #selection: () => Promise<NamespaceSelection>;
  constructor(options: { adapter: NamespaceRegistryAdapter; store: NamespaceImportStore;
    control: NamespaceControlPort | undefined; selection: () => Promise<NamespaceSelection>; policy: NamespaceImportPolicy }) {
    identifier(options.policy.id);
    const { challengeTtlSeconds: c, grantTtlSeconds: g } = options.policy;
    seconds(c); seconds(g); requireNamespace(c > 0 && g >= c, "invalid_policy");
    requireNamespace(options.store && typeof options.store.consumeChallenge === "function" && typeof options.store.getGrant === "function" &&
      typeof options.store.createChallenge === "function" && typeof options.store.createGrant === "function", "durable_store_required");
    this.policy = freeze({ ...options.policy }); this.#adapter = options.adapter;
    this.#store = options.store; this.#selection = options.selection; this.#control = options.control;
  }
  async currentSelection() { return namespaceSelection(await this.#selection()); }
  async #controlCall<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { if (error instanceof NamespaceError) throw error; throw new NamespaceError("external_authority_verification_failed"); }
  }
  async #same(s: NamespaceSelection) {
    requireNamespace(selectionKey(await this.currentSelection()) === selectionKey(s), "setup_context_changed");
  }
  #challenge(c: NamespaceChallenge, selection: NamespaceSelection) {
    hash(c.id); hash(c.authorityId); namespaceSelection(c.selection);
    for (const n of [c.issuedAt, c.expiresAt, c.grantExpiresAt]) seconds(n);
    requireNamespace(c.purpose === "bind_community_namespace" && c.policyId === this.policy.id &&
      c.selectionKey === selectionKey(c.selection) && c.selectionKey === selectionKey(selection), "challenge_context_mismatch");
    requireNamespace(c.expiresAt > c.issuedAt && c.expiresAt - c.issuedAt <= this.policy.challengeTtlSeconds &&
      c.grantExpiresAt > c.issuedAt && c.grantExpiresAt - c.issuedAt <= this.policy.grantTtlSeconds &&
      c.grantExpiresAt >= c.expiresAt && namespaceChallengeMessage(c) === c.message, "challenge_changed");
  }
  #evidence(e: NamespaceControlEvidence, c: NamespaceChallenge) {
    hash(e.id); hash(e.externalAuthorityId); hash(e.provenanceDigest); seconds(e.observedAt); seconds(e.validUntil);
    const s = c.selection;
    requireNamespace(e.challengeId === c.id && e.selectionKey === c.selectionKey && e.namespaceId === s.namespaceId &&
      e.installationId === s.installationId && e.communityId === s.communityId && e.principalId === s.principalId &&
      e.sourceSha256 === s.sourceSha256 && (e.role === "hns_owner" || e.role === "hns_delegated_controller"), "external_authority_mismatch");
    const now = this.#adapter.now();
    requireNamespace(e.observedAt >= c.issuedAt && e.observedAt <= now && now < e.validUntil, "external_authority_expired");
  }
  async #observe(s: NamespaceSelection) {
    const o = await this.#adapter.observe(s.issuanceTld, s.communityId);
    requireNamespace(o.namespaceId === s.namespaceId && o.sourceSha256 === s.sourceSha256, "namespace_source_mismatch");
    await this.#same(s); return o;
  }
  async begin(): Promise<NamespaceChallenge> {
    requireNamespace(this.#control, "external_authority_verifier_unavailable");
    const s = await this.currentSelection(), o = await this.#observe(s), now = this.#adapter.now();
    const fields = { id: ("0x" + randomBytes(32).toString("hex")) as Hex, selectionKey: selectionKey(s), selection: s,
      purpose: "bind_community_namespace" as const, authorityId: o.authorityId,
      issuedAt: now, expiresAt: seconds(now + this.policy.challengeTtlSeconds),
      grantExpiresAt: seconds(now + this.policy.grantTtlSeconds), policyId: this.policy.id };
    const c = freeze({ ...fields, message: namespaceChallengeMessage(fields) });
    await this.#same(s); requireNamespace(await this.#store.createChallenge(c), "challenge_collision"); return c;
  }
  async complete(id: Hex, proof: unknown): Promise<CurrentNamespaceGrant> {
    hash(id); requireNamespace(this.#control, "external_authority_verifier_unavailable");
    const s = await this.currentSelection();
    const stored = await this.#store.consumeChallenge(id, selectionKey(s));
    requireNamespace(stored && stored.id === id, "challenge_used_or_unknown");
    const c = freeze(structuredClone(stored)); this.#challenge(c, s);
    const live = () => requireNamespace(this.#adapter.now() >= c.issuedAt && this.#adapter.now() < c.expiresAt, "challenge_expired");
    live(); const evidence = freeze(structuredClone(await this.#controlCall(() => this.#control!.verify(c, proof)))); this.#evidence(evidence, c);
    const o = await this.#observe(s); requireNamespace(o.authorityId === c.authorityId, "authority_changed"); live();
    requireNamespace(await this.#store.createGrant(freeze({ challenge: structuredClone(c), evidence })), "grant_collision");
    return this.requireCurrent(id);
  }
  async requireCurrent(id: Hex): Promise<CurrentNamespaceGrant> {
    hash(id); requireNamespace(this.#control, "external_authority_verifier_unavailable");
    const s = await this.currentSelection(), saved = await this.#store.getGrant(id);
    requireNamespace(saved && !saved.revoked && saved.grant.challenge.id === id, "grant_revoked_or_unknown");
    const original = freeze(structuredClone(saved.grant)); this.#challenge(original.challenge, s);
    this.#evidence(original.evidence, original.challenge);
    const evidence = freeze(structuredClone(await this.#controlCall(() => this.#control!.revalidate(original.evidence, s))));
    this.#evidence(evidence, original.challenge);
    requireNamespace(evidence.id === original.evidence.id && evidence.externalAuthorityId === original.evidence.externalAuthorityId && evidence.role === original.evidence.role, "external_authority_changed");
    const o = await this.#observe(s);
    requireNamespace(o.authorityId === original.challenge.authorityId, "authority_changed");
    const latest = await this.#store.getGrant(id);
    requireNamespace(latest && !latest.revoked && namespaceDigest(latest.grant) === namespaceDigest(original), "grant_revoked_or_changed");
    await this.#same(s);
    const expiresAt = Math.min(original.challenge.grantExpiresAt, original.evidence.validUntil, evidence.validUntil, o.validUntil);
    requireNamespace(this.#adapter.now() >= original.challenge.issuedAt && this.#adapter.now() < expiresAt, "grant_expired");
    return freeze({ id, selection: s, evidence, observation: o, expiresAt,
      purpose: "bind_community_namespace", memberIssuance: "separate_authorization_required" });
  }
}

export interface NamespaceGrantIndex { current(key: Hex): Promise<Hex | undefined>; remember(key: Hex, id: Hex): Promise<void> }
export interface NamespaceAuthorityProof {
  id: Hex; binding: Readonly<NamespaceBinding>; authorityKind: NamespaceControlEvidence["role"];
  externalAuthorityId: Hex; evidenceDigest: Hex; onChainAuthorityRevision: string;
  onChainPolicyRevision: string; onChainScopeRevision: string; expiresAt: number;
  purpose: "bind_community_namespace"; memberIssuance: "separate_authorization_required";
}
export interface NamespaceAuthorityPortV3 {
  readonly version: 3; begin(): Promise<NamespaceChallenge>;
  complete(input: { challengeId: Hex; proof: unknown }): Promise<NamespaceAuthorityProof>;
  inspect(input: { binding: NamespaceBinding }): Promise<NamespaceAuthorityProof>;
  revalidate(input: { proof: NamespaceAuthorityProof; binding: NamespaceBinding }): Promise<NamespaceAuthorityProof>;
}
/** New interface requires Root/W6 reconciliation. No compatibility flag or old
 * finite-label/EOA-admin decoder is silently reused as external HNS authority. */
export function createNamespaceAuthorityPort(options: { imports: NamespaceImportController; grants: NamespaceGrantIndex }): NamespaceAuthorityPortV3 {
  const { imports, grants } = options;
  requireNamespace(grants && typeof grants.current === "function" && typeof grants.remember === "function", "durable_grant_index_required");
  const projection = (g: CurrentNamespaceGrant): NamespaceAuthorityProof => freeze({ id: g.id, binding: namespaceBinding(g.selection),
    authorityKind: g.evidence.role, externalAuthorityId: g.evidence.externalAuthorityId,
    evidenceDigest: namespaceDigest([g.id, selectionKey(g.selection), g.evidence.externalAuthorityId, g.evidence.role, g.observation.authorityId]),
    onChainAuthorityRevision: g.observation.authority.revision.toString(), onChainPolicyRevision: g.observation.policy.revision.toString(),
    onChainScopeRevision: g.observation.scope.revision.toString(), expiresAt: seconds(g.expiresAt * 1000),
    purpose: "bind_community_namespace", memberIssuance: "separate_authorization_required" });
  return freeze({ version: 3,
    begin: () => imports.begin(),
    async complete(input: { challengeId: Hex; proof: unknown }) {
      const g = await imports.complete(input.challengeId, input.proof);
      await grants.remember(selectionKey(g.selection), g.id); return projection(await imports.requireCurrent(g.id));
    },
    async inspect(input: { binding: NamespaceBinding }) {
      const binding = namespaceBinding(input.binding), s = await imports.currentSelection();
      requireNamespace(bindingKey(binding) === bindingKey(s), "namespace_binding_changed");
      const id = await grants.current(selectionKey(s)); requireNamespace(id, "operator_proof_required");
      const g = await imports.requireCurrent(id);
      requireNamespace(bindingKey(g.selection) === bindingKey(binding), "namespace_binding_changed"); return projection(g);
    },
    async revalidate(input: { proof: NamespaceAuthorityProof; binding: NamespaceBinding }) {
      const p = freeze(structuredClone(input.proof)), b = namespaceBinding(input.binding);
      const g = await imports.requireCurrent(p.id), actual = projection(g);
      requireNamespace(bindingKey(b) === bindingKey(actual.binding) && bindingKey(p.binding) === bindingKey(b) &&
        p.authorityKind === actual.authorityKind && p.externalAuthorityId === actual.externalAuthorityId && p.evidenceDigest === actual.evidenceDigest &&
        p.onChainAuthorityRevision === actual.onChainAuthorityRevision && p.onChainPolicyRevision === actual.onChainPolicyRevision &&
        p.onChainScopeRevision === actual.onChainScopeRevision && p.purpose === actual.purpose && p.memberIssuance === actual.memberIssuance, "namespace_proof_changed");
      return actual;
    },
  });
}
