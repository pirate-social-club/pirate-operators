/** Managed service admission. Grant/selection/observation types belong to their
 * existing owners; an issuer signature authenticates provisioning, not a hash. */
import { timingSafeEqual } from "node:crypto";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, bytes32, exact, hashJson, hashText, insist, integer, object, text } from "../community/common.ts";
import { address, httpsOrigin } from "../community/manifest-core.ts";
import { catalogOwner } from "../community/owner-policy.ts";
import { validateOwnerGrant, claimOwnerWindow, ownerBudgetKey, ownerBudgetCeiling, ownerLimitsDigest, requireOwnerGrantTime, type OwnerBudgetGrant, type OwnerBudgetAsset } from "./owner-grant.ts";
import { installationReference } from "../../deploy/linux/backend-state.ts";
import { verifyRecord, type SignedRecord, type TrustAnchor } from "../../deploy/linux/installed-records.ts";
import type { ConfiguredGrantSelection, GrantAttachmentObservation, OwnerGrantScope } from "../../deploy/linux/web2-operator-inputs.ts";
import { configuredGrantSelection } from "../../deploy/linux/web2-publishing-attachment.ts";
import { isWeb2Deployment, validateCommunityDeploymentProfile, type Web2CommunityDeploymentProfile } from "../../services/community-deployment-profile.ts";

export interface ManagedPublishingRegistration {
  schema: "pirate.managed-publishing-registration/1";
  issuerKeyId: string;
  admissionReference: string;
  serviceOrigin: string;
  scope: OwnerGrantScope;
  grant: OwnerBudgetGrant;
  deployment: Web2CommunityDeploymentProfile;
  configurationSha256: Hex;
  /** The existing original plan and signed transaction, authenticated on-chain. */
  registrationOriginal: { plan: unknown; rawTransaction: Hex; transactionHash: Hex };
  custody: { keyReference: string; generation: number; installationId: string; publisher: string; custodyBindingDigest: Hex };
  credential: { keyReference: string; generation: number; sha256: Hex };
  moderation: { budgetPeriod: string; requestCap: number };
}
export interface ManagedPublishingConfiguration {
  schema: "pirate.managed-publishing-service/1";
  origin: string;
  journal: { epoch: Hex; restoreAnchorSha256: Hex };
  registrations: SignedRecord<ManagedPublishingRegistration>[];
  disabledAdmissionReferences: string[];
}

