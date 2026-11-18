import assert from "node:assert/strict";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { canonical, hashJson } from "../../packages/community/common.ts";
import { nativeDigest } from "../../packages/community/native-business-binding.ts";
import type { Web2CommunityConfig } from "../../packages/community/web2-config-manifest.ts";
import { web2ApplicationReleaseBody, web2NativeOriginal, type Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import { exact, record } from "../../services/publication-command-contract.ts";
import type { NativeGraph } from "./full-native-config.ts";
import type { FullRelease } from "./installed-release.ts";
import { canonicalDigest, readPrivateJSON, verifyRecord, type SignedRecord } from "./installed-records.ts";
import { publicIngressFrom, type PublicIngress } from "./public-ingress.ts";
import {
  authenticateWeb2ExpandedEnrollment, web2TargetDigest, type Web2ChainAuthority, type Web2EnrollmentEvidence,
  type Web2HostAdmission, type Web2InstallPlan,
} from "./web2-profile-authority.ts";
import type { Web2RuntimeBindingPolicy } from "./web2-runtime-binding.ts";
import { publishingAttachment } from "./web2-publishing-attachment.ts";

export const trustedRevisionTwo = "retained-registry-revision-two/1";
export const trustedRevisionTwoApprovalName = "web2-trusted-revision-two";
export const trustedRevisionTwoPolicyName = "web2-trusted-revision-two-policy";

type ModeGraph = Omit<NativeGraph, "directoryRuntimeBinding">;

export function assertTrustedRevisionTwoTarget(graph: ModeGraph, ingress: PublicIngress) {
  if (graph.publicationExpansion === trustedRevisionTwo)
    assert(ingress.tls.kind === "public-acme" && !graph.fixtureTransport && !graph.nativePublication,
      "trusted_revision_two_public_acme_required");
}

export function trustedRevisionTwoApprovalPath(graph: ModeGraph) {
  assert(graph.publicationExpansion === trustedRevisionTwo &&
    !graph.fixtureTransport && !graph.nativePublication && graph.stateRoots.configuration,
    "trusted_revision_two_public_graph_required");
  return join(graph.stateRoots.configuration, trustedRevisionTwoApprovalName + ".json");
}

export function web2OriginalStartIntent(plan: Web2InstallPlan) {
  return { planId: plan.planId, planDigest: canonicalDigest(plan),
    targetDigest: plan.targetDigest, installationId: plan.installationId };
}

export async function requireTrustedRevisionTwoStart(directory: string, plan: Web2InstallPlan) {
  const actual = await readPrivateJSON(join(directory, "web2-start-intent.json")).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("trusted_revision_two_original_start_required", { cause: error });
    throw error;
  });
  assert(canonicalDigest(actual) === canonicalDigest(web2OriginalStartIntent(plan)), "original_start_intent_changed");
}

/** Call with the actual controller inspection. It has already verified each
 * recorded container ID, image, configuration and owned storage mounts. */
export function requireTrustedRevisionTwoResources(expected: number, resources: readonly { actual: unknown }[]) {
  assert(expected > 0 && resources.length === expected && resources.every(resource => resource.actual != null),
    "trusted_revision_two_original_resources_required");
}

/** Preserve the original signed policy envelope as a separate immutable record.
 * The bound runtime pins its digest, and the existing signed admission pins its
 * target and expiry independently of any later host admission refresh. */
