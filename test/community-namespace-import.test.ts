// SOURCE ONLY, UNRUN. Real adapter/controller/planner and viem identity/digest
// calculations. Resolver/HNS, cryptographic authority verification, SDK I/O,
// membership and durable transactional stores are explicitly simulated ports.
// These cases are not real HNS, service, contract, storage or browser acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashTypedData, keccak256, type Abi, type Address, type Hex } from "viem";
import { NamespaceError, NamespaceRegistryAdapter, namespaceDigest, sharedNameKeyFor, sharedNamespaceIdFor,
  sharedTokenIdFor, type NamespaceObserverProfile, type NamespaceRegistrySource, type SharedRegistrySource,
  type SharedAuthority, type SharedPolicy, type SharedScope, type SharedQuote } from "../packages/community-names/namespace-registry-adapter.ts";
import { NamespaceImportController, bindingKey, createNamespaceAuthorityPort, namespaceBinding,
  type NamespaceBinding, type NamespaceSelection, type NamespaceChallenge, type StoredNamespaceGrant,
  type NamespaceControlPort, type NamespaceImportStore } from "../packages/community-names/namespace-import.ts";
import { NamespaceRegistrationPlanner, namespaceClaimTypedData, type NamespaceRegistrationJournal,
  type NamespaceRegistrationRecord, type NamespaceRegistrationRequest, type NamespaceSdkPort,
  type NamespacePreparedClaim, type NamespaceMemberAuthorizationPort,
  type NamespaceRecovery } from "../packages/community-names/namespace-registration-plan.ts";

