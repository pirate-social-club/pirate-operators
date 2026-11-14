import { createHash } from "node:crypto";
import { encodeAbiParameters, getAddress, keccak256, stringToHex, type Abi, type Address, type Hex, type ContractFunctionArgs, type ContractFunctionReturnType } from "viem";

// Exact compiler-generated fragments: pirate-registry source 56d63ad2738e0e6816b6157dba7174198700f2fa.
// Full 119-entry ABI SHA-256 is over JSON.stringify(bundle.abi), not the bundle file.
export const sharedRegistryAbiSha256 = "e580c03988a02a6ecd1d414c7a3e0ac0e306c823e07b0f9a9078b30a06c3a802";
export const namespaceRegistryAbi = [
  {"type":"function","name":"PROTOCOL_VERSION","inputs":[],"outputs":[{"name":"","type":"uint16","internalType":"uint16"}],"stateMutability":"view"},
  {"type":"function","name":"authority","inputs":[{"name":"namespaceId","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"","type":"tuple","internalType":"struct ISharedNameRegistryV3.Authority","components":[{"name":"tld","type":"string","internalType":"string"},{"name":"evidenceHash","type":"bytes32","internalType":"bytes32"},{"name":"observedAt","type":"uint64","internalType":"uint64"},{"name":"validUntil","type":"uint64","internalType":"uint64"},{"name":"revision","type":"uint64","internalType":"uint64"},{"name":"migrationRequired","type":"bool","internalType":"bool"},{"name":"issuanceEnabled","type":"bool","internalType":"bool"}]}],"stateMutability":"view"},
  {"type":"function","name":"claimFreeName","inputs":[{"name":"c","type":"tuple","internalType":"struct ISharedNameRegistryV3.FreeClaim","components":[{"name":"requestId","type":"bytes32","internalType":"bytes32"},{"name":"communityId","type":"bytes32","internalType":"bytes32"},{"name":"namespaceId","type":"bytes32","internalType":"bytes32"},{"name":"label","type":"string","internalType":"string"},{"name":"recipient","type":"address","internalType":"address"},{"name":"generation","type":"uint64","internalType":"uint64"},{"name":"authorityRevision","type":"uint64","internalType":"uint64"},{"name":"policyRevision","type":"uint64","internalType":"uint64"},{"name":"scopeRevision","type":"uint64","internalType":"uint64"},{"name":"issuedAt","type":"uint64","internalType":"uint64"},{"name":"deadline","type":"uint64","internalType":"uint64"},{"name":"years_","type":"uint8","internalType":"uint8"},{"name":"maxCost","type":"uint256","internalType":"uint256"}]},{"name":"grantSignature","type":"bytes","internalType":"bytes"},{"name":"recipientSignature","type":"bytes","internalType":"bytes"}],"outputs":[{"name":"tokenId","type":"uint256","internalType":"uint256"}],"stateMutability":"nonpayable"},
  {"type":"function","name":"paymentToken","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},
  {"type":"function","name":"policy","inputs":[{"name":"namespaceId","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"","type":"tuple","internalType":"struct ISharedNameRegistryV3.Policy","components":[{"name":"grantSigner","type":"address","internalType":"address"},{"name":"annualRenewalPrice","type":"uint256","internalType":"uint256"},{"name":"totalClaimLimit","type":"uint64","internalType":"uint64"},{"name":"totalClaims","type":"uint64","internalType":"uint64"},{"name":"revision","type":"uint64","internalType":"uint64"},{"name":"configured","type":"bool","internalType":"bool"}]}],"stateMutability":"view"},
  {"type":"function","name":"quote","inputs":[{"name":"namespaceId","type":"bytes32","internalType":"bytes32"},{"name":"communityId","type":"bytes32","internalType":"bytes32"},{"name":"label","type":"string","internalType":"string"}],"outputs":[{"name":"q","type":"tuple","internalType":"struct ISharedNameRegistryV3.NameQuote","components":[{"name":"authorityRevision","type":"uint64","internalType":"uint64"},{"name":"policyRevision","type":"uint64","internalType":"uint64"},{"name":"scopeRevision","type":"uint64","internalType":"uint64"},{"name":"generation","type":"uint64","internalType":"uint64"},{"name":"status","type":"uint8","internalType":"enum ISharedNameRegistryV3.Status"},{"name":"reservedFor","type":"address","internalType":"address"},{"name":"initialPrice","type":"uint256","internalType":"uint256"},{"name":"renewalToken","type":"address","internalType":"address"},{"name":"annualRenewalPrice","type":"uint256","internalType":"uint256"},{"name":"namespaceClaimsRemaining","type":"uint64","internalType":"uint64"},{"name":"scopeClaimsRemaining","type":"uint64","internalType":"uint64"},{"name":"issuanceEnabled","type":"bool","internalType":"bool"}]}],"stateMutability":"view"},
  {"type":"function","name":"scope","inputs":[{"name":"namespaceId","type":"bytes32","internalType":"bytes32"},{"name":"communityId","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"","type":"tuple","internalType":"struct ISharedNameRegistryV3.Scope","components":[{"name":"submitter","type":"address","internalType":"address"},{"name":"totalClaimLimit","type":"uint64","internalType":"uint64"},{"name":"totalClaims","type":"uint64","internalType":"uint64"},{"name":"revision","type":"uint64","internalType":"uint64"},{"name":"enabled","type":"bool","internalType":"bool"}]}],"stateMutability":"view"}
] as const;

export type FreeClaim = ContractFunctionArgs<typeof namespaceRegistryAbi, "nonpayable", "claimFreeName">[0];
export type SharedAuthority = ContractFunctionReturnType<typeof namespaceRegistryAbi, "view", "authority">;
export type SharedPolicy = ContractFunctionReturnType<typeof namespaceRegistryAbi, "view", "policy">;
export type SharedScope = ContractFunctionReturnType<typeof namespaceRegistryAbi, "view", "scope">;
export type SharedQuote = ContractFunctionReturnType<typeof namespaceRegistryAbi, "view", "quote">;
export type HandshakeTrust = "local-full-node" | "local-spv" | "remote-trusted";
export interface SharedRegistrySource {
  schema: "pirate.shared-registry-source/1"; protocolVersion: 3; sourceCommit: string; abiSha256: string;
  chainId: 31337 | 6343; registry: Address; runtimeCodeHash: Hex;
  deployment: { blockNumber: string; blockHash: Hex; transactionHash: Hex };
  constructor: { admin: Address; paymentToken: Address; treasury: Address };
  compiler: { version: "0.8.30"; evmVersion: "cancun"; optimizer: true; optimizerRuns: 200; bytecodeHash: "none"; cborMetadata: false };
}
export interface PinnedRegistryReader {
  readonly block: Readonly<{ tag: "safe" | "finalized"; number: bigint; hash: Hex; timestamp: bigint }>;
  /** All reads, including code, MUST use blockHash + requireCanonical:true. */
  getCode(target: Address): Promise<Hex>;
  read(target: Address, abi: Abi, name: string, args?: readonly unknown[]): Promise<unknown>;
}
/** Structural result of accepted resolver verifySharedRegistry. Root owns its
 * independently selected source/RPC/HNS options; never deserialize this result. */
export interface VerifiedSharedRegistry {
  source: SharedRegistrySource; sourceSha256: string; reader: PinnedRegistryReader;
  delegation: { namespaceId: Hex; registry: Address; record: string;
    observation: { source: string; trust: HandshakeTrust; height?: number } };
  finish(): Promise<void>;
}
export interface NamespaceRegistrySource { verifyRegistry(tld: string): Promise<VerifiedSharedRegistry> }
export interface NamespaceObserverProfile {
  id: string; source: SharedRegistrySource; sourceSha256: string;
  blockTag: "safe" | "finalized"; maxBlockAgeSeconds: number; maxObservationAgeSeconds: number;
  maxClockAheadSeconds: number; acceptedHandshakeTrust: readonly HandshakeTrust[];
}
export interface NamespaceObservation {
  readonly tld: string; readonly namespaceId: Hex; readonly communityId: Hex;
  readonly sourceSha256: string; readonly chainId: 31337 | 6343; readonly registry: Address;
  readonly authority: SharedAuthority; readonly policy: SharedPolicy; readonly scope: SharedScope;
  readonly authorityId: Hex; readonly observedAt: number; readonly validUntil: number;
  readonly blockNumber: string; readonly blockHash: Hex; readonly blockTimestamp: number;
  readonly handshakeSource: Hex; readonly handshakeTrust: HandshakeTrust;
}
export class NamespaceError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "NamespaceError"; }
}
export function requireNamespace(value: unknown, code: string): asserts value { if (!value) throw new NamespaceError(code); }
export function identifier(value: string): string {
  requireNamespace(typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value), "invalid_identifier"); return value;
}
export function hash(value: string): Hex {
  requireNamespace(typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) && value !== `0x${"0".repeat(64)}`, "invalid_hash"); return value as Hex;
}
export function sha256(value: string): string {
  requireNamespace(typeof value === "string" && /^[0-9a-f]{64}$/.test(value) && value !== "0".repeat(64), "invalid_sha256"); return value;
}
export function seconds(value: number): number {
  requireNamespace(Number.isSafeInteger(value) && value >= 0, "invalid_time"); return value;
}
export function uint(value: bigint, bits = 256): bigint {
  requireNamespace(typeof value === "bigint" && value >= 0n && value < 2n ** BigInt(bits), "invalid_uint"); return value;
}
export function address(value: string): Address {
  requireNamespace(typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value), "invalid_address");
  let parsed: Address;
  try { parsed = getAddress(value); } catch { throw new NamespaceError("invalid_address"); }
  requireNamespace(parsed !== "0x0000000000000000000000000000000000000000", "zero_address"); return parsed;
}
/** Same canonical rules as source56 shared-keys.ts; no lowercase/trim/IDNA rewrite. */
export function label(value: string, minimum = 1): string {
  requireNamespace(typeof value === "string" && value.length >= minimum && value.length <= 63 &&
    /^(?!..--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value), "invalid_label"); return value;
}
export function freeze<const T>(value: T): Readonly<T> {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export function namespaceDigest(value: unknown): Hex {
  const ordered = (v: unknown): unknown => typeof v === "bigint" ? { bigint: v.toString() } : Array.isArray(v) ? v.map(ordered) :
    v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, child]) => [k, ordered(child)])) : v;
  return keccak256(stringToHex(JSON.stringify(ordered(value))));
}
// Exact identity formulas from source56 shared-keys.ts; vectors retained in packet.
const domain = (s: string) => keccak256(stringToHex(s));
export function sharedNamespaceIdFor(tld: string): Hex {
  label(tld); return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [domain("pirate.namespace/1"), domain(tld)]));
}
export function sharedNameKeyFor(namespaceId: Hex, name: string): Hex {
  hash(namespaceId); label(name);
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [domain("pirate.name/1"), namespaceId, domain(name)]));
}
export function sharedTokenIdFor(nameKey: Hex, generation: bigint): bigint {
  hash(nameKey); uint(generation, 64); requireNamespace(generation > 0n, "invalid_generation");
  return BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }], [domain("pirate.name-token/1"), nameKey, generation])));
}
/** Canonical field order matches accepted parseSharedRegistrySource. The selected
 * digest remains a Root-owned trust input; valid syntax alone establishes none. */
