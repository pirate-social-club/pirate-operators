import assert from "node:assert/strict";
import { parseTransaction } from "viem";
import { digest } from "../../packages/protocol/index.ts";
import { canonical } from "../../packages/community/common.ts";
import { nativeDigest } from "../../packages/community/native-business-binding.ts";
import { parseWeb2ProfileDocument } from "../../packages/community/web2-directory.ts";
import { maxWeb2DanceRetainedScopeBytes, verifyWeb2DanceRetainedScope } from "../../packages/community/web2-dance-retained-scope.ts";
import { maxWeb2DanceRewardBytes, readWeb2InstalledDanceRewards } from "../../packages/community/web2-dance-reward-attachment.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import {
  readDanceV2ParticipantBindings, verifyDanceV2BindingOriginal,
} from "../../services/dance-v2-participant-bindings.ts";
import { verifyObservedDanceGrant, type ObservedDanceGrant } from "../../services/web2-dance-observed-grant.ts";
import { capturedFee, record } from "../../services/publication-command-contract.ts";
import { parsePublicationRelease, publicationSelectionHash, publicationSelectionSource } from "../../services/publication-app-selection.ts";
import type { readObservedInstalledDanceGrants } from "../../services/web2-installed-dance-participants.ts";
import { hash, privateDirectory, syncDirectory, type OperationLease } from "./backend-state.ts";
import type { NativeGraph } from "./full-native-config.ts";
import type { Web2DancePublicationApproval } from "./web2-dance-publication-authority.ts";
import { verifyWeb2DanceRewardForApproval } from "./web2-dance-reward-installation.ts";
import type { Web2ChainAuthority } from "./web2-profile-authority.ts";
import type { NativeDanceRetainedScope } from "../../services/native-dance-retained-reference.ts";
import type { NativeDanceRetainedStore } from "./web2-native-dance-retained-store.ts";
import { readRetainedWeb2DanceBindPrepare } from "./web2-dance-bind-prepare.ts";
import {
  assertPublicDancePublisher, maxWeb2PublicDanceCustodyBytes, readPublicDanceCustody, type Web2PublicDanceServeCustody,
} from "./web2-public-dance-custody.ts";
import {
  readDanceActivationArtifact, readOptionalDanceActivationArtifact, retainDanceActivationArtifact,
} from "./web2-dance-retained-artifacts.ts";
import { danceActivationPaths } from "./web2-dance-retained-files.ts";

export { readDanceActivationArtifact, readOptionalDanceActivationArtifact, retainDanceActivationArtifact }
  from "./web2-dance-retained-artifacts.ts";

type Expansion = Web2DancePublicationApproval;
type Artifacts = Readonly<{ scope: string; reward: string }>;
type VerifyInput = {
  graph: NativeGraph;
  original: Web2NativeOriginal;
  approval: Pick<Expansion, "approvalSha256" | "selectionSha256" | "configuration" | "ownerWallet"> & {
    selection: Pick<Expansion["selection"], "active">;
  };
  publicationMount: string;
};
type VerifiedScope = Awaited<ReturnType<typeof verifyWeb2DanceRetainedScope>>;
export type Web2DanceActivationNomination = Readonly<{
  nativeOriginalSha256: string;
  releaseSelectionHash: Expansion["selection"]["active"];
}>;

export interface Web2DanceActivationOwner {
  /** The installed public owner selects the actual publisher Store and its
   * scoped reader under this same control lease, without opening a signer. */
  publicCustody?: { lease: OperationLease; operatorStore: object; retainedDance: NativeDanceRetainedStore };
  /** Resolves the independently approved scope envelope for this exact
   * original. The signed Rewards artifact is read from its existing mount. */
  approvedScope(input: Web2DanceActivationNomination): Promise<string | undefined>;
  /** Application owner reads the real primary D1 pair under its existing
   * lease/mount. A Store row or browser receipt must not stand in for this. */
  observedAppGrants(input: Web2DanceActivationNomination & {
    scopeSha256: string;
    grants: VerifiedScope["grants"];
  }): ReturnType<typeof readObservedInstalledDanceGrants>;
}

export function readOptionalDanceActivationScope(path: string) {
  return readOptionalDanceActivationArtifact(path, maxWeb2DanceRetainedScopeBytes);
}

export function readDanceActivationPublicationMount(path: string) {
  return readDanceActivationArtifact(path, 8192);
}