const zero = "0x0000000000000000000000000000000000000000" as Address;
const registry = ("0x" + "3".repeat(40)) as Address, issuer = ("0x" + "4".repeat(40)) as Address;
const submitter = ("0x" + "5".repeat(40)) as Address, recipient = ("0x" + "6".repeat(40)) as Address;
const other = ("0x" + "7".repeat(40)) as Address, token = ("0x" + "8".repeat(40)) as Address;
const code = "0x6001" as Hex;
const abiSha = "e580c03988a02a6ecd1d414c7a3e0ac0e306c823e07b0f9a9078b30a06c3a802";
const timing = { collectionMarginSeconds: 20, signingMarginSeconds: 20, inclusionMarginSeconds: 20 };
const cp = <T>(value: T): T => structuredClone(value);
async function refused(action: Promise<unknown>, reason: string) {
  await assert.rejects(action, (e: unknown) => e instanceof NamespaceError && e.code === reason);
}
function fixture(tld = "testtld") {
  let now = 1700000000;
  const source: SharedRegistrySource = { schema: "pirate.shared-registry-source/1", protocolVersion: 3,
    sourceCommit: "56d63ad2738e0e6816b6157dba7174198700f2fa", abiSha256: abiSha, chainId: 31337,
    registry, runtimeCodeHash: keccak256(code), deployment: { blockNumber: "1", blockHash: namespaceDigest(["deployment"]), transactionHash: namespaceDigest(["deployment-tx"]) },
    constructor: { admin: other, paymentToken: token, treasury: other },
    compiler: { version: "0.8.30", evmVersion: "cancun", optimizer: true, optimizerRuns: 200, bytecodeHash: "none", cborMetadata: false } };
  const sourceSha256 = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  const binding: NamespaceBinding = { installationId: namespaceDigest(["fixture-installation"]), revision: 1, communityId: namespaceDigest(["opaque-community"]),
    hostingOrigin: "https://unrelated.host.example", issuanceTld: tld, namespaceId: sharedNamespaceIdFor(tld),
    sourceSha256, deploymentIdentityDigest: namespaceDigest(["original-resources"]) };
  const selection: NamespaceSelection = { ...binding, principalId: "operator_1" };
  const authority: SharedAuthority = { tld, evidenceHash: namespaceDigest(["authority"]), observedAt: BigInt(now - 20),
    validUntil: BigInt(now + 1200), revision: 1n, migrationRequired: false, issuanceEnabled: true };
  const policy: SharedPolicy = { grantSigner: issuer, annualRenewalPrice: 9n, totalClaimLimit: 100n, totalClaims: 0n, revision: 1n, configured: true };
  const scope: SharedScope = { submitter, totalClaimLimit: 5n, totalClaims: 0n, revision: 1n, enabled: true };
  const state = { authority: cp(authority), policy: cp(policy), scope: cp(scope), canonical: true, code,
    trust: "local-full-node" as "local-full-node" | "remote-trusted", sourceOverride: undefined as SharedRegistrySource | undefined,
    available: true, generation: 1n, reservedFor: zero, price: 0n, memberRevoked: false, recoveryAllowed: true,
    beforeVerify: undefined as (() => void) | undefined, beforeFinish: undefined as (() => void) | undefined,
    onAuthorize: undefined as (() => void) | undefined, onRevalidate: undefined as (() => void) | undefined,
    onPrepare: undefined as ((prepared: NamespacePreparedClaim) => void) | undefined,
    recoveryMode: "pending" as "pending" | "consumed" | "expired-unconsumed" | "throw",
    changeReceipt: undefined as ((result: NamespaceRecovery) => void) | undefined,
    externalId: namespaceDigest(["hns-control"]), role: "hns_owner" as "hns_owner" | "hns_delegated_controller" };
  const reads: Array<{ name: string; blockHash: Hex; target: Address }> = [];
  const quote = (): SharedQuote => ({ authorityRevision: state.authority.revision, policyRevision: state.policy.revision,
    scopeRevision: state.scope.revision, generation: state.generation, status: state.available ? 0 : 1,
    reservedFor: state.reservedFor, initialPrice: state.price, renewalToken: token, annualRenewalPrice: state.policy.annualRenewalPrice,
    namespaceClaimsRemaining: state.policy.totalClaimLimit - state.policy.totalClaims,
    scopeClaimsRemaining: state.scope.totalClaimLimit - state.scope.totalClaims, issuanceEnabled: state.available && state.price === 0n });
  const observer: NamespaceRegistrySource = { async verifyRegistry(requested) {
    state.beforeVerify?.(); assert.equal(requested, selection.issuanceTld);
    const snapshot = { authority: cp(state.authority), policy: cp(state.policy), scope: cp(state.scope), quote: quote() };
    const block = { tag: "safe" as const, number: BigInt(now), hash: namespaceDigest(["block", now]), timestamp: BigInt(now - 5) };
    return { source: state.sourceOverride ?? cp(source), sourceSha256,
      delegation: { namespaceId: sharedNamespaceIdFor(requested), registry, record: `${registry}.31337._evm.`,
        observation: { source: "explicit-simulated-hns", trust: state.trust } },
      reader: { block,
        async getCode(target) { reads.push({ name: "getCode", blockHash: block.hash, target }); return state.code; },
        async read(target: Address, _abi: Abi, name: string) {
          reads.push({ name, blockHash: block.hash, target });
          switch (name) {
            case "PROTOCOL_VERSION": return 3;
            case "paymentToken": return token;
            case "authority": return cp(snapshot.authority);
            case "policy": return cp(snapshot.policy);
            case "scope": return cp(snapshot.scope);
            case "quote": return cp(snapshot.quote);
            default: throw new Error("unexpected fixture method");
          }
        } },
      async finish() { state.beforeFinish?.(); if (!state.canonical) throw new Error("private-rpc.example/credential"); } };
  } };
  const profile: NamespaceObserverProfile = { id: "simulated-source-profile", source, sourceSha256, blockTag: "safe",
    maxBlockAgeSeconds: 120, maxObservationAgeSeconds: 30, maxClockAheadSeconds: 5, acceptedHandshakeTrust: ["local-full-node"] };
  const adapter = new NamespaceRegistryAdapter(profile, observer, () => now);
  const challenges = new Map<Hex, NamespaceChallenge>(), consumed = new Set<Hex>();
  const grants = new Map<Hex, { grant: StoredNamespaceGrant; revoked: boolean }>();
  const store: NamespaceImportStore = {
    async createChallenge(c) { if (challenges.has(c.id) || consumed.has(c.id)) return false; challenges.set(c.id, cp(c)); return true; },
    async consumeChallenge(id, key) { const c = challenges.get(id); if (!c || c.selectionKey !== key || consumed.has(id)) return undefined;
      consumed.add(id); challenges.delete(id); return cp(c); },
    async createGrant(g) { if (grants.has(g.challenge.id)) return false; grants.set(g.challenge.id, { grant: cp(g), revoked: false }); return true; },
    async getGrant(id) { const g = grants.get(id); return g && cp(g); },
  };
  const control: NamespaceControlPort = {
    async verify(c, proof) {
      assert.equal(proof, "explicit-simulated-proof");
      return { id: namespaceDigest(["control", c.id]), challengeId: c.id, selectionKey: c.selectionKey,
        namespaceId: c.selection.namespaceId, communityId: c.selection.communityId, installationId: c.selection.installationId,
        principalId: c.selection.principalId, sourceSha256: c.selection.sourceSha256, externalAuthorityId: state.externalId,
        role: state.role, provenanceDigest: namespaceDigest(["control-observation"]), observedAt: now, validUntil: now + 300 };
    },
    async revalidate(e) { return { ...cp(e), externalAuthorityId: state.externalId, role: state.role }; },
  };
  const makeImports = (port: NamespaceControlPort | null = control) => new NamespaceImportController({ adapter, store,
    control: port ?? undefined, selection: async () => cp(selection), policy: { id: "binding-policy", challengeTtlSeconds: 60, grantTtlSeconds: 120 } });
  const imports = makeImports();
  const membership: NamespaceMemberAuthorizationPort = {
    async authorize(b, r) {
      state.onAuthorize?.(); if (state.memberRevoked) throw new NamespaceError("membership_revoked");
      return { authorizationRef: r.authorizationRef, requestId: r.requestId, label: r.label, bindingKey: bindingKey(b), memberId: "member_1",
        eligibilitySubject: namespaceDigest(["stable-eligibility"]), membershipRevision: "membership_1", recipient,
        evidenceDigest: namespaceDigest(["membership", r.requestId]), validUntil: now + 200,
        gas: { policyId: "gas_policy", periodId: "period_1", payer: submitter, submitter, gasLimit: 21000n,
          maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, maxTotalWei: 42000n } };
    },
    async revalidate() { state.onRevalidate?.(); if (state.memberRevoked) throw new NamespaceError("membership_revoked"); },
    async authorizeRecovery() { if (!state.recoveryAllowed) throw new NamespaceError("recovery_forbidden"); },
  };
  const sdk: NamespaceSdkPort = {
    async prepare(input) {
      const o = await adapter.observe(input.binding.issuanceTld, input.binding.communityId), q = await adapter.quote(o, input.label);
      const issuedAt = BigInt(o.blockTimestamp), deadline = issuedAt + 900n < o.authority.validUntil ? issuedAt + 900n : o.authority.validUntil - 1n;
      const claim = { requestId: input.requestId, communityId: input.binding.communityId, namespaceId: input.binding.namespaceId,
        label: input.label, recipient: input.recipient, generation: q.generation, authorityRevision: q.authorityRevision,
        policyRevision: q.policyRevision, scopeRevision: q.scopeRevision, issuedAt, deadline, years_: 1, maxCost: 0n };
      const p: NamespacePreparedClaim = { schema: "pirate.member-name-claim/3", sourceSha256, chainId: 31337, registry, claim,
        requestHash: hashTypedData(namespaceClaimTypedData(31337, registry, claim)),
        expectedTokenId: sharedTokenIdFor(sharedNameKeyFor(claim.namespaceId, claim.label), claim.generation), renewalToken: token,
        annualRenewalPrice: q.annualRenewalPrice, quoteBlock: { number: BigInt(o.blockNumber), hash: o.blockHash, timestamp: issuedAt },
        timing: cp(input.timing), submitBy: deadline - BigInt(input.timing.signingMarginSeconds + input.timing.inclusionMarginSeconds) };
      state.onPrepare?.(p); return p;
    },
    async reconcile(input) {
      await input.authorizeRecovery(); if (state.recoveryMode === "throw") throw new Error("credential/private-rpc");
      const p = input.operation;
      const result: NamespaceRecovery = { sourceSha256: p.sourceSha256, chainId: p.chainId, registry: p.registry,
        requestHash: p.requestHash, state: state.recoveryMode, automaticReissueAllowed: false };
      if (result.state === "consumed") {
        result.original = { tokenId: p.expectedTokenId, generation: p.claim.generation, recipient: p.claim.recipient,
          expiry: p.claim.issuedAt + 31536000n, annualRenewalPrice: p.annualRenewalPrice, renewalToken: p.renewalToken };
        result.transactionHash = namespaceDigest(["original-transaction"]); result.current = { state: "unavailable", detail: "private-rpc" };
        result.resolutionEligibility = "not-checked";
      }
      state.changeReceipt?.(result); return result;
    },
  };
  const records = new Map<Hex, NamespaceRegistrationRecord>(), slots = new Set<Hex>();
  const journal: NamespaceRegistrationJournal = {
    async find(key) { const record = records.get(key); return record && cp(record); },
    async claim(plan) {
      const old = records.get(plan.operationKey);
      if (old) return old.plan.requestDigest === plan.requestDigest ? { kind: "existing" as const, record: cp(old) } : { kind: "conflict" as const };
      if (slots.has(plan.slot)) return { kind: "conflict" as const };
      const record: NamespaceRegistrationRecord = { plan: cp(plan), outcome: "prepared" };
      records.set(plan.operationKey, record); slots.add(plan.slot); return { kind: "created" as const, record: cp(record) };
    },
    async recordRecovery(key, digest, recovery) {
      const old = records.get(key)!; assert.equal(old.plan.planDigest, digest);
      if (old.outcome !== "consumed") { old.recovery = cp(recovery); old.outcome = recovery?.state ?? "unknown"; }
      return cp(old);
    },
  };
  const makePlanner = (changes: Partial<ConstructorParameters<typeof NamespaceRegistrationPlanner>[0]> = {}) => new NamespaceRegistrationPlanner({
    adapter, binding: { currentBinding: async () => cp(binding) }, membership, sdk, journal, timing, ...changes });
  const planner = makePlanner();
  const request = (changes: Partial<NamespaceRegistrationRequest> = {}): NamespaceRegistrationRequest => ({ requestId: namespaceDigest(["request_1"]), label: "member001", authorizationRef: "authorization_1", ...changes });
  return { adapter, profile, observer, source, sourceSha256, binding, selection, state, reads, store, control, imports,
    grants, challenges, consumed, makeImports, membership, sdk, journal, records, slots, planner, makePlanner, request,
    now: () => now, advance: (delta: number) => { now += delta; } };
}