export async function readTrustedRevisionTwoPolicy(input: {
  graph: NativeGraph;
  original: Web2NativeOriginal;
  now: () => number;
  currentAdmissionFile?: string;
}) {
  trustedRevisionTwoApprovalPath(input.graph);
  const { graph, original, now, currentAdmissionFile } = input;
  const directory = graph.stateRoots.configuration!;
  const [signed, bound] = await Promise.all([
    readPrivateJSON<SignedRecord<Web2RuntimeBindingPolicy>>(join(directory, trustedRevisionTwoPolicyName + ".json"), 16 * 1024 ** 2),
    readPrivateJSON<{
      schema: string;
      intent: { schema: string; policyDigest: string; release: FullRelease; admission: Web2HostAdmission };
      release: SignedRecord<FullRelease>;
      applicationRelease: Web2NativeOriginal["release"];
      admission: SignedRecord<Web2HostAdmission>;
    }>(join(directory, "web2-bound-runtime.json"), 16 * 1024 ** 2),
  ]);
  const policy = verifyRecord(signed, original.trust);
  const release = verifyRecord(bound.release, original.trust);
  const admission = verifyRecord(bound.admission, original.trust);
  const { body: plan } = original.record;
  const ingress = publicIngressFrom(policy.ingress);
  assertTrustedRevisionTwoTarget(policy.graph, ingress);
  assert(policy.schema === "pirate.web2-runtime-binding-policy/1" &&
    bound.schema === "pirate.web2-bound-runtime/1" && bound.intent.schema === "pirate.web2-runtime-binding-intent/1" &&
    canonicalDigest(signed) === bound.intent.policyDigest &&
    canonicalDigest(bound.intent.release) === canonicalDigest(release) &&
    release.schema === "pirate.complete-linux-web2-release/1" &&
    release.artifactDigest === plan.releaseArtifactDigest && release.sourceDigest === plan.releaseSourceDigest &&
    canonicalDigest(release.graph) === canonicalDigest(graph) &&
    canonicalDigest(bound.applicationRelease) === canonicalDigest(original.release) &&
    canonicalDigest(bound.intent.admission) === canonicalDigest(admission) &&
    admission.schema === "pirate.linux-web2-host-admission/1" &&
    admission.installationId === plan.installationId && admission.targetDigest === plan.targetDigest &&
    admission.directoryInstallationId === plan.draft.enrollment.installationId &&
    admission.communityId === plan.draft.enrollment.communityId &&
    admission.draftDigest === canonicalDigest(plan.draft) && admission.releaseArtifactDigest === plan.releaseArtifactDigest &&
    admission.hostFingerprint === plan.hostFingerprint && admission.generation === policy.generation &&
    policy.generation <= plan.generation && policy.installationId === plan.installationId &&
    policy.origin === plan.draft.origin && ingress.origin === policy.origin &&
    policy.target.installationId === plan.installationId && policy.graph.installationId === plan.installationId &&
    policy.graph.publicationExpansion === trustedRevisionTwo && policy.bindingDirectory === directory &&
    policy.graph.stateRoots.configuration === directory &&
    policy.bootstrapArtifactDigest === plan.releaseArtifactDigest && policy.bootstrapSourceDigest === plan.releaseSourceDigest &&
    web2TargetDigest(policy.target, ingress, policy.nativeRuntimeDirectory) === plan.targetDigest &&
    (currentAdmissionFile === undefined || currentAdmissionFile === policy.currentAdmissionFile),
    "trusted_revision_two_binding_policy_changed");

  const time = now();
  assert(Number.isSafeInteger(policy.issuedAt) && Number.isSafeInteger(policy.expiresAt) &&
    policy.issuedAt <= admission.issuedAt && admission.issuedAt < admission.expiresAt &&
    admission.expiresAt === policy.expiresAt && Number.isSafeInteger(time) &&
    policy.issuedAt <= time && time < policy.expiresAt, "trusted_revision_two_binding_policy_expired");
  return policy;
}

/** The existing host issuer signs this exact selected transition after the
 * revision-one plan is retained. Timestamps are Unix milliseconds. */
export interface Web2TrustedRevisionTwoApproval {
  schema: "pirate.web2-trusted-revision-two-approval/1";
  nativeOriginalSha256: string;
  graphSha256: string;
  ownerWallet: Address;
  configuration: Web2CommunityConfig;
  configurationSha256: Hex;
  registrationTransactionHash: Hex;
  registrationBlock: string;
  registrationBlockHash: Hex;
  transitionTransactionHash: Hex;
  transitionBlock: string;
  transitionBlockHash: Hex;
  safeBlock: string;
  safeBlockHash: Hex;
  genesisHash: Hex;
  registry: Address;
  registryRuntimeHash: Hex;
  issuedAt: number;
  expiresAt: number;
}