const publicFixtureKeys: readonly Hex[] = Object.freeze([
  ...["11", "22", "33", "41", "51", "52", "61", "62", "73"].map(value => bytes32("0x" + value.repeat(32))),
  ...Array.from({ length: 10 }, (_, index) => bytes32("0x" + (index + 1).toString(16).padStart(64, "0"))),
]);
const publicFixturePublishers = Object.freeze(publicFixtureKeys.map(key => privateKeyToAccount(key).address.toLowerCase()));
export function requireDedicatedManagedSigner(key: Hex, rpcUrl: string) {
  managedDigest(key);
  const url = new URL(rpcUrl), local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  insist(local || !publicFixtureKeys.includes(key), "public_fixture_key_forbidden", 503);
  return privateKeyToAccount(key);
}
/** Canonical wire strings use a real end, not JavaScript's final-LF `$`. */
export function managedDigest(value: unknown): Hex {
  insist(typeof value === "string" && value.length === 66, "invalid_managed_digest");
  return bytes32(value);
}
function reference(value: unknown, max: number) {
  const v = text(value, max);
  insist(v.length > 0 && !/[\x00-\x1f\x7f\u2028\u2029]/.test(v), "invalid_managed_reference"); return v;
}
function managedAddress(value: unknown) {
  insist(typeof value === "string" && value.length === 42, "invalid_managed_address"); return address(value);
}
export function managedGrantScope(input: unknown): OwnerGrantScope {
  const s = object(structuredClone(input)); exact(object(s), ["schema", "enrollmentId", "installationId", "hostInstallationId", "deploymentDigest",
    "communityId", "origin", "controller", "ownerWallet", "policy", "chainId", "postsContract", "publisher"]);
  const policy = object(s.policy); exact(policy, ["version", "sha256"]);
  insist(s.schema === "pirate.web2-owner-grant-scope/1" && s.chainId === 6343, "managed_scope_unavailable", 409);
  const scope: OwnerGrantScope = { schema: s.schema, enrollmentId: managedDigest(s.enrollmentId), installationId: managedDigest(s.installationId),
    hostInstallationId: text(s.hostInstallationId, 200), deploymentDigest: managedDigest(s.deploymentDigest), communityId: managedDigest(s.communityId),
    origin: httpsOrigin(s.origin), controller: managedAddress(s.controller), ownerWallet: managedAddress(s.ownerWallet),
    policy: { version: text(policy.version, 100), sha256: managedDigest(policy.sha256) }, chainId: 6343,
    postsContract: managedAddress(s.postsContract), publisher: managedAddress(s.publisher) };
  insist(installationReference(scope.hostInstallationId) && !/[\u2028\u2029]/.test(scope.hostInstallationId) && canonical(scope) === canonical(input), "managed_scope_changed", 409);
  return scope;
}
export function authenticatedManagedRegistration(record: SignedRecord<ManagedPublishingRegistration>, trust: TrustAnchor) {
  exact(object(trust), ["keyId", "spki"]);
  insist(reference(trust.keyId, 200).length > 0 && reference(trust.spki, 8192).length > 0, "managed_issuer_unavailable", 503);
  exact(object(record), ["schema", "keyId", "body", "signature"]);
  const r = structuredClone(verifyRecord(record, trust));
  exact(object(r), ["schema", "issuerKeyId", "admissionReference", "serviceOrigin", "scope", "grant", "deployment", "configurationSha256",
    "registrationOriginal", "custody", "credential", "moderation"]);
  exact(object(r.custody), ["keyReference", "generation", "installationId", "publisher", "custodyBindingDigest"]);
  exact(object(r.credential), ["keyReference", "generation", "sha256"]);
  exact(object(r.moderation), ["budgetPeriod", "requestCap"]);
  exact(object(r.registrationOriginal), ["plan", "rawTransaction", "transactionHash"]);
  const scope = managedGrantScope(r.scope), grant = validateOwnerGrant(r.grant), deployment = validateCommunityDeploymentProfile(r.deployment);
  insist(catalogOwner(scope.policy), "fresh_managed_catalog_policy_required", 503);
  insist(isWeb2Deployment(deployment) && r.schema === "pirate.managed-publishing-registration/1" && r.issuerKeyId === trust.keyId,
    "managed_issuer_unavailable", 503);
  const local = new URL(deployment.rpcUrl);
  insist(local.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) ||
    !publicFixturePublishers.includes(scope.publisher), "public_fixture_key_forbidden", 503);
  const { custodyBindingDigest, ...custody } = r.custody;
  const generation = integer(custody.generation, 1, Number.MAX_SAFE_INTEGER);
  insist(reference(custody.keyReference, 256).length > 0 && generation > 0 && custody.installationId === scope.hostInstallationId &&
    address(custody.publisher) === scope.publisher && custodyBindingDigest === hashJson(custody), "managed_custody_unavailable", 503);
  insist(reference(r.credential.keyReference, 256).length > 0 && integer(r.credential.generation, 1, Number.MAX_SAFE_INTEGER) > 0,
    "managed_credential_unavailable", 503);
  managedDigest(r.credential.sha256); managedDigest(r.configurationSha256); managedDigest(r.registrationOriginal.transactionHash);
  managedDigest(r.custody.custodyBindingDigest);
  insist(typeof r.registrationOriginal.rawTransaction === "string" && /^0x(?:[0-9a-f]{2})+(?![\s\S])/.test(r.registrationOriginal.rawTransaction) &&
    r.registrationOriginal.rawTransaction.length <= 65536 && keccak256(r.registrationOriginal.rawTransaction) === r.registrationOriginal.transactionHash, "managed_registration_original_invalid", 503);
  insist(/^[A-Za-z0-9:_./-]{1,200}(?![\s\S])/.test(text(r.admissionReference, 200)) &&
    /^[a-z0-9][a-z0-9_-]{1,63}(?![\s\S])/.test(text(r.moderation.budgetPeriod, 64)) &&
    integer(r.moderation.requestCap, 1, 100) > 0, "managed_admission_unavailable", 503);
  insist(httpsOrigin(r.serviceOrigin) === deployment.managedOrigin && deployment.directoryProfile.communityId === scope.communityId &&
    deployment.directoryProfile.installationId === scope.installationId && deployment.origin === scope.origin &&
    deployment.posts.address === scope.postsContract && hashJson(deployment) === scope.deploymentDigest,
    "managed_deployment_changed", 409);
  // Reuse the frozen W1 contract, including every existing grant constraint.
  const selection = selectionFor({ ...r, scope, grant });
  configuredGrantSelection(selection, scope);
  insist(canonical({ ...r, scope, grant, deployment }) === canonical(r), "managed_registration_changed", 409);
  return r;
}
export function selectionFor(r: ManagedPublishingRegistration): ConfiguredGrantSelection {
  const body = { schema: "pirate.web2-configured-owner-grant/1" as const, scope: r.scope, grant: r.grant,
    admissionReference: r.admissionReference };
  return { ...structuredClone(body), selectionDigest: hashJson(body) };
}
export function managedPublishingConfiguration(input: ManagedPublishingConfiguration, trust: TrustAnchor) {
  const c = structuredClone(input); exact(object(c), ["schema", "origin", "journal", "registrations", "disabledAdmissionReferences"]);
  exact(object(c.journal), ["epoch", "restoreAnchorSha256"]);
  insist(c.schema === "pirate.managed-publishing-service/1" && Array.isArray(c.registrations) && c.registrations.length >= 0 &&
    c.registrations.length <= 100 && Array.isArray(c.disabledAdmissionReferences) && c.disabledAdmissionReferences.length <= 100,
    "managed_service_configuration_unavailable", 503);
  httpsOrigin(c.origin); managedDigest(c.journal.epoch); managedDigest(c.journal.restoreAnchorSha256);
  const registrations = c.registrations.map(r => authenticatedManagedRegistration(r, trust));
  insist(registrations.every(r => r.serviceOrigin === c.origin) &&
    new Set(registrations.map(r => r.admissionReference)).size === registrations.length &&
    new Set(registrations.map(r => r.scope.enrollmentId)).size === registrations.length &&
    new Set(c.disabledAdmissionReferences).size === c.disabledAdmissionReferences.length &&
    c.disabledAdmissionReferences.every(ref => /^[A-Za-z0-9:_./-]{1,200}(?![\s\S])/.test(reference(ref, 200))),
    "managed_configuration_conflict", 503);
  return c;
}
export function authenticateManagedCredential(request: Request, r: ManagedPublishingRegistration) {
  const origin = request.headers.get("origin"), bearer = request.headers.get("authorization") ?? "";
  insist(new URL(request.url).origin === r.serviceOrigin && (origin === null || origin === r.serviceOrigin) &&
    request.headers.get("x-pirate-installation") === r.scope.hostInstallationId && bearer.length <= 1024 &&
    /^Bearer [A-Za-z0-9_-]{32,512}(?![\s\S])/.test(bearer), "managed_service_authentication_failed", 403);
  const actual = Buffer.from(hashText(bearer.slice(7)).slice(2), "hex"), expected = Buffer.from(r.credential.sha256.slice(2), "hex");
  insist(actual.length === expected.length && timingSafeEqual(actual, expected), "managed_service_authentication_failed", 403);
}
interface AdmissionRow { original_id: string; admission_reference: string; selection_digest: Hex; selection_json: string;
  registration_json: string; state: "prepared" | "attaching" | "attached"; attached_at: number | null }