test("opaque community and installation binding is independent of registry address and hosting root", async () => {
  const f = fixture(); const record = await f.planner.prepare(f.request());
  assert.equal(record.plan.binding.communityId, f.binding.communityId);
  assert.equal(record.plan.binding.hostingOrigin, "https://unrelated.host.example");
  assert.notEqual(record.plan.binding.communityId, namespaceDigest([registry]));
  assert.equal(record.plan.name, "member001.testtld");
  assert.equal(record.plan.initialPrice, "0"); assert.equal(record.plan.maxCost, "0");
  assert.equal(record.plan.initialTermSeconds, 31536000); assert.equal(record.plan.prepared.annualRenewalPrice, 9n);
  assert.equal(record.plan.transactionReady, false); assert.equal(record.plan.approvalPrepared, false);
  assert.notEqual(record.plan.grantSigner, record.plan.submitter);
});
test("legacy string installation IDs require explicit migration rather than reinterpretation", () => {
  const f = fixture(); assert.throws(() => namespaceBinding({ ...f.binding, installationId: "legacy_installation_1" as never }), NamespaceError);
});
test("same label has distinct namespace/name/token identities; all three allocated vectors match", () => {
  const vectors = [
    ["testtld", "0x171a7715833c41caa33d3304096ea3f330e94e2b58eac1b29fc2fee99dd14f3d", "0x6d73822225a283039c5509f97306783e3479a0e37a5044f5cb52038f8b160856", 1n, 95165702007452585980891729623512171902651103434603173062025220274514321273488n],
    ["othertld", "0xad1ddae470c5a78c4606195fc22c2052fc09d7e2961c8be5d63c353df8bfad9f", "0x17c1a7656712aeca2b7313821b02344431c180a32094aeb82e5984413fda1bb3", 1n, 106965765079036890316365061902104356189341292721360854213475389451124177547303n],
    ["testtld", "0x171a7715833c41caa33d3304096ea3f330e94e2b58eac1b29fc2fee99dd14f3d", "0x6d73822225a283039c5509f97306783e3479a0e37a5044f5cb52038f8b160856", 2n, 108434146224625834091005199361104751209326105825392306275063521700134099266268n],
  ] as const;
  for (const [tld, ns, key, generation, tokenId] of vectors) {
    assert.equal(sharedNamespaceIdFor(tld), ns); assert.equal(sharedNameKeyFor(ns, "member001"), key); assert.equal(sharedTokenIdFor(key, generation), tokenId);
  }
});
for (const name of ["a".repeat(7), "Uppercase", " member001", "member001 ", "member001.testtld", "xn--member", "-member001", "member001-", "mémber001", "a".repeat(64)]) {
  test(`invalid canonical member label ${JSON.stringify(name)} is refused before an operation`, async () => {
    const f = fixture(); await refused(f.planner.prepare(f.request({ label: name })), "invalid_label"); assert.equal(f.records.size, 0);
  });
}
for (const length of [8, 9, 63]) test(`ordinary ${length}-byte names use the free path`, async () => {
  const f = fixture(); const r = await f.planner.prepare(f.request({ label: "a".repeat(length) })); assert.equal(r.plan.maxCost, "0");
});
test("missing Root ports report unavailability instead of a verified capability", async () => {
  const f = fixture(); await refused(f.makePlanner({ binding: undefined }).prepare(f.request()), "namespace_binding_unavailable");
  await refused(f.makePlanner({ sdk: undefined }).prepare(f.request()), "shared_sdk_unavailable");
  await refused(f.makePlanner({ membership: undefined }).prepare(f.request()), "member_authorization_unavailable");
  await refused(f.makeImports(null).begin(), "external_authority_verifier_unavailable");
  await refused(new NamespaceRegistryAdapter(f.profile, undefined, f.now).observe("testtld", f.binding.communityId), "observer_unavailable");
});
const observerCases: Array<[string, (f: ReturnType<typeof fixture>) => void, string]> = [
  ["wrong source", f => { f.state.sourceOverride = { ...f.source, registry: other }; }, "source_pin_mismatch"],
  ["v2 protocol", f => { f.state.sourceOverride = { ...f.source, protocolVersion: 2 as never }; }, "unsupported_source"],
  ["mainnet", f => { f.state.sourceOverride = { ...f.source, chainId: 1 as never }; }, "unsupported_source"],
  ["unselected ABI", f => { f.state.sourceOverride = { ...f.source, abiSha256: "1".repeat(64) }; }, "source_pin_mismatch"],
  ["runtime code", f => { f.state.code = "0x6002"; }, "registry_configuration_mismatch"],
  ["migration required", f => { f.state.authority.migrationRequired = true; }, "authority_unavailable"],
  ["expired authority", f => { f.state.authority.validUntil = BigInt(f.now()); }, "stale_observation"],
  ["issuance disabled", f => { f.state.authority.issuanceEnabled = false; }, "authority_unavailable"],
  ["scope disabled", f => { f.state.scope.enabled = false; }, "issuance_unavailable"],
  ["same issuer/submitter", f => { f.state.scope.submitter = issuer; }, "issuance_unavailable"],
  ["namespace cap", f => { f.state.policy.totalClaims = f.state.policy.totalClaimLimit; }, "issuance_unavailable"],
  ["scope cap", f => { f.state.scope.totalClaims = f.state.scope.totalClaimLimit; }, "issuance_unavailable"],
  ["unaccepted HNS trust", f => { f.state.trust = "remote-trusted"; }, "unaccepted_handshake_source"],
];
for (const [name, change, reason] of observerCases) test(`${name} refuses a new plan`, async () => {
  const f = fixture(); change(f); await refused(f.planner.prepare(f.request()), reason); assert.equal(f.records.size, 0);
});
test("effective positive premium and taken labels never fall back to paid checkout", async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.state.price = 1n; }, (f: ReturnType<typeof fixture>) => { f.state.available = false; }]) {
    const f = fixture(); mutate(f); await refused(f.planner.prepare(f.request()), "free_quote_unavailable"); assert.equal(f.records.size, 0);
  }
});
test("a price race after SDK preparation refuses the plan while retaining maxCost zero", async () => {
  const f = fixture(); f.state.onPrepare = p => { assert.equal(p.claim.maxCost, 0n); f.state.price = 1n; };
  await refused(f.planner.prepare(f.request()), "free_quote_unavailable"); assert.equal(f.records.size, 0);
});
test("on-chain reservation for another recipient is refused", async () => {
  const f = fixture(); f.state.reservedFor = other;
  await refused(f.planner.prepare(f.request()), "quote_changed"); assert.equal(f.records.size, 0);
});
test("slow verification spends freshness and private RPC diagnostics stay private", async () => {
  const f = fixture(); f.state.beforeVerify = () => f.advance(30);
  await refused(f.adapter.observe("testtld", f.binding.communityId), "stale_observation");
  f.state.beforeVerify = undefined; f.state.canonical = false;
  await refused(f.adapter.observe("testtld", f.binding.communityId), "authority_read_failed");
});
test("copied observations cannot supply a canonical quote reader", async () => {
  const f = fixture(), o = await f.adapter.observe("testtld", f.binding.communityId);
  await refused(f.adapter.quote(cp(o), "member001"), "foreign_observation");
});
test("import is one-use and binds actual external role independently of on-chain governance", async () => {
  const f = fixture(); const c = await f.imports.begin();
  const outcomes = await Promise.allSettled([f.imports.complete(c.id, "explicit-simulated-proof"), f.imports.complete(c.id, "explicit-simulated-proof")]);
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1); assert.equal(f.grants.size, 1);
  const grant = await f.imports.requireCurrent(c.id);
  assert.equal(grant.purpose, "bind_community_namespace"); assert.equal(grant.memberIssuance, "separate_authorization_required");
  assert.equal(grant.evidence.role, "hns_owner"); assert.equal(f.consumed.size, 1);
  await refused(f.imports.complete(c.id, "explicit-simulated-proof"), "challenge_used_or_unknown");
});
for (const field of ["installationId", "principalId", "communityId", "namespaceId", "sourceSha256", "deploymentIdentityDigest", "hostingOrigin", "revision"] as const) {
  test(`import rejects a changed ${field}`, async () => {
    const f = fixture(); const c = await f.imports.begin();
    if (field === "revision") f.selection.revision++;
    else if (field === "hostingOrigin") f.selection.hostingOrigin = "https://replacement.example";
    else if (field === "sourceSha256") f.selection.sourceSha256 = "1".repeat(64);
    else if (field === "namespaceId") { f.selection.namespaceId = sharedNamespaceIdFor("othertld"); f.selection.issuanceTld = "othertld"; }
    else if (field === "principalId") f.selection.principalId = "replacement_1";
    else f.selection[field] = namespaceDigest(["replacement"]);
    await refused(f.imports.complete(c.id, "explicit-simulated-proof"), "challenge_used_or_unknown"); assert.equal(f.grants.size, 0);
  });
}
test("proof replay, expiry and restored revocation do not establish a fresh capability", async () => {
  const f = fixture(); const c = await f.imports.begin(); f.advance(60);
  await refused(f.imports.complete(c.id, "explicit-simulated-proof"), "challenge_expired"); assert.equal(f.consumed.has(c.id), true);
  const c2 = await f.imports.begin(); await f.imports.complete(c2.id, "explicit-simulated-proof");
  f.grants.get(c2.id)!.revoked = true; await refused(f.makeImports().requireCurrent(c2.id), "grant_revoked_or_unknown");
});
test("saved authority change and governance-as-HNS role forgery are refused", async () => {
  const f = fixture(); const c = await f.imports.begin(); await f.imports.complete(c.id, "explicit-simulated-proof");
  f.state.externalId = namespaceDigest(["new-owner"]); await refused(f.imports.requireCurrent(c.id), "external_authority_changed");
  const g = fixture(); const forged: NamespaceControlPort = { ...g.control, async verify(challenge, proof) {
    return { ...await g.control.verify(challenge, proof), role: "registry_admin" as never };
  } };
  const imports = g.makeImports(forged), challenge = await imports.begin();
  await refused(imports.complete(challenge.id, "explicit-simulated-proof"), "external_authority_mismatch");
});
test("facade retains namespace/source/community/resource binding and checked milliseconds", async () => {
  const f = fixture(), index = new Map<Hex, Hex>();
  const port = createNamespaceAuthorityPort({ imports: f.imports, grants: {
    async current(key) { return index.get(key); }, async remember(key, id) { index.set(key, id); } } });
  await refused(port.inspect({ binding: f.binding }), "operator_proof_required");
  const c = await port.begin(), proof = await port.complete({ challengeId: c.id, proof: "explicit-simulated-proof" });
  assert.equal(proof.expiresAt, (f.now() + 30) * 1000); assert.equal(proof.authorityKind, "hns_owner");
  assert.equal(proof.binding.communityId, f.binding.communityId); assert.equal(proof.memberIssuance, "separate_authorization_required");
  await refused(port.revalidate({ proof, binding: { ...f.binding, deploymentIdentityDigest: namespaceDigest(["swapped"]) } }), "namespace_proof_changed");
});
test("membership revocation and changed recipient/epochs/caps never reserve a plan", async () => {
  const f = fixture(); f.state.onRevalidate = () => { f.state.memberRevoked = true; };
  await refused(f.planner.prepare(f.request()), "membership_revoked"); assert.equal(f.records.size, 0);
  for (const mutate of [
    (p: NamespacePreparedClaim) => { p.claim.recipient = other; },
    (p: NamespacePreparedClaim) => { p.claim.communityId = namespaceDigest(["wrong-community"]); },
    (p: NamespacePreparedClaim) => { p.claim.namespaceId = sharedNamespaceIdFor("othertld"); },
    (p: NamespacePreparedClaim) => { p.claim.maxCost = 1n; },
  ]) { const g = fixture(); g.state.onPrepare = mutate;
    await refused(g.planner.prepare(g.request()), "prepared_claim_mismatch"); assert.equal(g.records.size, 0); }
  const g = fixture(); g.state.onPrepare = () => { g.state.scope.revision++; };
  await refused(g.planner.prepare(g.request()), "authority_changed"); assert.equal(g.records.size, 0);
});
test("insufficient lifetime and explicit sponsor ceilings refuse", async () => {
  const f = fixture(); f.state.authority.validUntil = BigInt(f.now() + 50);
  await refused(f.planner.prepare(f.request()), "claim_window_insufficient");
  const g = fixture(); const membership: NamespaceMemberAuthorizationPort = { ...g.membership,
    async authorize(b, r) { const a = await g.membership.authorize(b, r); return { ...a, gas: { ...a.gas, maxTotalWei: 1n } }; } };
  await refused(g.makePlanner({ membership }).prepare(g.request()), "gas_budget_exceeded"); assert.equal(g.records.size, 0);
});
test("caller mutation during I/O cannot alter the reserved original request", async () => {
  const f = fixture(); const r = f.request(), expected = cp(r);
  f.state.onAuthorize = () => { r.label = "different001"; r.requestId = namespaceDigest(["different"]); };
  const saved = await f.planner.prepare(r); assert.deepEqual(saved.plan.request, expected); assert.equal(f.records.size, 1);
});
test("concurrent claims converge; aliases cannot escape an uncertain name slot", async () => {
  const f = fixture(), input = f.request(); const results = await Promise.all([f.planner.prepare(input), f.planner.prepare(input)]);
  assert.deepEqual(results[0], results[1]); assert.equal(f.records.size, 1); assert.equal(f.slots.size, 1);
  await refused(f.planner.prepare(f.request({ requestId: namespaceDigest(["alias"]) })), "registration_reconciliation_required");
  await refused(f.planner.prepare(f.request({ label: "different001" })), "operation_identity_conflict");
});
test("concurrent same-request preparations at different quote blocks retain the first exact plan", async () => {
  const f = fixture(), input = f.request(); f.state.beforeVerify = () => f.advance(1);
  const results = await Promise.all([f.planner.prepare(input), f.planner.prepare(input)]);
  assert.deepEqual(results[0], results[1]); assert.equal(f.records.size, 1); assert.equal(f.slots.size, 1);
});
test("retry after deadline or membership revocation returns the original without a replacement claim", async () => {
  const f = fixture(), input = f.request(); const original = await f.planner.prepare(input);
  f.advance(1000); f.state.memberRevoked = true; f.state.canonical = false;
  assert.deepEqual(await f.makePlanner().prepare(input), original); assert.equal(f.records.size, 1);
  const record = f.records.get(original.plan.operationKey)!;
  record.plan = { ...record.plan, name: "corrupt.testtld" };
  await refused(f.planner.prepare(input), "corrupt_original_plan");
});
test("unknown outcome/restart retains original request, budget and identity without leaking diagnostics", async () => {
  const f = fixture(), input = f.request(); const original = await f.planner.prepare(input); f.state.recoveryMode = "throw";
  const restored = f.makePlanner(), result = await restored.reconcile(input.requestId);
  assert.equal(result.outcome, "unknown"); assert.equal(result.plan.planDigest, original.plan.planDigest);
  assert.deepEqual(result.recovery, { state: "unknown", reason: "recovery_unavailable", automaticReissueAllowed: false });
  assert.equal(f.slots.size, 1); assert.equal(f.records.size, 1);
});
test("original receipt survives expiry and revoked membership without claiming live name usability", async () => {
  const f = fixture(), input = f.request(); const original = await f.planner.prepare(input);
  f.advance(2000); f.state.memberRevoked = true; f.state.authority.issuanceEnabled = false; f.state.canonical = false;
  f.state.recoveryMode = "consumed";
  const result = await f.makePlanner().reconcile(input.requestId);
  assert.equal(result.outcome, "consumed"); assert.equal(result.recovery?.state, "consumed");
  assert.equal(result.plan.planDigest, original.plan.planDigest);
  if (result.recovery?.state === "consumed") { assert.deepEqual(result.recovery.current, { state: "unavailable" });
    assert.equal(result.recovery.original?.annualRenewalPrice, 9n); }
  assert.equal(f.records.size, 1);
});
test("wrong original receipt identity becomes unknown; pending/expired absence never releases a slot", async () => {
  for (const mode of ["pending", "expired-unconsumed", "consumed"] as const) {
    const f = fixture(), input = f.request(); await f.planner.prepare(input); f.state.recoveryMode = mode;
    if (mode === "consumed") f.state.changeReceipt = result => { result.original!.recipient = other; };
    const result = await f.planner.reconcile(input.requestId);
    assert.equal(result.outcome, mode === "consumed" ? "unknown" : mode);
    assert.equal(result.recovery?.automaticReissueAllowed, false); assert.equal(f.slots.size, 1);
  }
});
test("unauthorized recovery cannot read or rewrite another member's original operation", async () => {
  const f = fixture(), input = f.request(); const original = await f.planner.prepare(input); f.state.recoveryAllowed = false;
  await refused(f.planner.reconcile(input.requestId), "recovery_forbidden"); assert.deepEqual(f.records.get(original.plan.operationKey), original);
});
test("receipt recovery uses the original namespace/source after a changed Directory selection", async () => {
  const f = fixture(), input = f.request(); const original = await f.planner.prepare(input);
  f.binding.issuanceTld = "othertld"; f.binding.namespaceId = sharedNamespaceIdFor("othertld");
  f.binding.sourceSha256 = "1".repeat(64); f.binding.revision++;
  f.state.recoveryMode = "consumed";
  const recovered = await f.planner.reconcile(input.requestId);
  assert.equal(recovered.outcome, "consumed");
  assert.equal(recovered.plan.binding.namespaceId, original.plan.binding.namespaceId);
  assert.equal(recovered.plan.binding.sourceSha256, original.plan.binding.sourceSha256);
  assert.equal(f.records.size, 1); assert.equal(f.slots.size, 1);
});
test("resource binding change during preparation refuses before durable insertion", async () => {
  const f = fixture(); f.state.onAuthorize = () => { f.binding.deploymentIdentityDigest = namespaceDigest(["replacement"]); };
  await refused(f.planner.prepare(f.request()), "namespace_binding_changed"); assert.equal(f.records.size, 0);
});
test("revocation during awaited observation cannot return an import capability", async () => {
  const f = fixture(), c = await f.imports.begin(); await f.imports.complete(c.id, "explicit-simulated-proof");
  f.state.beforeFinish = () => { f.grants.get(c.id)!.revoked = true; };
  await refused(f.imports.requireCurrent(c.id), "grant_revoked_or_changed");
});
test("external proof binds the actual installation rather than a generic wallet signature", async () => {
  const f = fixture(); const forged: NamespaceControlPort = { ...f.control, async verify(c, proof) {
    return { ...await f.control.verify(c, proof), installationId: namespaceDigest(["another-installation"]) };
  } };
  const imports = f.makeImports(forged), c = await imports.begin();
  await refused(imports.complete(c.id, "explicit-simulated-proof"), "external_authority_mismatch");
  assert.equal(f.consumed.has(c.id), true); assert.equal(f.grants.size, 0);
});
test("a stored consumed flag without original receipt evidence cannot become success", async () => {
  const f = fixture(), input = f.request(); const original = await f.planner.prepare(input);
  f.records.get(original.plan.operationKey)!.outcome = "consumed";
  await refused(f.planner.prepare(input), "receipt_missing");
});
test("a permitted reservation stays attached to the verified intended recipient", async () => {
  const f = fixture(); f.state.reservedFor = recipient;
  const record = await f.planner.prepare(f.request()); assert.equal(record.plan.prepared.claim.recipient, recipient);
});
test("gas payer and on-chain submitter remain separately authorized identities", async () => {
  const f = fixture(); const membership: NamespaceMemberAuthorizationPort = { ...f.membership,
    async authorize(b, r) { const a = await f.membership.authorize(b, r); return { ...a, gas: { ...a.gas, payer: other } }; } };
  const record = await f.makePlanner({ membership }).prepare(f.request());
  assert.equal(record.plan.authorization.gas.payer, other); assert.equal(record.plan.submitter, submitter);
});
test("a failed proof and a proof expiring during completion both retain one-use consumption", async () => {
  const f = fixture(), c = await f.imports.begin();
  await refused(f.imports.complete(c.id, "wrong-proof"), "external_authority_verification_failed"); assert.equal(f.consumed.has(c.id), true);
  const g = fixture(); const delayed: NamespaceControlPort = { ...g.control, async verify(challenge, proof) {
    const evidence = await g.control.verify(challenge, proof); g.advance(60); return evidence;
  } };
  const imports = g.makeImports(delayed), challenge = await imports.begin();
  await refused(imports.complete(challenge.id, "explicit-simulated-proof"), "challenge_expired"); assert.equal(g.grants.size, 0);
});