export function selectedSource(input: SharedRegistrySource, expectedSha256: string): Readonly<SharedRegistrySource> {
  const fields = (value: unknown, names: string[]) => requireNamespace(value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...names].sort().join("|"), "invalid_source_schema");
  fields(input, ["schema", "protocolVersion", "sourceCommit", "abiSha256", "chainId", "registry", "runtimeCodeHash", "deployment", "constructor", "compiler"]);
  fields(input.deployment, ["blockNumber", "blockHash", "transactionHash"]);
  fields(input.constructor, ["admin", "paymentToken", "treasury"]);
  fields(input.compiler, ["version", "evmVersion", "optimizer", "optimizerRuns", "bytecodeHash", "cborMetadata"]);
  sha256(expectedSha256);
  requireNamespace(input.schema === "pirate.shared-registry-source/1" && input.protocolVersion === 3 &&
    (input.chainId === 31337 || input.chainId === 6343), "unsupported_source");
  requireNamespace(/^[0-9a-f]{40}$/.test(input.sourceCommit) && input.sourceCommit !== "0".repeat(40) && input.abiSha256 === sharedRegistryAbiSha256, "source_pin_mismatch");
  requireNamespace(/^(0|[1-9][0-9]{0,19})$/.test(input.deployment.blockNumber) && BigInt(input.deployment.blockNumber) <= 0xffffffffffffffffn, "invalid_deployment");
  const c = input.compiler;
  requireNamespace(c.version === "0.8.30" && c.evmVersion === "cancun" && c.optimizer === true && c.optimizerRuns === 200 && c.bytecodeHash === "none" && c.cborMetadata === false, "compiler_mismatch");
  const source: SharedRegistrySource = { schema: input.schema, protocolVersion: 3, sourceCommit: input.sourceCommit,
    abiSha256: input.abiSha256, chainId: input.chainId, registry: address(input.registry), runtimeCodeHash: hash(input.runtimeCodeHash),
    deployment: { blockNumber: input.deployment.blockNumber, blockHash: hash(input.deployment.blockHash), transactionHash: hash(input.deployment.transactionHash) },
    constructor: { admin: address(input.constructor.admin), paymentToken: address(input.constructor.paymentToken), treasury: address(input.constructor.treasury) },
    compiler: { version: "0.8.30", evmVersion: "cancun", optimizer: true, optimizerRuns: 200, bytecodeHash: "none", cborMetadata: false } };
  requireNamespace(createHash("sha256").update(JSON.stringify(source)).digest("hex") === expectedSha256, "source_pin_mismatch");
  return freeze(source);
}

