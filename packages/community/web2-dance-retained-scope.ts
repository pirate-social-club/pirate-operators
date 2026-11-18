import { getSerializedTransactionType, keccak256, parseTransaction, recoverTransactionAddress,
  type Address, type Hex, type TransactionSerializedLegacy } from "viem";
import { canonical, exact, hashText, insist, integer, object, text } from "./common.ts";
import { nativeDigest, verifyNativeRecord } from "./native-business-binding.ts";
import type { Web2CommunityConfig } from "./web2-config-manifest.ts";
import {
  assertWeb2DanceRewardConfiguration, type readWeb2InstalledDanceRewards,
} from "./web2-dance-reward-attachment.ts";
import type { Web2NativeOriginal } from "./web2-native-business-binding.ts";
import { consentAddress, consentDigest, consentUint64 } from "../protocol/publication-consent.ts";
import type { SignedRecord } from "../../deploy/linux/installed-records.ts";
import type { DanceV2BindingOriginal, DanceV2PrivateParticipant } from "../../services/dance-v2-participant-bindings.ts";
import type { InstalledDanceOwnerScope } from "../../services/web2-installed-dance-ordinary.ts";

type Selection = NonNullable<Awaited<ReturnType<typeof readWeb2InstalledDanceRewards>>>;
type Purpose = DanceV2PrivateParticipant["purpose"];
type Plan = DanceV2BindingOriginal["plan"];
export type Web2DanceRetainedPeer<P extends Purpose = Purpose> = {
  purpose: P;
  appGrantCommandId: Hex;
  binding: Omit<DanceV2BindingOriginal, "plan"> & {
    plan: Omit<Plan, "ownerEpoch" | "configurationRevision"> & {
      ownerEpoch: string;
      configurationRevision: string;
    };
  };
};

export interface Web2DanceRetainedScopeDocument {
  schema: "pirate.web2-dance-retained-owner-scope/1";
  nativeOriginalSha256: string;
  hostInstallationId: string;
  directoryInstallationId: Hex;
  selectionSha256: Hex;
  releaseSelectionHash: Hex;
  configurationHash: Hex;
  attachmentDigest: Hex;
  sourceHash: Hex;
  owner: { epoch: string; wallet: Address };
  policy: InstalledDanceOwnerScope["policy"];
  grants: readonly [
    Web2DanceRetainedPeer<"dance-verdict">,
    Web2DanceRetainedPeer<"dance-review-attribution">,
  ];
}

export const maxWeb2DanceRetainedScopeBytes = 1_048_576;
const maxPolicyBytes = 65_536;
const maxBindBytes = 4096;

export function web2DanceRetainedPeer<P extends Purpose>(
  purpose: P, appGrantCommandId: Hex, original: DanceV2BindingOriginal,
): Web2DanceRetainedPeer<P> {
  const { plan, hash, raw, nonce } = original;
  return { purpose, appGrantCommandId, binding: { hash, raw, nonce, plan: {
    ...plan, ownerEpoch: String(plan.ownerEpoch), configurationRevision: String(plan.configurationRevision),
  } } };
}

async function decodePeer(
  value: unknown, purpose: Purpose, source: Selection["source"], publisher: Address, epoch: bigint, revision: bigint,
) {
  const peer = object(value);
  exact(peer, ["purpose", "appGrantCommandId", "binding"]);
  insist(peer.purpose === purpose, "web2_dance_retained_role_changed", 503);
  const commandId = consentDigest(peer.appGrantCommandId);
  const binding = object(peer.binding);
  exact(binding, ["plan", "hash", "raw", "nonce"]);
  const row = object(binding.plan);
  exact(row, ["accountId", "wallet", "publisher", "sourceHash", "ownerEpoch", "configurationRevision", "commandId"]);
  const plan: Plan = {
    accountId: text(row.accountId, 36),
    wallet: consentAddress(row.wallet),
    publisher: consentAddress(row.publisher),
    sourceHash: consentDigest(row.sourceHash),
    ownerEpoch: consentUint64(row.ownerEpoch),
    configurationRevision: consentUint64(row.configurationRevision),
    commandId: consentDigest(row.commandId),
  };
  insist(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(plan.accountId) &&
    plan.publisher === publisher && plan.sourceHash === source.sourceHash && plan.ownerEpoch === epoch &&
    plan.configurationRevision === revision, "web2_dance_retained_binding_scope_changed", 503);
  const raw = binding.raw, hash = consentDigest(binding.hash);
  insist(typeof raw === "string" && raw.length <= 2 + 2 * maxBindBytes &&
    /^0x(?:[a-f0-9]{2})+(?![\s\S])/.test(raw) && keccak256(raw as Hex) === hash,
    "web2_dance_retained_binding_bytes_changed", 503);
  const nonce = integer(binding.nonce, 0, Number.MAX_SAFE_INTEGER);
  insist(getSerializedTransactionType(raw as Hex) === "legacy", "web2_dance_retained_binding_bytes_changed", 503);
  const serialized = raw as TransactionSerializedLegacy, transaction = parseTransaction(serialized);
  const sender = await recoverTransactionAddress({ serializedTransaction: serialized });
  insist(transaction.chainId === Number(source.domain.chainId) && transaction.nonce === nonce &&
    (transaction.value ?? 0n) === 0n && transaction.to?.toLowerCase() === source.domain.verifier &&
    sender.toLowerCase() === publisher, "web2_dance_retained_binding_scope_changed", 503);
  return { commandId, original: { plan, raw: serialized, hash, nonce } } satisfies InstalledDanceOwnerScope["grants"][number];
}

