import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { canonical } from "../../packages/community/common.ts";
import { nativeDigest } from "../../packages/community/native-business-binding.ts";
import { parseWeb2ProfileDocument } from "../../packages/community/web2-directory.ts";
import { maxWeb2DanceRetainedScopeBytes, verifyWeb2DanceRetainedScope } from "../../packages/community/web2-dance-retained-scope.ts";
import { maxWeb2DanceRewardBytes, readWeb2InstalledDanceRewards } from "../../packages/community/web2-dance-reward-attachment.ts";
import type { Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import {
  readDanceV2ParticipantBindings, verifyDanceV2BindingOriginal,
} from "../../services/dance-v2-participant-bindings.ts";
import { verifyObservedDanceGrant } from "../../services/web2-dance-observed-grant.ts";
import { capturedFee, record } from "../../services/publication-command-contract.ts";
import { parsePublicationRelease, publicationSelectionHash, publicationSelectionSource } from "../../services/publication-app-selection.ts";
import type { readObservedInstalledDanceGrants } from "../../services/web2-installed-dance-participants.ts";
import { hash, privateDirectory, privateFile, syncDirectory } from "./backend-state.ts";
import type { NativeGraph } from "./full-native-config.ts";
import type { readApprovedExpandedPublication } from "./web2-expanded-publication.ts";
import type { Web2ChainAuthority } from "./web2-profile-authority.ts";
import { danceActivationPaths } from "./web2-dance-retained-files.ts";

type Expansion = Awaited<ReturnType<typeof readApprovedExpandedPublication>>;
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

async function readPhysical(path: string, maxBytes: number) {
  const file = await privateFile(path, maxBytes);
  try {
    const before = await file.stat({ bigint: true });
    // Read at most the admitted size plus one byte, even if a writer grows it.
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    assert(length <= maxBytes && BigInt(length) === before.size && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
      named.dev === after.dev && named.ino === after.ino && named.nlink === 1n &&
      named.size === after.size && named.mtimeNs === after.mtimeNs && named.ctimeNs === after.ctimeNs,
      "web2_dance_activation_file_changed");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}

export async function readOptionalDanceActivationScope(path: string) {
  try {
    // Only an absent directory entry disables activation. A dangling symlink,
    // raced rename or failed read of a present entry must refuse.
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return readPhysical(path, maxWeb2DanceRetainedScopeBytes);
}

export function readDanceActivationPublicationMount(path: string) {
  return readPhysical(path, 8192);
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
  const reward = await readPhysical(paths.reward, maxWeb2DanceRewardBytes);
  const artifacts = { scope, reward };
  await verify(input, artifacts);
  return artifacts;
}

async function retainBytes(path: string, value: string, bound: number) {
  assert(Buffer.byteLength(value) <= bound, "web2_dance_activation_artifact_too_large");
  let file;
  try {
    file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    assert(await readPhysical(path, bound) === value, "web2_dance_activation_original_changed");
    const prior = await privateFile(path, bound);
    try { await prior.sync(); } finally { await prior.close(); }
    return;
  }
  try {
    await file.writeFile(value, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Host-only stage. This validates approved bytes and existing transactions.
 * It does not reach the browser, a signer, a sender or a restart API. */
export async function stageWeb2DanceActivation(input: VerifyInput & {
  chain: Web2ChainAuthority;
  approval: Expansion;
  owner: Web2DanceActivationOwner;
  assertCurrent(): Promise<void>;
}) {
  const paths = danceActivationPaths(input.graph);
  assert(paths && input.owner, "web2_dance_activation_unselected");
  const { owner, chain, original, approval, assertCurrent } = input;
  const readOwner = owner.approvedScope.bind(owner), readGrants = owner.observedAppGrants.bind(owner);
  const selection = Object.freeze({ nativeOriginalSha256: nativeDigest(original), releaseSelectionHash: approval.selection.active });
  await privateDirectory(paths.directory);
  await assertCurrent();
  const selectedScope = await readOwner(selection);
  assert(typeof selectedScope === "string", "web2_dance_activation_approval_required");
  const artifacts = { scope: selectedScope, reward: await readPhysical(paths.reward, maxWeb2DanceRewardBytes) };
  const { scope, rewards } = await verify(input, artifacts);
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
  assert(selected === artifacts.scope && await readPhysical(paths.reward, maxWeb2DanceRewardBytes) === artifacts.reward,
    "web2_dance_activation_approval_changed");
  const retained = await readOptionalDanceActivationScope(paths.scope);
  assert(retained === undefined || retained === artifacts.scope, "web2_dance_activation_original_changed");

  // The prior Rewards producer owns its original bytes. The only newly
  // staged file is this exact approved scope.
  await verifyPrivateOriginals();
  await retainBytes(paths.scope, artifacts.scope, maxWeb2DanceRetainedScopeBytes);
  await syncDirectory(paths.directory);
  await assertCurrent();
  assert(await readOptionalDanceActivationScope(paths.scope) === artifacts.scope &&
    await readPhysical(paths.reward, maxWeb2DanceRewardBytes) === artifacts.reward,
    "web2_dance_activation_original_changed");
  await verifyPrivateOriginals();
  return scopeSha256;
}
