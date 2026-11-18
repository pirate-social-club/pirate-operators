import assert from "node:assert/strict";
import { dirname, isAbsolute, join, relative } from "node:path";
import { hashJson } from "../../packages/community/common.ts";
import { nativeDigest } from "../../packages/community/native-business-binding.ts";
import {
  assertWeb2DanceRewardConfiguration, maxWeb2DanceRewardBytes, verifyWeb2DanceRewardAttachment,
  web2DanceRewardBinding, web2DanceRewardFile, web2DanceRewardIntent, web2DanceRewardSourceDocument,
  type Web2DanceRewardAttachment,
} from "../../packages/community/web2-dance-reward-attachment.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import { parseWeb2ProfileDocument } from "../../packages/community/web2-directory.ts";
import { verifyDancePublicationSource, type DancePublicationSourceV2 } from "../../services/dance-publication-source.ts";
import { parsePublicationRelease, publicationSelectionHash } from "../../services/publication-app-selection.ts";
import { privateFile, syncDirectory, type OperationLease } from "./backend-state.ts";
import type { NativeGraph } from "./full-native-config.ts";
import { canonicalDigest, immutableRecord, verifyRecord, type SignedRecord } from "./installed-records.ts";
import type { InstalledTarget } from "./local-target-controller.ts";
import { web2DanceAuthorityMode } from "./web2-dance-retained-files.ts";
import {
  readWeb2DancePublicationAuthority, sameWeb2DancePublicationAuthority, type Web2DancePublicationApproval,
} from "./web2-dance-publication-authority.ts";
import {
  readDanceActivationArtifact, readOptionalDanceActivationArtifact, retainDanceActivationArtifact,
} from "./web2-dance-retained-artifacts.ts";
import type { Web2ChainAuthority } from "./web2-profile-authority.ts";

type Bootstrap = Omit<NativeGraph, "directoryRuntimeBinding">;
type Approved = Web2DancePublicationApproval;
export type Web2DanceRewardAuthority = {
  source: DancePublicationSourceV2;
  owner: Parameters<typeof verifyDancePublicationSource>[0]["owner"];
};
const contains = (root: string, path: string) => {
  const rest = relative(root, path);
  return !isAbsolute(rest) && rest !== ".." && !rest.startsWith("../");
};

export function web2DanceRewardPath(graph: Bootstrap) {
  if (!graph.danceRewardIntent) return undefined;
  const mount = graph.applicationBindings.find(binding => binding.name === web2DanceRewardBinding);
  assert(mount?.file && isAbsolute(mount.file), "web2_dance_reward_mount_required");
  return mount.file;
}

/** The signed target already controls app mounts. Select a single dedicated
 * read-only directory for late approval bytes under this same target. */
export function web2DanceRewardMount(graph: Bootstrap, target: InstalledTarget, bound: boolean) {
  const dir = join(target.stateRoot, "dance-rewards"), file = join(dir, web2DanceRewardFile + ".json");
  const reserved = [web2DanceRewardBinding, "WEB2_DANCE_REWARD_ATTACHMENT_SHA256"];
  const appBindings = graph.applicationBindings.filter(binding => reserved.includes(binding.name));
  const other = [...graph.secretBindings, ...graph.actors.flatMap(actor => actor.bindings)];
  assert(!other.some(binding => reserved.includes(binding.name)), "web2_dance_reward_binding_alias");
  if (!Object.hasOwn(graph, "danceRewardIntent")) {
    assert(appBindings.length === 0, "web2_dance_reward_unselected_mount");
    return undefined;
  }
  web2DanceRewardIntent(graph.danceRewardIntent);
  const legacy = ["REWARDS_PROFILE_JSON", "REWARDS_RESULT_SOURCE_JSON", "REWARDS_RESULT_SUCCESSORS_JSON",
    "DANCE_REWARD_SOURCE_JSON", "DANCE_REWARD_SOURCE_SELECTION_HASH"];
  web2DanceAuthorityMode(graph);
  assert(![...graph.applicationBindings, ...other].some(binding => legacy.includes(binding.name)),
    "web2_dance_reward_selection_unavailable");
  assert(bound ? appBindings.length === 1 && appBindings[0]!.name === web2DanceRewardBinding &&
    appBindings[0]!.file === file && Object.keys(appBindings[0]!).sort().join(",") === "file,name" : appBindings.length === 0,
    "web2_dance_reward_binding_changed");
  const owner = target.containers.filter(row => row.key === "application");
  assert(owner.length === 1 && owner[0]!.mounts.filter(row => row.source === dir && row.target === dir && row.readOnly).length === 1 &&
    target.allowedReadOnlyRoots.includes(dir) && !contains(graph.releaseRoot, dir), "web2_dance_reward_read_only_mount_required");
  for (const container of target.containers) for (const mount of container.mounts) {
    if (container === owner[0] && mount.source === dir && mount.target === dir && mount.readOnly) continue;
    assert(![mount.source, mount.target].some(path => contains(path, dir) || contains(dir, path)),
      "web2_dance_reward_alternate_mount_refused");
  }
  const otherFiles = [...graph.secretBindings.map(binding => binding.path),
    ...[...graph.applicationBindings.filter(binding => binding.name !== web2DanceRewardBinding),
      ...graph.actors.flatMap(actor => actor.bindings)].flatMap(binding => binding.file ? [binding.file] : [])];
  assert(otherFiles.every(path => !contains(dir, path)), "web2_dance_reward_binding_alias");
  return file;
}