interface ApprovedTrustedRevisionTwo {
  approval: Web2TrustedRevisionTwoApproval;
  approvalSha256: string;
  configuration: Web2CommunityConfig;
  authority: Web2EnrollmentEvidence;
  validFrom: number;
  expiresAt: number;
  selectionSha256?: never;
}

export function trustedRevisionTwoOriginalPublishing(graph: NativeGraph, original: Web2NativeOriginal) {
  const plan = original.record.body, { draft } = plan;
  const bindings = graph.applicationBindings.filter(item => item.name === "WEB2_PUBLISHING_ATTACHMENT_JSON");
  const binding = bindings[0]?.text;
  assert(bindings.length === 1 && binding && plan.publishingAttachmentDigest,
    "trusted_revision_two_original_owner_grant_required");
  const attachment = publishingAttachment(JSON.parse(binding));
  const { scope, grant } = attachment.selection;
  assert(attachment.digest === plan.publishingAttachmentDigest &&
    scope.enrollmentId === draft.enrollment.enrollmentId && scope.hostInstallationId === plan.installationId &&
    scope.installationId === draft.enrollment.installationId && scope.communityId === draft.enrollment.communityId &&
    scope.origin === draft.origin && scope.postsContract === draft.configuration.postsContract &&
    scope.deploymentDigest === hashJson(draft.deployment) &&
    scope.controller === draft.configuration.controller &&
    scope.publisher === draft.configuration.publisher &&
    new Set([scope.ownerWallet, scope.controller, scope.publisher]).size === 3,
    "trusted_revision_two_original_roles_changed");
  return { ownerWallet: scope.ownerWallet, grant };
}

interface TrustedRevisionTwoApprovalInput {
  graph: NativeGraph;
  original: Web2NativeOriginal;
  chain: Web2ChainAuthority;
  /** Host binding policy clock in Unix milliseconds. */
  now: () => number;
}