export class ManagedPublishingJournal {
  constructor(readonly db: D1Database, readonly config: ManagedPublishingConfiguration) {}
  async installation() {
    const row = await this.db.withSession("first-primary").prepare("SELECT epoch,restore_anchor_sha256 FROM managed_publishing_installation WHERE origin=?")
      .bind(this.config.origin).first<{ epoch: string; restore_anchor_sha256: string }>();
    insist(row?.epoch === this.config.journal.epoch && row.restore_anchor_sha256 === this.config.journal.restoreAnchorSha256,
      "managed_installation_unqualified", 503);
  }
  async registration(r: ManagedPublishingRegistration, requireActive = true) {
    await this.installation();
    const row = await this.db.withSession("first-primary").prepare("SELECT record_json,state FROM managed_publishing_registrations WHERE admission_reference=?")
      .bind(r.admissionReference).first<{ record_json: string; state: string }>();
    insist(row && canonical(JSON.parse(row.record_json).body) === canonical(r), "managed_original_conflict", 409);
    if (requireActive) insist(row.state === "active" && !this.config.disabledAdmissionReferences.includes(r.admissionReference), "managed_admission_revoked", 403);
  }
  async row(digest: Hex): Promise<AdmissionRow | null> {
    return this.db.withSession("first-primary").prepare("SELECT * FROM managed_publishing_admissions WHERE selection_digest=?").bind(digest).first<AdmissionRow>();
  }
  async retainedSelection(r: ManagedPublishingRegistration) {
    const row = await this.db.withSession("first-primary").prepare("SELECT * FROM managed_publishing_admissions WHERE original_id=?")
      .bind(r.scope.enrollmentId).first<AdmissionRow>();
    if (!row) return null;
    const expected = selectionFor(r);
    insist(row.selection_digest === expected.selectionDigest && row.admission_reference === r.admissionReference &&
      row.registration_json === canonical(r) && row.selection_json === canonical(expected), "managed_original_conflict", 409);
    return configuredGrantSelection(JSON.parse(row.selection_json), r.scope);
  }
  async prepare(r: ManagedPublishingRegistration) {
    const selection = selectionFor(r);
    await this.db.prepare(`INSERT INTO managed_publishing_admissions(original_id,admission_reference,selection_digest,selection_json,registration_json,state)
      VALUES(?,?,?,?,?,'prepared') ON CONFLICT DO NOTHING`).bind(r.scope.enrollmentId, r.admissionReference, selection.selectionDigest,
      canonical(selection), canonical(r)).run();
    const row = await this.row(selection.selectionDigest);
    insist(row?.original_id === r.scope.enrollmentId && row.registration_json === canonical(r) && row.selection_json === canonical(selection),
      "managed_original_conflict", 409);
    return selection;
  }
  async beginAttach(r: ManagedPublishingRegistration, digest: Hex) {
    insist(digest === selectionFor(r).selectionDigest, "managed_selection_changed", 409);
    const row = await this.row(digest);
    insist(row && row.registration_json === canonical(r), "managed_original_unavailable", 409);
    await this.db.prepare(`UPDATE managed_publishing_admissions SET state='attaching' WHERE selection_digest=? AND state='prepared'
      AND EXISTS(SELECT 1 FROM managed_publishing_registrations WHERE admission_reference=? AND state='active')`).bind(digest, r.admissionReference).run();
  }
  async finishAttach(r: ManagedPublishingRegistration, digest: Hex, now: number) {
    requireOwnerGrantTime(r.grant, now);
    await this.db.prepare(`UPDATE managed_publishing_admissions SET state='attached',attached_at=COALESCE(attached_at,?)
      WHERE selection_digest=? AND state='attaching' AND EXISTS(SELECT 1 FROM managed_publishing_registrations WHERE admission_reference=? AND state='active')`)
      .bind(now, digest, r.admissionReference).run();
    const observation = await this.observation(r, digest);
    insist(observation.state === "attached", "managed_attachment_unknown", 503);
    return observation;
  }
  async observation(r: ManagedPublishingRegistration, digest: Hex): Promise<GrantAttachmentObservation> {
    insist(digest === selectionFor(r).selectionDigest, "managed_selection_changed", 409);
    const row = await this.row(digest);
    // A lost row, schema or database is uncertainty, never proof of absence.
    insist(row && row.registration_json === canonical(r) && row.selection_json === canonical(selectionFor(r)) &&
      row.admission_reference === r.admissionReference && row.original_id === r.scope.enrollmentId, "managed_original_unavailable", 503);
    return { selectionDigest: digest, grantDigest: r.grant.sha256, admissionReference: r.admissionReference,
      state: row.state === "attached" ? "attached" : row.state === "prepared" ? "absent" : "unknown" };
  }
}
/** Manual, callable provisioning producer. Only the Pirate provisioning process
 * supplies the signed originals/trust; this is never invoked by request traffic.
 * It claims existing owner windows and cannot reset counters or reactivate rows. */