function assertPublicationSource(approved: Approved, source: DancePublicationSourceV2) {
  const entry = approved.selection.entries[0];
  assert(entry && approved.selection.entries.length === 1, "web2_dance_reward_publication_source_changed");
  const release = parsePublicationRelease(entry.release);
  assert(publicationSelectionHash(release) === approved.selection.active, "web2_dance_reward_publication_source_changed");
  for (const purpose of ["dance-verdict", "dance-review-attribution"] as const) {
    const policy = release.policies[purpose];
    const policyHash = purpose === "dance-verdict" ? source.pin.learnerConsentPolicyHash : source.pin.reviewerConsentPolicyHash;
    assert(policy && policy.target === source.domain.verifier && policy.runtimeHash === source.pin.runtimeCodeHash &&
      policy.policyHash === policyHash, "web2_dance_reward_publication_source_changed");
  }
  assert(release.source.registry === source.pin.consentRegistry && release.source.registryRuntimeHash === source.pin.consentRegistryRuntimeHash,
    "web2_dance_reward_publication_source_changed");
}

export async function verifyWeb2DanceRewardForApproval(
  original: Web2NativeOriginal, raw: string, approved: Approved,
) {
  const selected = await verifyWeb2DanceRewardAttachment(original, raw);
  assert(selected && selected.attachment.approvalSha256 === approved.approvalSha256 &&
    selected.attachment.selectionSha256 === approved.selectionSha256, "web2_dance_reward_approved_original_changed");
  assertWeb2DanceRewardConfiguration(selected, approved.configuration);
  assertPublicationSource(approved, selected.source);
  return selected;
}

export async function readWeb2DanceRewardApproval(graph: NativeGraph, original: Web2NativeOriginal, approved: Approved) {
  const file = web2DanceRewardPath(graph);
  if (!file) {
    assert(original.record.body.danceRewardIntentSha256 === undefined, "web2_dance_reward_attachment_required");
    return undefined;
  }
  if (web2DanceAuthorityMode(graph) === "trusted-public") {
    const raw = await readDanceActivationArtifact(file, maxWeb2DanceRewardBytes);
    return (await verifyWeb2DanceRewardForApproval(original, raw, approved)).signedSha256;
  }
  const handle = await privateFile(file, maxWeb2DanceRewardBytes);
  const raw = await handle.readFile("utf8").finally(() => handle.close());
  return (await verifyWeb2DanceRewardForApproval(original, raw, approved)).signedSha256;
}

type RetainReward = {
  graph: NativeGraph;
  original: Web2NativeOriginal;
  approved: Approved;
  dance: Web2DanceRewardAuthority;
  chain: Web2ChainAuthority;
  lease: OperationLease;
  assertCurrent(): Promise<void>;
  sign(body: Web2DanceRewardAttachment): Promise<SignedRecord<Web2DanceRewardAttachment>>;
};

export async function retainWeb2DanceRewardApproval(input: RetainReward) {
  assert(web2DanceAuthorityMode(input.graph) === "fixture", "web2_dance_reward_fixture_authority_required");
  return retainSelectedWeb2DanceReward(input);
}

