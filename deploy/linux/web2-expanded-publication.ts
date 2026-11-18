import assert from "node:assert/strict";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { canonical, digest } from "../../packages/protocol/index.ts";
import { nativeDigest } from "../../packages/community/native-business-binding.ts";
import { web2ApplicationReleaseBody, web2NativeOriginal, type Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import { exact, record } from "../../services/publication-command-contract.ts";
import { parsePublicationRelease, publicationSelectionHash } from "../../services/publication-app-selection.ts";
import type { PublicationInstallationSpec } from "../../services/publication-installed-selection.ts";
import type { NativeGraph } from "./full-native-config.ts";
import { canonicalDigest, readPrivateJSON, verifyRecord, type SignedRecord } from "./installed-records.ts";
import { publishingAttachment } from "./web2-publishing-attachment.ts";
import { authenticateWeb2ExpandedEnrollment, type Web2ChainAuthority, type Web2InstallPlan } from "./web2-profile-authority.ts";
import { publicationMountFor, type Web2NativePublicationMount } from "./web2-publication-selection.ts";
import type { Web2RuntimeBindingInputs } from "./web2-runtime-binding.ts";
import type { Web2PublicationInstallationInputs } from "./web2-publication-installation.ts";
import type { FullRelease } from "./installed-release.ts";

/** Canonical Directory evidence retained with the initial publication mount. */
export interface Web2ExpandedPublicationProof {
  selection: PublicationInstallationSpec & {
    installationId: Hex;
    active: Hex;
    previous: null;
  };
  evidence: {
    schema: "pirate.local-native-expanded-directory-selection/1";
    nativeOriginalSha256: string;
    releaseArtifactDigest: string;
    releaseSourceDigest: string;
    hostInstallationId: string;
    directoryInstallationId: Hex;
    genesisHash: Hex;
    communityId: Hex;
    registrationHash: Hex;
    registrationBlockHash: Hex;
    configurationRevision: 2;
    configurationHash: Hex;
    configurationBlockHash: Hex;
    safeBlock: string;
    safeBlockHash: Hex;
    registry: Address;
    registryRuntimeHash: Hex;
    releaseSha256: Hex;
    selectionSha256: Hex;
  };
}

type BoundGraph = Omit<NativeGraph, "directoryRuntimeBinding">;

/** Native owner signs the actual read-only Registry result after verifying the
 * genuine retained Wizard plan. No credentials or raw transaction are copied. */
export interface Web2ExpandedPublicationApproval {
  schema: "pirate.web2-native-expanded-launch-approval/1";
  proof: Web2ExpandedPublicationProof;
  graphSha256: string;
  ownerWallet: Address;
  issuedAt: number;
  expiresAt: number;
}

function approvalPath(graph: BoundGraph) {
  assert(graph.publicationExpansion === "registry-revision-two/1" && graph.nativePublication && graph.fixtureTransport,
    "native_expanded_fixture_selection_required");
  return join(graph.nativePublication.directory, "expanded-launch.json");
}

export async function expandedPublicationApprovalExists(graph: BoundGraph) {
  if (graph.publicationExpansion === undefined) return false;
  try {
    await readPrivateJSON(approvalPath(graph));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Revalidate both the pinned original and the actual canonical revision at
 * every effect/boot. None of these reads advance the Directory or stored plan. */
export async function readApprovedExpandedPublication(input: {
  graph: NativeGraph;
  original: Web2NativeOriginal;
  chain: Web2ChainAuthority;
}) {
  const graph = structuredClone(input.graph), { chain } = input;
  const original = await web2NativeOriginal(JSON.stringify(input.original));
  const path = approvalPath(graph);
  const entry = await readPrivateJSON<SignedRecord<Web2ExpandedPublicationApproval>>(path);
  const approval = verifyRecord(entry, original.trust);
  exact(record(approval), ["schema", "proof", "graphSha256", "ownerWallet", "issuedAt", "expiresAt"]);
  const { proof, ownerWallet } = approval, { evidence, selection } = proof;
  const plan = original.record.body, draft = plan.draft;
  const now = () => chain.now() * 1000n;
  const live = () => Number.isSafeInteger(approval.issuedAt) && Number.isSafeInteger(approval.expiresAt) &&
    approval.issuedAt >= 0 && BigInt(approval.issuedAt) <= now() && now() < BigInt(approval.expiresAt);
  const mounted = publicationMountFor(original, selection, graph.nativePublication!);
  const release = parsePublicationRelease(selection.entries.find(item =>
    publicationSelectionHash(item.release) === selection.active)?.release);
  assert(approval.schema === "pirate.web2-native-expanded-launch-approval/1" && live() &&
    approval.graphSha256 === canonicalDigest(graph) && evidence.schema === "pirate.local-native-expanded-directory-selection/1" &&
    evidence.nativeOriginalSha256 === nativeDigest(original) && evidence.releaseArtifactDigest === plan.releaseArtifactDigest &&
    evidence.releaseSourceDigest === plan.releaseSourceDigest && evidence.hostInstallationId === plan.installationId &&
    evidence.directoryInstallationId === draft.enrollment.installationId &&
    evidence.communityId === draft.enrollment.communityId && evidence.registrationHash === plan.enrollment.transactionHash &&
    evidence.registrationBlockHash === plan.enrollment.registrationBlockHash && evidence.configurationRevision === 2 &&
    evidence.releaseSha256 === selection.active && evidence.selectionSha256 === mounted.mount.selectionSha256 &&
    evidence.selectionSha256 === digest(selection) && evidence.registry === release.source.registry &&
    evidence.registryRuntimeHash === release.source.registryRuntimeHash && release.source.registry === release.configuration.learningRecords &&
    canonical(JSON.parse(graph.directoryRuntimeBinding)) === canonical(draft.deployment),
    "native_expanded_signed_original_changed");
  const binding = graph.applicationBindings.find(item => item.name === "WEB2_PUBLISHING_ATTACHMENT_JSON");
  assert(binding?.text && plan.publishingAttachmentDigest, "native_expanded_retained_owner_grant_required");
  const attachment = publishingAttachment(JSON.parse(binding.text));
  assert(attachment.digest === plan.publishingAttachmentDigest &&
    attachment.selection.scope.hostInstallationId === plan.installationId &&
    attachment.selection.scope.ownerWallet === ownerWallet &&
    attachment.selection.scope.controller === draft.configuration.controller &&
    attachment.selection.scope.publisher === draft.configuration.publisher &&
    new Set([ownerWallet, draft.configuration.controller, draft.configuration.publisher]).size === 3 &&
    release.issuer === draft.configuration.controller && release.operator === draft.configuration.publisher,
    "native_expanded_wizard_roles_changed");
  const authority = await authenticateWeb2ExpandedEnrollment(chain, draft, {
    original: plan.enrollment, configuration: release.configuration, configurationHash: evidence.configurationHash,
    configurationBlockHash: evidence.configurationBlockHash, admittedSafeBlock: evidence.safeBlock,
    admittedSafeBlockHash: evidence.safeBlockHash, genesisHash: evidence.genesisHash,
    registryRuntimeHash: evidence.registryRuntimeHash,
  });
  const latest = await readPrivateJSON(path);
  assert(live() && canonicalDigest(latest) === canonicalDigest(entry), "native_expanded_approval_changed");
  return { configuration: release.configuration, selection, selectionSha256: mounted.mount.selectionSha256, authority,
    evidence, ownerWallet, approvalSha256: canonicalDigest(entry) };
}

export type Web2ExpandedBinding = Pick<Web2RuntimeBindingInputs, "policy" | "trust" | "lease" | "bootstrap" | "chain">;

export async function readExpandedPublicationBinding(binding: Web2ExpandedBinding) {
  const { lease, trust, chain } = binding;
  const policy = verifyRecord(binding.policy, trust);
  approvalPath(policy.graph);
  const policySha256 = canonicalDigest(binding.policy), bootstrapSha256 = canonicalDigest(binding.bootstrap);
  assert(lease.installationId === policy.installationId, "native_expanded_fixture_selection_required");
  await lease.assertHeld();
  const [bound, record] = await Promise.all([
    readPrivateJSON<{
      schema: string;
      intent: { schema: string; policyDigest: string; bootstrapDigest: string };
      release: SignedRecord<FullRelease>;
      applicationRelease: Web2NativeOriginal["release"];
    }>(join(policy.bindingDirectory, "web2-bound-runtime.json"), 16 * 1024 ** 2),
    readPrivateJSON<SignedRecord<Web2InstallPlan>>(join(policy.bindingDirectory, "web2-original.json")),
  ]);
  const release = verifyRecord(bound.release, trust);
  assert(bound.schema === "pirate.web2-bound-runtime/1" && bound.intent.schema === "pirate.web2-runtime-binding-intent/1" &&
    bound.intent.policyDigest === policySha256 && bound.intent.bootstrapDigest === bootstrapSha256 &&
    release.graph.installationId === lease.installationId && release.graph.durableScope === policy.graph.durableScope &&
    release.graph.publicationExpansion === policy.graph.publicationExpansion &&
    canonicalDigest(release.graph.nativePublication) === canonicalDigest(policy.graph.nativePublication) &&
    canonicalDigest(verifyRecord(bound.applicationRelease, trust)) === canonicalDigest(web2ApplicationReleaseBody(release)),
    "native_expanded_bound_runtime_changed");
  const original: Web2NativeOriginal = { schema: "pirate.web2-native-application-original/1", record,
    release: bound.applicationRelease, trust, durableScope: release.graph.durableScope };
  const approved = await readApprovedExpandedPublication({ graph: release.graph, original, chain });
  await lease.assertHeld();
  return { original, release, approved };
}

/** The fresh factory can offer these ports before the Wizard has a plan.
 * They become usable only after the exact original and its approval exist. */
export function createExpandedPublicationSelectionPorts(input: {
  binding: Web2ExpandedBinding;
  sign(body: Web2NativePublicationMount): Promise<SignedRecord<Web2NativePublicationMount>>;
  assertCurrent(): Promise<void>;
}): Web2PublicationInstallationInputs {
  const { lease, trust } = input.binding;
  approvalPath(verifyRecord(input.binding.policy, trust).graph);
  async function selected() {
    await input.assertCurrent();
    const actual = await readExpandedPublicationBinding(input.binding);
    await input.assertCurrent();
    await lease.assertHeld();
    return actual;
  }
  return {
    async selection(original) {
      const actual = await selected();
      assert(nativeDigest(original) === nativeDigest(actual.original), "native_expanded_selection_original_changed");
      return actual.approved.selection;
    },
    async signMount(body) {
      const actual = await selected();
      const expected = publicationMountFor(actual.original, actual.approved.selection, actual.release.graph.nativePublication!);
      assert(canonicalDigest(body) === canonicalDigest(expected), "native_expanded_signing_scope_changed");
      const signed = await input.sign(structuredClone(expected));
      const current = await selected();
      assert(nativeDigest(current.original) === nativeDigest(actual.original) &&
        current.approved.selectionSha256 === actual.approved.selectionSha256 &&
        canonicalDigest(verifyRecord(signed, trust)) === canonicalDigest(expected), "native_expanded_signing_scope_changed");
      return signed;
    },
  };
}