async function verify(input: VerifyInput, artifacts: Artifacts) {
  const { original, publicationMount, approval } = input;
  assert(Buffer.byteLength(artifacts.reward) <= maxWeb2DanceRewardBytes &&
    typeof artifacts.scope === "string", "web2_dance_activation_artifacts_changed");
  const rewards = await readWeb2InstalledDanceRewards({
    original, attachmentJson: artifacts.reward, publicationMountJson: publicationMount,
  });
  assert(rewards && rewards.attachment.approvalSha256 === approval.approvalSha256 &&
    rewards.attachment.selectionSha256 === approval.selectionSha256,
    "web2_dance_activation_rewards_unadmitted");
  const scope = await verifyWeb2DanceRetainedScope({
    raw: artifacts.scope, original, rewards, configuration: approval.configuration,
    releaseSelectionHash: approval.selection.active,
  });
  assert(scope.owner.wallet === approval.ownerWallet, "web2_dance_activation_owner_changed");
  return { scope, rewards };
}

/** Called by native boot after authenticating the exact expanded original.
 * An opted original can serve privately before the owner supplies the scope. */
export async function readWeb2DanceActivation(input: VerifyInput) {
  const paths = danceActivationPaths(input.graph);
  if (!paths) return undefined;
  await privateDirectory(paths.directory);
  const scope = await readOptionalDanceActivationScope(paths.scope);
  if (scope === undefined) return undefined;
  const reward = await readDanceActivationArtifact(paths.reward, maxWeb2DanceRewardBytes);
  const artifacts = { scope, reward };
  await verify(input, artifacts);
  return artifacts;
}

type RetainedPrepare = Awaited<ReturnType<typeof readRetainedWeb2DanceBindPrepare>>;

export function assertPublicDancePreparedBindings(prepared: RetainedPrepare["prepared"], grants: VerifiedScope["grants"]) {
  assert(prepared.plans.every((item, n) => {
    const { commandId, original } = grants[n]!;
    const plan = { ...original.plan, ownerEpoch: String(original.plan.ownerEpoch),
      configurationRevision: String(original.plan.configurationRevision) };
    return item.appGrantCommandId === commandId && canonical(item.plan) === canonical(plan) &&
      item.command.id === plan.commandId && item.command.data === parseTransaction(original.raw).data;
  }), "web2_public_dance_prepare_binding_changed");
}

type PreparedGrantEvidence = Pick<ObservedDanceGrant, "receipt"> & {
  command: Pick<ObservedDanceGrant["command"], "action" | "commandId" | "digest"> & {
    message: Pick<ObservedDanceGrant["command"]["message"], "purpose">;
  };
};
export function assertPublicDancePreparedGrants(
  prepared: RetainedPrepare["prepared"], evidence: readonly PreparedGrantEvidence[],
) {
  assert(evidence.length === prepared.plans.length && prepared.plans.every((item, n) => {
    const { command, receipt } = evidence[n]!;
    return command.action === "grant" && command.commandId === item.appGrantCommandId &&
      command.message.purpose === item.purpose && command.digest === item.grantId &&
      receipt.state === "recorded" && digest(receipt) === item.grantReceiptSha256;
  }), "web2_public_dance_prepare_grant_changed");
}

async function readPublicDanceStageOriginals(
  input: VerifyInput & { approval: Expansion }, directory: string, scopeRaw: string,
  { scope, rewards }: Awaited<ReturnType<typeof verify>>, requireStaged: boolean,
) {
  const { original, approval } = input;
  const active = approval.selection.active;
  assert(active && approval.publicGenesisHash, "web2_public_dance_approval_changed");
  const identity: NativeDanceRetainedScope = {
    chainId: 6343, communityId: rewards.source.domain.communityId, installationId: rewards.attachment.directoryInstallationId,
    releaseSha256: active, publisher: approval.configuration.publisher,
    verifier: rewards.source.domain.verifier, sourceHash: rewards.source.sourceHash,
  };
  const prepare = await readRetainedWeb2DanceBindPrepare({
    original, directory, source: rewards.source,
    approved: { releaseSha256: active, configurationSha256: rewards.attachment.configurationHash,
      ownerWallet: approval.ownerWallet, publisher: approval.configuration.publisher,
      configurationRevision: approval.configuration.configurationRevision },
  });
  assertPublicDancePreparedBindings(prepare.prepared, scope.grants);
  const custody = await readPublicDanceCustody({
    directory, original, genesisHash: approval.publicGenesisHash, requireStaged,
    expected: { approvalSha256: approval.approvalSha256, selectionSha256: approval.selectionSha256,
      rewardSha256: rewards.signedSha256, scopeSha256: hash(scopeRaw),
      prepareIntentSha256: prepare.intentSha256, prepareResultSha256: prepare.resultSha256, scope: identity },
  });
  return { prepare, custody };
}