/** Invoke only from the separately admitted public attachment owner. The
 * original controller/Directory approval and signed consent companion already
 * exist. No app grants, activated Dance scope or backend defaults are needed. */
export async function retainTrustedWeb2DanceRewardApproval(
  input: Omit<RetainReward, "approved"> & { target: InstalledTarget; now: () => number },
) {
  assert(web2DanceAuthorityMode(input.graph) === "trusted-public" && web2DanceRewardMount(input.graph, input.target, true),
    "web2_public_dance_reward_authority_required");
  await input.assertCurrent();
  const authority = await readWeb2DancePublicationAuthority(input);
  assert(authority.mode === "trusted-public", "web2_public_dance_reward_authority_required");
  return retainSelectedWeb2DanceReward({
    ...input, approved: authority.approval,
    async assertCurrent() {
      await input.assertCurrent();
      assert(sameWeb2DancePublicationAuthority(authority, await readWeb2DancePublicationAuthority(input)),
        "web2_public_dance_approval_changed");
      await input.lease.assertHeld();
    },
  });
}

async function retainSelectedWeb2DanceReward(input: RetainReward) {
  const { graph, original, approved, lease, chain, assertCurrent } = input;
  const path = web2DanceRewardPath(graph);
  assert(path && lease.installationId === graph.installationId, "web2_dance_reward_selection_unavailable");
  const publicMode = web2DanceAuthorityMode(graph) === "trusted-public";
  const intent = web2DanceRewardIntent(graph.danceRewardIntent);
  const { source, owner } = structuredClone(input.dance);
  const draft = original.record.body.draft;
  const config = approved.configuration;
  assert(owner.wallet === approved.ownerWallet && original.record.body.danceRewardIntentSha256 === hashJson(intent),
    "web2_dance_reward_approved_original_changed");
  assertPublicationSource(approved, source);
  await assertCurrent();
  const verified = await verifyDancePublicationSource({ client: chain.client, selected: source,
    profile: parseWeb2ProfileDocument(draft.enrollment.profile), config, caller: config.publisher,
    owner, clock: chain, afterAwait: assertCurrent });
  const body: Web2DanceRewardAttachment = { schema: "pirate.web2-installed-dance-rewards/1", hostInstallationId: lease.installationId,
    directoryInstallationId: draft.enrollment.installationId, nativeOriginalSha256: nativeDigest(original),
    approvalSha256: approved.approvalSha256, selectionSha256: approved.selectionSha256, deploymentHash: hashJson(draft.deployment),
    configurationHash: hashJson(config), offerId: intent.offerId, profile: intent.profile, source: web2DanceRewardSourceDocument(verified.source) };
  await verified.finish();
  if (publicMode) {
    const raw = await readOptionalDanceActivationArtifact(path, maxWeb2DanceRewardBytes);
    if (raw !== undefined) {
      const existing: SignedRecord<Web2DanceRewardAttachment> = JSON.parse(raw);
      const selected = await verifyWeb2DanceRewardForApproval(original, raw, approved);
      assert(canonicalDigest(verifyRecord(existing, original.trust)) === canonicalDigest(body) &&
        selected.signedSha256 === nativeDigest(existing),
        "web2_dance_reward_retained_original_changed");
      await verified.finish();
      assert(await readDanceActivationArtifact(path, maxWeb2DanceRewardBytes) === raw,
        "web2_dance_reward_retained_original_changed");
      return;
    }
    await verified.finish();
  }
  const signed = await input.sign(body);
  const selected = await verifyWeb2DanceRewardAttachment(original, JSON.stringify(signed));
  assert(selected && canonicalDigest(verifyRecord(signed, original.trust)) === canonicalDigest(body), "web2_dance_reward_signer_changed");
  await verified.finish();
  if (publicMode) {
    await lease.assertHeld();
    const bytes = JSON.stringify(signed) + "\n";
    await retainDanceActivationArtifact(path, bytes, maxWeb2DanceRewardBytes);
    await syncDirectory(dirname(path));
    assert(await readDanceActivationArtifact(path, maxWeb2DanceRewardBytes) === bytes,
      "web2_dance_reward_retained_original_changed");
  } else await immutableRecord(dirname(path), web2DanceRewardFile, signed, lease);
  assert(await readWeb2DanceRewardApproval(graph, original, approved) === selected.signedSha256, "web2_dance_reward_retained_original_changed");
  await verified.finish();
}