export async function prepareTrustedRevisionTwoApprovalCheck(input: TrustedRevisionTwoApprovalInput) {
  const graph = structuredClone(input.graph), { chain } = input;
  const path = trustedRevisionTwoApprovalPath(graph);
  const original = await web2NativeOriginal(JSON.stringify(input.original));
  const readPolicy = () => readTrustedRevisionTwoPolicy({ graph, original, now: input.now });
  const policy = await readPolicy();

  async function check(approval: Web2TrustedRevisionTwoApproval) {
    exact(record(approval), [
      "schema", "nativeOriginalSha256", "graphSha256", "ownerWallet", "configuration",
      "configurationSha256", "registrationTransactionHash", "registrationBlock", "registrationBlockHash",
      "transitionTransactionHash", "transitionBlock", "transitionBlockHash", "safeBlock", "safeBlockHash",
      "genesisHash", "registry", "registryRuntimeHash", "issuedAt", "expiresAt",
    ]);
    const plan = original.record.body, { draft, enrollment } = plan;
    const configuration = approval.configuration;
    const blockNumbers = [approval.registrationBlock, approval.transitionBlock, approval.safeBlock];
    const hashes = [approval.configurationSha256, approval.registrationTransactionHash, approval.registrationBlockHash,
      approval.transitionTransactionHash, approval.transitionBlockHash, approval.safeBlockHash, approval.genesisHash,
      approval.registryRuntimeHash];
    assert(approval.schema === "pirate.web2-trusted-revision-two-approval/1" &&
      approval.nativeOriginalSha256 === nativeDigest(original) &&
      approval.graphSha256 === canonicalDigest(graph) &&
      canonical(web2ApplicationReleaseBody({ ...original.release.body, graph })) === canonical(original.release.body) &&
      approval.registrationTransactionHash === enrollment.transactionHash &&
      approval.registrationBlock === enrollment.registrationBlock &&
      approval.registrationBlockHash === enrollment.registrationBlockHash &&
      hashes.every(hash => typeof hash === "string" && /^0x[0-9a-f]{64}$/.test(hash)) &&
      blockNumbers.every(block => typeof block === "string" && /^[1-9][0-9]{0,19}$/.test(block)) &&
      BigInt(approval.registrationBlock) < BigInt(approval.transitionBlock) &&
      BigInt(approval.transitionBlock) <= BigInt(approval.safeBlock) &&
      BigInt(approval.safeBlock) < (1n << 64n) &&
      approval.registrationTransactionHash !== approval.transitionTransactionHash &&
      configuration.configurationRevision === 2 && approval.configurationSha256 === hashJson(configuration) &&
      approval.registry === configuration.learningRecords && /^0x[0-9a-f]{40}$/.test(approval.registry) &&
      approval.registry !== "0x0000000000000000000000000000000000000000",
      "trusted_revision_two_signed_original_changed");
    const { ownerWallet, grant } = trustedRevisionTwoOriginalPublishing(graph, original);
    assert(approval.ownerWallet === ownerWallet, "trusted_revision_two_original_roles_changed");
    assert(Number.isSafeInteger(approval.issuedAt) && approval.issuedAt >= 0 &&
      Number.isSafeInteger(approval.expiresAt), "trusted_revision_two_invalid_window");
    assert(approval.issuedAt >= policy.issuedAt && approval.expiresAt <= policy.expiresAt,
      "trusted_revision_two_approval_outside_policy");
    await requireTrustedRevisionTwoStart(graph.stateRoots.configuration!, plan);
    const validFrom = Math.max(Math.ceil(approval.issuedAt / 1000), grant.validFrom);
    const expiresAt = Math.min(Math.floor(approval.expiresAt / 1000), grant.expiresAt);
    const live = () => BigInt(validFrom) <= chain.now() && chain.now() < BigInt(expiresAt);
    assert(live(), "trusted_revision_two_approval_expired");

    const authority = await authenticateWeb2ExpandedEnrollment(chain, draft, {
      original: enrollment, configuration, configurationHash: approval.transitionTransactionHash,
      configurationBlock: approval.transitionBlock, configurationBlockHash: approval.transitionBlockHash,
      admittedSafeBlock: approval.safeBlock, admittedSafeBlockHash: approval.safeBlockHash,
      genesisHash: approval.genesisHash, registryRuntimeHash: approval.registryRuntimeHash,
    });
    await requireTrustedRevisionTwoStart(graph.stateRoots.configuration!, plan);
    assert(canonicalDigest(await readPolicy()) === canonicalDigest(policy), "trusted_revision_two_binding_policy_changed");
    assert(live(), "trusted_revision_two_approval_expired");
    return { authority, validFrom, expiresAt, live };
  }
  return { policy, path, trust: original.trust, check };
}

export async function readApprovedTrustedRevisionTwo(input: TrustedRevisionTwoApprovalInput): Promise<ApprovedTrustedRevisionTwo> {
  const { path, trust, check } = await prepareTrustedRevisionTwoApprovalCheck(input);
  const signed = await readPrivateJSON<SignedRecord<Web2TrustedRevisionTwoApproval>>(path);
  exact(record(signed), ["schema", "keyId", "body", "signature"]);
  const approval = verifyRecord(signed, trust);
  const { authority, validFrom, expiresAt, live } = await check(approval);
  const approvalSha256 = canonicalDigest(signed);
  assert(live() && canonicalDigest(await readPrivateJSON(path)) === approvalSha256 && live(),
    "trusted_revision_two_approval_changed");
  return { approval, approvalSha256, configuration: approval.configuration, authority, validFrom, expiresAt };
}