/** Original, Rewards and release come from the owning installed readers.
 * The returned pair still needs the ordinary Workerd grant and binding fences. */
export async function verifyWeb2DanceRetainedScope(input: {
  raw: string;
  original: Web2NativeOriginal;
  rewards: Selection;
  configuration: Web2CommunityConfig;
  releaseSelectionHash: Hex;
}): Promise<Omit<InstalledDanceOwnerScope, "actionOriginals" | "assertCurrent">> {
  const { raw, original, rewards, configuration, releaseSelectionHash } = input;
  insist(raw.length <= maxWeb2DanceRetainedScopeBytes &&
    new TextEncoder().encode(raw).byteLength <= maxWeb2DanceRetainedScopeBytes,
    "web2_dance_retained_scope_too_large", 503);
  const signed: SignedRecord<unknown> = JSON.parse(raw);
  insist(canonical(signed) === raw, "web2_dance_retained_scope_not_canonical", 503);
  await verifyNativeRecord(signed, original.trust);
  const body = object(signed.body);
  exact(body, ["schema", "nativeOriginalSha256", "hostInstallationId", "directoryInstallationId",
    "selectionSha256", "releaseSelectionHash", "configurationHash", "attachmentDigest", "sourceHash", "owner", "policy", "grants"]);
  const { attachment, source } = rewards;
  assertWeb2DanceRewardConfiguration(rewards, configuration);
  insist(body.schema === "pirate.web2-dance-retained-owner-scope/1" &&
    body.nativeOriginalSha256 === nativeDigest(original) &&
    body.nativeOriginalSha256 === attachment.nativeOriginalSha256 &&
    body.hostInstallationId === original.record.body.installationId &&
    body.hostInstallationId === attachment.hostInstallationId &&
    body.directoryInstallationId === attachment.directoryInstallationId &&
    body.selectionSha256 === attachment.selectionSha256 &&
    body.releaseSelectionHash === consentDigest(releaseSelectionHash) &&
    body.configurationHash === attachment.configurationHash &&
    body.attachmentDigest === "0x" + rewards.signedSha256 &&
    body.sourceHash === source.sourceHash && source.version === 2,
    "web2_dance_retained_scope_changed", 503);

  const principal = object(body.owner);
  exact(principal, ["epoch", "wallet"]);
  const owner = { epoch: consentUint64(principal.epoch), wallet: consentAddress(principal.wallet) };
  insist(owner.epoch > 0n, "web2_dance_retained_owner_invalid", 503);
  const value = object(body.policy);
  exact(value, ["rules", "terms", "rubric", "media", "consentVersion", "captureTtlMs"]);
  const policy = {
    rules: text(value.rules, maxPolicyBytes), terms: text(value.terms, maxPolicyBytes),
    rubric: text(value.rubric, maxPolicyBytes), media: text(value.media, maxPolicyBytes),
    consentVersion: text(value.consentVersion, 128),
    captureTtlMs: integer(value.captureTtlMs, 1, 3_600_000),
  };
  const { pin } = source, encoder = new TextEncoder();
  const documents = [[policy.rules, pin.rulesSha256], [policy.terms, pin.termsSha256],
    [policy.rubric, pin.rubricSha256], [policy.media, pin.mediaPolicySha256]] as const;
  insist(policy.consentVersion.length > 0 && documents.every(([bytes, pin]) =>
    encoder.encode(bytes).byteLength <= maxPolicyBytes && hashText(bytes) === pin),
    "web2_dance_retained_policy_bytes_changed", 503);

  const pair = body.grants;
  insist(Array.isArray(pair) && pair.length === 2, "web2_dance_retained_pair_required", 503);
  const decode = (value: unknown, purpose: Purpose) => decodePeer(
    value, purpose, source, configuration.publisher, owner.epoch, BigInt(configuration.configurationRevision),
  );
  const [learner, reviewer] = await Promise.all([
    decode(pair[0], "dance-verdict"), decode(pair[1], "dance-review-attribution"),
  ]);
  const l = learner.original, r = reviewer.original;
  insist(new Set([learner.commandId, reviewer.commandId, l.plan.commandId, r.plan.commandId]).size === 4 &&
    l.plan.accountId !== r.plan.accountId && l.plan.wallet !== r.plan.wallet &&
    l.hash !== r.hash && l.nonce !== r.nonce,
    "web2_dance_retained_peers_not_independent", 503);
  return { attachmentDigest: consentDigest(body.attachmentDigest), releaseSelectionHash,
    configHash: attachment.configurationHash, owner, policy, grants: [learner, reviewer] };
}