type TrustedPublicDanceArtifacts = Readonly<{ reward: string; rewardSha256: string }> &
  ({ scope?: undefined; scopeSha256?: undefined; custody?: undefined } |
    { scope: string; scopeSha256: string; custody: Web2PublicDanceServeCustody });

/** Rewards alone permits Bind Prepare. Scope requires the retained Prepare
 * pair and the independently approved physical identity pinned by Stage. */
export async function readTrustedPublicDanceArtifacts(
  input: VerifyInput & { approval: Expansion },
): Promise<TrustedPublicDanceArtifacts | undefined> {
  const paths = danceActivationPaths(input.graph);
  if (!paths) return undefined;
  assert(paths.mode === "trusted-public", "web2_public_dance_reward_authority_required");
  await privateDirectory(paths.directory);
  const reward = await readOptionalDanceActivationArtifact(paths.reward, maxWeb2DanceRewardBytes);
  const scope = await readOptionalDanceActivationScope(paths.scope);
  if (reward === undefined) {
    assert(scope === undefined, "web2_dance_reward_attachment_required");
    return undefined;
  }
  const rewards = await verifyWeb2DanceRewardForApproval(input.original, reward, input.approval);
  if (scope === undefined) return { reward, rewardSha256: rewards.signedSha256 };
  const checked = await verify(input, { reward, scope });
  const { prepare, custody } = await readPublicDanceStageOriginals(input, paths.directory, scope, checked, true);
  await prepare.assertCurrent();
  await custody.assertCurrent();
  assert(await readOptionalDanceActivationScope(paths.scope) === scope &&
    await readDanceActivationArtifact(paths.reward, maxWeb2DanceRewardBytes) === reward,
    "web2_dance_activation_original_changed");
  return { reward, rewardSha256: rewards.signedSha256, scope, scopeSha256: hash(scope),
    custody: { record: custody.record, recordSha256: custody.recordSha256 } };
}

/** Host-only stage. This validates approved bytes and existing transactions.
 * It does not reach the browser, a signer, a sender or a restart API. */
