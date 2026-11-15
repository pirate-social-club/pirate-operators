import { requireOwnerGrantTime } from "../packages/release/owner-grant.ts";
import { keccak256, parseTransaction } from "viem";
import { bytes32, canonical, exact, hashJson, insist, integer, object, text } from "../packages/community/common.ts";
import { readWeb2Community } from "../packages/community/web2-directory-reader.ts";
import { parseWeb2ProfileDocument } from "../packages/community/web2-directory.ts";
import { parsePlan } from "../packages/community/hosted-enrollment.ts";
import { bindWeb2RegistrationTransaction, observeWeb2Registration } from "../packages/community/web2-registration-chain.ts";
import { megaethReadClient } from "../packages/community/chain.ts";
import { communityIpfsTransport } from "./community-deployment-profile.ts";
import { authenticatedManagedRegistration, managedPublishingConfiguration, ManagedPublishingJournal, selectionFor, requireDedicatedManagedSigner, type ManagedPublishingConfiguration, type ManagedPublishingRegistration } from "../packages/release/managed-publishing-admission.ts";
import { verifyRecord, type SignedRecord, type TrustAnchor } from "../deploy/linux/installed-records.ts";
import { recognitionProfile, type RecognitionProfile } from "../packages/recognition/intent.ts";
import { validateProviderBinding, type ManagedCatalogBinding } from "../packages/recognition/provider-binding.ts";
import { canonicalCommunityClient } from "../packages/recognition/canonical-transport.ts";
import { sharedRecognitionRuntime, type RecognitionWake } from "./shared-recognition-runtime.ts";
import type { CanonicalCommunity } from "../packages/recognition/canonical-community.ts";
import type { Hex } from "viem";

/** Reads genuine original registration, current canonical config and pinned Posts
 * code. An admission hash alone is never independent external evidence. */