export class NamespaceRegistryAdapter {
  readonly profile: Readonly<NamespaceObserverProfile>;
  #source?: NamespaceRegistrySource; #clock: () => number;
  #views = new WeakMap<NamespaceObservation, VerifiedSharedRegistry>();
  constructor(profile: NamespaceObserverProfile, source: NamespaceRegistrySource | undefined, now: () => number) {
    identifier(profile.id);
    const selected = selectedSource(profile.source, profile.sourceSha256);
    for (const n of [profile.maxBlockAgeSeconds, profile.maxObservationAgeSeconds, profile.maxClockAheadSeconds]) seconds(n);
    requireNamespace(profile.maxBlockAgeSeconds > 0 && profile.maxBlockAgeSeconds <= 5400 && profile.maxObservationAgeSeconds > 0 &&
      (profile.blockTag === "safe" || profile.blockTag === "finalized"), "invalid_profile");
    requireNamespace(Array.isArray(profile.acceptedHandshakeTrust) && profile.acceptedHandshakeTrust.length > 0 && profile.acceptedHandshakeTrust.every(t => ["local-full-node", "local-spv", "remote-trusted"].includes(t)), "invalid_handshake_trust");
    this.profile = freeze({ ...profile, source: selected, acceptedHandshakeTrust: [...profile.acceptedHandshakeTrust] });
    this.#source = source; this.#clock = now;
  }
  now() { return seconds(this.#clock()); }
  async #read<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (e) { if (e instanceof NamespaceError) throw e; throw new NamespaceError("authority_read_failed"); }
  }
  async observe(tld: string, communityId: Hex): Promise<NamespaceObservation> {
    label(tld); hash(communityId); requireNamespace(this.#source, "observer_unavailable");
    const start = this.now(); const p = this.profile;
    const view = await this.#read(() => this.#source!.verifyRegistry(tld));
    selectedSource(view.source, p.sourceSha256);
    requireNamespace(view.sourceSha256 === p.sourceSha256 && view.delegation.namespaceId === sharedNamespaceIdFor(tld) && address(view.delegation.registry) === p.source.registry, "namespace_source_mismatch");
    const hns = view.delegation.observation;
    requireNamespace(p.acceptedHandshakeTrust.includes(hns.trust) && typeof hns.source === "string" && hns.source.length > 0, "unaccepted_handshake_source");
    requireNamespace(view.delegation.record.toLowerCase().replace(/\.$/, "") === `${p.source.registry.toLowerCase()}.${p.source.chainId}._evm`, "delegation_mismatch");
    const b = view.reader.block; uint(b.number); uint(b.timestamp); hash(b.hash);
    requireNamespace(b.tag === p.blockTag && b.number >= BigInt(p.source.deployment.blockNumber) && b.timestamp <= BigInt(Number.MAX_SAFE_INTEGER), "invalid_block");
    const namespaceId = sharedNamespaceIdFor(tld);
    const read = (name: string, args: readonly unknown[] = []) => view.reader.read(p.source.registry, namespaceRegistryAbi, name, args);
    const [code, version, currency, authority, policy, scope] = await this.#read(() => Promise.all([
      view.reader.getCode(p.source.registry), read("PROTOCOL_VERSION"), read("paymentToken"),
      read("authority", [namespaceId]), read("policy", [namespaceId]), read("scope", [namespaceId, communityId]),
    ]));
    requireNamespace(code !== "0x" && keccak256(code) === p.source.runtimeCodeHash && Number(version) === 3 && address(currency as string) === p.source.constructor.paymentToken, "registry_configuration_mismatch");
    const a = authority as SharedAuthority, pol = policy as SharedPolicy, s = scope as SharedScope;
    for (const n of [a.observedAt, a.validUntil, a.revision, pol.totalClaimLimit, pol.totalClaims, pol.revision, s.totalClaimLimit, s.totalClaims, s.revision]) uint(n, 64);
    uint(pol.annualRenewalPrice); hash(a.evidenceHash);
    requireNamespace(a.tld === tld && a.migrationRequired === false && a.issuanceEnabled === true && a.observedAt <= b.timestamp && a.validUntil > b.timestamp, "authority_unavailable");
    requireNamespace(pol.configured === true && s.enabled === true && pol.totalClaims < pol.totalClaimLimit && s.totalClaims < s.totalClaimLimit &&
      address(pol.grantSigner) !== address(s.submitter), "issuance_unavailable");
    await this.#read(() => view.finish());
    const now = this.now(), timestamp = Number(b.timestamp);
    const validUntil = Math.min(start + p.maxObservationAgeSeconds, timestamp + p.maxBlockAgeSeconds, Number(a.validUntil));
    requireNamespace(Number.isSafeInteger(validUntil) && now >= start && now < validUntil && timestamp <= now + p.maxClockAheadSeconds, "stale_observation");
    const observation: NamespaceObservation = freeze({ tld, namespaceId, communityId, sourceSha256: p.sourceSha256,
      chainId: p.source.chainId, registry: p.source.registry, authority: { ...a }, policy: { ...pol }, scope: { ...s },
      authorityId: namespaceDigest([namespaceId, communityId, p.sourceSha256, a, pol.grantSigner, pol.annualRenewalPrice, pol.revision, pol.totalClaimLimit, s.submitter, s.revision, s.totalClaimLimit]),
      observedAt: now, validUntil, blockNumber: b.number.toString(), blockHash: b.hash, blockTimestamp: timestamp,
      handshakeSource: namespaceDigest(["handshake-source", hns.source]), handshakeTrust: hns.trust });
    this.#views.set(observation, view); return observation;
  }
  async quote(observation: NamespaceObservation, name: string): Promise<SharedQuote> {
    label(name, 8); const view = this.#views.get(observation); requireNamespace(view, "foreign_observation");
    requireNamespace(this.now() < observation.validUntil, "stale_observation");
    const q = await this.#read(() => view.reader.read(observation.registry, namespaceRegistryAbi, "quote", [observation.namespaceId, observation.communityId, name])) as SharedQuote;
    for (const n of [q.generation, q.authorityRevision, q.policyRevision, q.scopeRevision, q.namespaceClaimsRemaining, q.scopeClaimsRemaining]) uint(n, 64);
    uint(q.initialPrice); uint(q.annualRenewalPrice);
    requireNamespace(q.issuanceEnabled === true && q.initialPrice === 0n && q.namespaceClaimsRemaining > 0n && q.scopeClaimsRemaining > 0n && q.generation > 0n &&
      (q.status === 0 || q.status === 3) && q.authorityRevision === observation.authority.revision && q.policyRevision === observation.policy.revision && q.scopeRevision === observation.scope.revision &&
      q.annualRenewalPrice === observation.policy.annualRenewalPrice && address(q.renewalToken) === this.profile.source.constructor.paymentToken, "free_quote_unavailable");
    requireNamespace(/^0x[0-9a-fA-F]{40}$/.test(q.reservedFor), "invalid_reservation");
    await this.#read(() => view.finish());
    requireNamespace(this.now() < observation.validUntil, "stale_observation"); return freeze({ ...q });
  }
}