export async function stageWeb2DanceActivation(input: VerifyInput & {
  chain: Web2ChainAuthority;
  approval: Expansion;
  owner: Web2DanceActivationOwner;
  lease?: OperationLease;
  assertCurrent(): Promise<void>;
}) {
  const paths = danceActivationPaths(input.graph);
  assert(paths && input.owner, "web2_dance_activation_unselected");
  const { owner, chain, original, approval, lease } = input;
  const publicOwner = owner.publicCustody;
  const operatorStore = publicOwner?.operatorStore, retainedDance = publicOwner?.retainedDance;
  if (paths.mode === "trusted-public") {
    assert(lease && publicOwner?.lease === lease && operatorStore && retainedDance, "native_dance_custody_unavailable");
  }
  const readOwner = owner.approvedScope.bind(owner), readGrants = owner.observedAppGrants.bind(owner);
  const selection = Object.freeze({ nativeOriginalSha256: nativeDigest(original), releaseSelectionHash: approval.selection.active });
  await privateDirectory(paths.directory);
  await input.assertCurrent();
  const selectedScope = await readOwner(selection);
  assert(typeof selectedScope === "string", "web2_dance_activation_approval_required");
  const artifacts = { scope: selectedScope, reward: await readDanceActivationArtifact(paths.reward, maxWeb2DanceRewardBytes) };
  const checked = await verify(input, artifacts);
  const { scope, rewards } = checked;
  const retainedBefore = await readOptionalDanceActivationScope(paths.scope);
  assert(retainedBefore === undefined || retainedBefore === artifacts.scope, "web2_dance_activation_original_changed");
  const publicOriginal = paths.mode === "trusted-public"
    ? await readPublicDanceStageOriginals(input, paths.directory, artifacts.scope, checked, retainedBefore !== undefined)
    : undefined;
  async function assertCurrent() {
    await input.assertCurrent();
    if (publicOriginal) {
      assert(lease && publicOwner && owner.publicCustody === publicOwner && publicOwner.lease === lease &&
        operatorStore && retainedDance && publicOwner.operatorStore === operatorStore &&
        publicOwner.retainedDance === retainedDance, "native_dance_custody_unavailable");
      await lease.assertHeld();
      await publicOriginal.prepare.assertCurrent();
      await publicOriginal.custody.assertCurrent();
      await assertPublicDancePublisher(retainedDance, operatorStore, publicOriginal.custody.record, lease);
      await lease.assertHeld();
    }
  }
  await assertCurrent();
  const release = parsePublicationRelease(approval.selection.entries.find(item =>
    publicationSelectionHash(item.release) === selection.releaseSelectionHash)?.release);
  const admittedSource = canonical(publicationSelectionSource(release)), admittedFee = canonical(release.fee);
  const scopeSha256 = hash(artifacts.scope);
  const request = { ...selection, scopeSha256, grants: scope.grants };
  const observed = structuredClone(await readGrants(structuredClone(request)));
  const participants = observed.pair;
  assert(participants.length === 2 && observed.evidence.length === 2 && participants.every((member, n) => {
    const plan = scope.grants[n]!.original.plan;
    const command = observed.evidence[n]!.command;
    return member.accountId === plan.accountId && member.wallet === plan.wallet && command.action === "grant" &&
      command.commandId === scope.grants[n]!.commandId && command.accountId === member.accountId &&
      command.message.learner === member.wallet && command.message.purpose === member.purpose &&
      canonical(command.source) === admittedSource &&
      canonical(capturedFee(record(JSON.parse(observed.evidence[n]!.acceptedJson)).fee)) === admittedFee &&
      command.digest === member.grantId &&
      member.purpose === (n === 0 ? "dance-verdict" : "dance-review-attribution");
  }), "web2_dance_activation_app_grants_changed");

  if (publicOriginal) assertPublicDancePreparedGrants(publicOriginal.prepare.prepared, observed.evidence);

  async function verifyPrivateOriginals() {
    await assertCurrent();
    assert(canonical(await readGrants(structuredClone(request))) === canonical(observed),
      "web2_dance_activation_app_grants_changed");
    await assertCurrent();
  }

  for (const proof of observed.evidence) {
    await verifyObservedDanceGrant(chain.client, proof);
    await assertCurrent();
  }
  for (const { original: binding } of scope.grants) {
    await verifyDanceV2BindingOriginal({ client: chain.client, source: rewards.source, original: binding });
    await assertCurrent();
  }
  await readDanceV2ParticipantBindings({
    client: chain.client, selected: rewards.source,
    profile: parseWeb2ProfileDocument(original.record.body.draft.enrollment.profile),
    config: approval.configuration, caller: approval.configuration.publisher, owner: scope.owner,
    clock: { now: chain.now, maxSafeBlockAgeSeconds: chain.maxSafeBlockAgeSeconds },
    participants, verifyPrivateOriginals, afterAwait: assertCurrent,
  });
  const selected = await readOwner(selection);
  assert(selected === artifacts.scope && await readDanceActivationArtifact(paths.reward, maxWeb2DanceRewardBytes) === artifacts.reward,
    "web2_dance_activation_approval_changed");
  const retained = await readOptionalDanceActivationScope(paths.scope);
  assert(retained === undefined || retained === artifacts.scope, "web2_dance_activation_original_changed");

  await verifyPrivateOriginals();
  if (publicOriginal) {
    const { custody } = publicOriginal;
    await retainDanceActivationArtifact(custody.stagedPath, custody.raw, maxWeb2PublicDanceCustodyBytes);
    await syncDirectory(paths.directory);
    await custody.assertCurrent(true);
    await verifyPrivateOriginals();
  }
  await retainDanceActivationArtifact(paths.scope, artifacts.scope, maxWeb2DanceRetainedScopeBytes);
  await syncDirectory(paths.directory);
  await assertCurrent();
  assert(await readOptionalDanceActivationScope(paths.scope) === artifacts.scope &&
    await readDanceActivationArtifact(paths.reward, maxWeb2DanceRewardBytes) === artifacts.reward,
    "web2_dance_activation_original_changed");
  await verifyPrivateOriginals();
  await publicOriginal?.custody.assertCurrent(true);
  return scopeSha256;
}