export async function readPinnedManagedCommunity(input: ManagedPublishingRegistration) {
  const r = structuredClone(input), d = r.deployment, p = parseWeb2ProfileDocument(d.directoryProfile),
    plan = parsePlan(r.registrationOriginal.plan), tx = parseTransaction(r.registrationOriginal.rawTransaction),
    client = megaethReadClient(undefined, d.rpcUrl);
  insist(plan.profile.chainId === 6343 && canonical({ ...plan.profile, deploymentBlock: String(plan.profile.deploymentBlock) }) === canonical(d.directoryProfile) &&
    hashJson(plan.config) === r.configurationSha256 && tx.type === "eip1559" && tx.nonce !== undefined && tx.gas !== undefined &&
    tx.maxFeePerGas !== undefined && tx.maxPriorityFeePerGas !== undefined, "managed_registration_original_changed", 409);
  const original = await bindWeb2RegistrationTransaction(plan, r.registrationOriginal.rawTransaction, {
    nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
  });
  insist(original.transactionHash === r.registrationOriginal.transactionHash, "managed_registration_original_changed", 409);
  const observed = await observeWeb2Registration(client, original);
  insist(observed.status === "consumed", "managed_registration_not_safe", 503);
  const read = await readWeb2Community(client, p, { now: () => BigInt(Math.floor(Date.now() / 1000)),
    maxSafeBlockAgeSeconds: BigInt(d.freshness.maxSafeBlockAgeSeconds) }, communityIpfsTransport(d));
  insist(read.eligibility.status === "available", "managed_canonical_unavailable", 503);
  const c = read.config, s = r.scope;
  insist(c.chainId === 6343 && c.installationId === s.installationId && c.communityId === s.communityId &&
    c.controller === s.controller && c.publisher === s.publisher && c.app.origin === s.origin &&
    c.postsContract === s.postsContract && canonical(c.policies.admission) === canonical(s.policy) &&
    hashJson(c) === r.configurationSha256, "managed_canonical_scope_changed", 409);
  const code = await client.getCode({ address: d.posts.address, blockNumber: read.blockNumber }),
    safe = await client.getBlock({ blockNumber: read.blockNumber });
  insist(code && keccak256(code) === d.posts.runtimeCodeHash && read.blockNumber >= BigInt(d.posts.deploymentBlock) &&
    safe.hash === read.blockHash && safe.timestamp <= BigInt(Math.floor(Date.now() / 1000)) &&
    BigInt(Math.floor(Date.now() / 1000)) - safe.timestamp <= BigInt(d.freshness.maxSafeBlockAgeSeconds), "managed_pinned_deployment_unavailable", 503);
  return c;
}
export interface SharedRecognitionConfiguration {
  schema: "pirate.shared-recognition-service/1";
  profile: RecognitionProfile;
  binding: ManagedCatalogBinding;
  journal: { epoch: Hex; restoreAnchorSha256: Hex };
  quotas: { service: number; community: number };
  communities: SignedRecord<ManagedPublishingRegistration>[];
}
export interface SharedRecognitionEnv {
  DB: D1Database;
  ADMISSION_DB: D1Database;
  MANAGED_PUBLISHING_CONFIGURATION_JSON: string;
  JOBS: Queue<RecognitionWake>;
  RECOGNITION_CONFIGURATION_JSON: string;
  SERVICE_CONFIGURATION_TRUST_JSON: string;
  RECOGNITION_SIGNER_PRIVATE_KEY: string;
  ACRCLOUD_HOST: string;
  ACRCLOUD_ACCESS_KEY: string;
  ACRCLOUD_ACCESS_SECRET: string;
  ACRCLOUD_CATALOG_TOKEN: string;
}
export function trustedRecognitionConfiguration(record: SignedRecord<SharedRecognitionConfiguration>, trust: TrustAnchor) {
  exact(object(record), ["schema", "keyId", "body", "signature"]);
  const c = structuredClone(verifyRecord(record, trust));
  exact(object(c), ["schema", "profile", "binding", "journal", "quotas", "communities"]);
  exact(object(c.journal), ["epoch", "restoreAnchorSha256"]); exact(object(c.quotas), ["service", "community"]);
  insist(c.schema === "pirate.shared-recognition-service/1" && Array.isArray(c.communities) && c.communities.length > 0 &&
    c.communities.length <= 100, "recognition_configuration_unavailable", 503);
  const profile = recognitionProfile(c.profile); bytes32(c.journal.epoch); bytes32(c.journal.restoreAnchorSha256);
  integer(c.quotas.service, 1, 1000000); integer(c.quotas.community, 1, c.quotas.service);
  const communities = c.communities.map(r => authenticatedManagedRegistration(r, trust));
  insist(new Set(communities.map(r => r.scope.communityId)).size === communities.length && canonical(profile) === canonical(c.profile),
    "recognition_community_configuration_changed", 503);
  return c;
}
/** Explicit provisioning only; request handlers never recreate an installation. */
export async function provisionSharedRecognitionInputs(db: D1Database, record: SignedRecord<SharedRecognitionConfiguration>, trust: TrustAnchor) {
  const c = trustedRecognitionConfiguration(record, trust);
  await db.prepare("INSERT INTO shared_recognition_installation(namespace,profile_sha256,journal_epoch,restore_anchor_sha256) VALUES(?,?,?,?) ON CONFLICT DO NOTHING")
    .bind(c.profile.namespace, c.profile.sha256, c.journal.epoch, c.journal.restoreAnchorSha256).run();
  const row = await db.withSession("first-primary").prepare("SELECT * FROM shared_recognition_installation WHERE namespace=?").bind(c.profile.namespace)
    .first<{ profile_sha256: string; journal_epoch: string; restore_anchor_sha256: string }>();
  insist(row?.profile_sha256 === c.profile.sha256 && row.journal_epoch === c.journal.epoch && row.restore_anchor_sha256 === c.journal.restoreAnchorSha256,
    "recognition_restore_or_installation_unqualified", 503);
}
/** Every event captures its own registry and credentials. No shared authority Map. */
export function configuredRecognitionRuntime(env: SharedRecognitionEnv, purpose: "read" | "effect" = "effect") {
  insist(typeof env.RECOGNITION_CONFIGURATION_JSON === "string" && env.RECOGNITION_CONFIGURATION_JSON.length <= 1024 * 1024 &&
    typeof env.SERVICE_CONFIGURATION_TRUST_JSON === "string" && env.SERVICE_CONFIGURATION_TRUST_JSON.length <= 8192,
    "recognition_configuration_unavailable", 503);
  const trust: TrustAnchor = JSON.parse(env.SERVICE_CONFIGURATION_TRUST_JSON),
    record: SignedRecord<SharedRecognitionConfiguration> = JSON.parse(env.RECOGNITION_CONFIGURATION_JSON),
    c = trustedRecognitionConfiguration(record, trust), signer = requireDedicatedManagedSigner(bytes32(env.RECOGNITION_SIGNER_PRIVATE_KEY), c.communities[0]!.body.deployment.rpcUrl),
    credentials = { host: text(env.ACRCLOUD_HOST, 256), accessKey: text(env.ACRCLOUD_ACCESS_KEY, 1024), accessSecret: text(env.ACRCLOUD_ACCESS_SECRET, 8192) },
    catalogToken = text(env.ACRCLOUD_CATALOG_TOKEN, 8192);
  insist(signer.address.toLowerCase() === c.profile.signer && credentials.accessKey.length > 0 && credentials.accessSecret.length > 0 && catalogToken.length > 0,
    "recognition_credentials_unavailable", 503);
  validateProviderBinding(c.binding, c.profile, credentials);
  insist(env.DB && typeof env.DB.withSession === "function" && env.ADMISSION_DB && typeof env.ADMISSION_DB.withSession === "function" &&
    env.JOBS && typeof env.JOBS.send === "function" && typeof env.MANAGED_PUBLISHING_CONFIGURATION_JSON === "string" &&
    env.MANAGED_PUBLISHING_CONFIGURATION_JSON.length <= 1024 * 1024, "recognition_installation_inputs_unavailable", 503);
  const publishing: ManagedPublishingConfiguration = managedPublishingConfiguration(JSON.parse(env.MANAGED_PUBLISHING_CONFIGURATION_JSON), trust),
    admissions = new ManagedPublishingJournal(env.ADMISSION_DB, publishing), communities = new Map<string, CanonicalCommunity>();
  for (const signed of c.communities) {
    requireDedicatedManagedSigner(bytes32(env.RECOGNITION_SIGNER_PRIVATE_KEY), signed.body.deployment.rpcUrl);
    const r = authenticatedManagedRegistration(signed, trust), d = r.deployment;
    const selected = publishing.registrations.find(value => value.body.admissionReference === r.admissionReference);
    if (selected) insist(canonical(selected) === canonical(signed), "recognition_admission_changed", 503);
    if (purpose === "effect") insist(selected, "recognition_admission_changed", 503);
    const admitted = async () => {
      await admissions.registration(r, purpose === "effect");
      insist((await admissions.observation(r, selectionFor(r).selectionDigest)).state === "attached", "recognition_admission_unattached", 503);
      if (purpose === "effect") requireOwnerGrantTime(r.grant);
    };
    const currentConfiguration = async () => {
      insist(env.RECOGNITION_CONFIGURATION_JSON === canonical(record) || canonical(JSON.parse(env.RECOGNITION_CONFIGURATION_JSON)) === canonical(record),
        "recognition_configuration_changed", 409);
      await admitted();
      const config = await readPinnedManagedCommunity(r);
      await admitted();
      insist(canonical(config.policies.recognition) === canonical(c.profile), "recognition_profile_changed", 403);
      return config;
    };
    communities.set(r.scope.communityId, canonicalCommunityClient({ signer, currentConfiguration,
      chain: { client: megaethReadClient(undefined, d.rpcUrl), posts: { ...d.posts, deploymentBlock: BigInt(d.posts.deploymentBlock) },
        ipfs: communityIpfsTransport(d) } }));
  }
  return sharedRecognitionRuntime({ db: env.DB, queue: env.JOBS, profile: c.profile, signer, credentials, binding: c.binding,
    catalogToken, communities, quotas: c.quotas, journal: c.journal,
    async cancellation() { throw new Error("recognition_cancellation_not_supported"); },
    async withdrawal() { throw new Error("recognition_withdrawal_not_supported"); },
  });
}