export async function provisionManagedPublishingInputs(db: D1Database, input: ManagedPublishingConfiguration, trust: TrustAnchor,
  now = Math.floor(Date.now() / 1000)) {
  const c = managedPublishingConfiguration(input, trust);
  await db.prepare(`INSERT INTO managed_publishing_installation(origin,epoch,restore_anchor_sha256) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
    .bind(c.origin, c.journal.epoch, c.journal.restoreAnchorSha256).run();
  const journal = new ManagedPublishingJournal(db, c); await journal.installation();
  for (const record of c.registrations) {
    const r = authenticatedManagedRegistration(record, trust);
    requireOwnerGrantTime(r.grant, now);
    const inserted = await db.prepare(`INSERT INTO managed_publishing_registrations(admission_reference,original_id,record_json,state) VALUES(?,?,?,'provisioning') ON CONFLICT DO NOTHING`)
      .bind(r.admissionReference, r.scope.enrollmentId, canonical(record)).run();
    await journal.registration(r, false);
    const state = await db.withSession("first-primary").prepare("SELECT state FROM managed_publishing_registrations WHERE admission_reference=?")
      .bind(r.admissionReference).first<{ state: string }>();
    insist(state && ["provisioning", "active"].includes(state.state) && !c.disabledAdmissionReferences.includes(r.admissionReference), "managed_admission_revoked", 403);
    if (inserted.meta.changes !== 1) {
      // A retry may confirm an already acquired window, but cannot reconstruct
      // missing counters after an interrupted/unknown provisioning attempt.
      const key = ownerBudgetKey(r.grant, "songs"), assets: readonly OwnerBudgetAsset[] = ["songs", "pin_adds", "pin_bytes", "recognition_requests", "post_fee_wei"],
        window = await db.withSession("first-primary").prepare("SELECT valid_from,expires_at,limits_sha256 FROM owner_budget_windows WHERE scope=?")
          .bind(key.scope).first<{ valid_from: number; expires_at: number; limits_sha256: string }>(),
        budgets = await db.withSession("first-primary").prepare("SELECT asset,ceiling FROM spending_budgets WHERE scope=? AND period=?")
          .bind(key.scope, key.period).all<{ asset: string; ceiling: string }>();
      insist(window?.valid_from === r.grant.validFrom && window.expires_at === r.grant.expiresAt && window.limits_sha256 === ownerLimitsDigest(r.grant) &&
        budgets.results.length === assets.length && assets.every(asset => budgets.results.some(row => row.asset === asset && row.ceiling === ownerBudgetCeiling(r.grant, asset))),
        "managed_provisioning_unknown", 503);
    }
    // Same window claims always retain every original ceiling and counter.
    await claimOwnerWindow(db, r.grant, now);
    requireOwnerGrantTime(r.grant, Math.max(now, Math.floor(Date.now() / 1000)));
    await db.prepare("UPDATE managed_publishing_registrations SET state='active' WHERE admission_reference=? AND state='provisioning'")
      .bind(r.admissionReference).run();
    await journal.registration(r);
  }
  return { origin: c.origin, admitted: c.registrations.map(r => r.body.admissionReference), journal: c.journal };
}
/** Provisioning-side revocation. No deletion, reactivation or original rewrite. */
export async function revokeManagedPublishingAdmission(db: D1Database, reference: string, state: "revoked" | "disabled" = "revoked") {
  insist(["revoked", "disabled"].includes(state) && /^[A-Za-z0-9:_./-]{1,200}(?![\s\S])/.test(text(reference, 200)), "invalid_managed_reference");
  await db.prepare("UPDATE managed_publishing_registrations SET state=? WHERE admission_reference=?").bind(state, reference).run();
}
