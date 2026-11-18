import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { bytes32, canonical, exact, hashJson, insist, object } from "./common.ts";
import { address } from "./manifest-core.ts";
import { nativeDigest, verifyNativeRecord } from "./native-business-binding.ts";
import type { Web2CommunityConfig } from "./web2-config-manifest.ts";
import type { Web2NativeOriginal } from "./web2-native-business-binding.ts";
import { danceSourceHash } from "../dance-chain/v2/wire.ts";
import { danceShapes } from "../dance-chain/v2/wire-shapes.ts";
import { rewardId, rewardProfile } from "../rewards/validation.ts";
import type { RewardsProfile } from "../rewards/contracts.ts";
import type { DancePublicationSourceV2 } from "../../services/dance-publication-source.ts";
import type { SignedRecord } from "../../deploy/linux/installed-records.ts";
import type { Web2NativePublicationMount } from "../../deploy/linux/web2-publication-selection.ts";

export const web2DanceRewardBinding = "WEB2_DANCE_REWARD_ATTACHMENT_JSON";
export const web2DanceRewardFile = "dance-reward-attachment";
export const maxWeb2DanceRewardBytes = 65_536;

export interface Web2DanceRewardIntent {
  schema: "pirate.web2-dance-reward-intent/1";
  offerId: string;
  profile: RewardsProfile;
}

export function web2DanceRewardIntent(value: unknown): Web2DanceRewardIntent {
  const row = object(value);
  exact(row, ["schema", "offerId", "profile"]);
  const profile = rewardProfile(canonical(row.profile));
  const offerId = rewardId(row.offerId);
  insist(row.schema === "pirate.web2-dance-reward-intent/1" && profile.mode === "live-testnet" &&
    profile.rehearsal?.offerId === offerId && BigInt(profile.rehearsal.prizeUsdcAtomic) > 0n &&
    canonical(row.profile) === canonical(profile), "web2_dance_reward_intent_changed", 503);
  return { schema: row.schema, offerId, profile };
}

const sourcePinAbi = [danceShapes.sourcePin] as const;
const hexBytes = (value: unknown): Hex => {
  insist(typeof value === "string" && /^0x(?:[0-9a-f]{2}){512}$/.test(value), "web2_dance_reward_source_pin_invalid", 503);
  return value as Hex;
};

interface DanceSourceDocument {
  verifier: Hex;
  sourcePinAbi: Hex;
  sourceHash: Hex;
  capturePolicy: Hex;
  capturePolicyRuntimeHash: Hex;
}

export function web2DanceRewardSource(value: unknown, communityId: Hex): DancePublicationSourceV2 {
  const row = object(value);
  exact(row, ["verifier", "sourcePinAbi", "sourceHash", "capturePolicy", "capturePolicyRuntimeHash"]);
  const bytes = hexBytes(row.sourcePinAbi);
  const [decoded] = decodeAbiParameters(sourcePinAbi, bytes);
  const pin = { ...decoded, directory: address(decoded.directory), posts: address(decoded.posts), consentRegistry: address(decoded.consentRegistry) };
  const domain = { chainId: 6343n, verifier: address(row.verifier), communityId: bytes32(communityId) };
  const sourceHash = bytes32(row.sourceHash);
  insist(sourceHash === danceSourceHash(domain, pin) &&
    encodeAbiParameters(sourcePinAbi, [pin]) === bytes && pin.deploymentBlock > 0n,
    "web2_dance_reward_source_changed", 503);
  return { version: 2, domain, pin, sourceHash, capturePolicy: address(row.capturePolicy), capturePolicyRuntimeHash: bytes32(row.capturePolicyRuntimeHash) };
}

export function web2DanceRewardSourceDocument(source: DancePublicationSourceV2): DanceSourceDocument {
  insist(source.version === 2 && source.domain.chainId === 6343n, "web2_dance_reward_source_changed", 503);
  const doc: DanceSourceDocument = { verifier: source.domain.verifier, sourcePinAbi: encodeAbiParameters(sourcePinAbi, [source.pin]),
    sourceHash: source.sourceHash, capturePolicy: source.capturePolicy, capturePolicyRuntimeHash: source.capturePolicyRuntimeHash };
  web2DanceRewardSource(doc, source.domain.communityId);
  return doc;
}

export interface Web2DanceRewardAttachment {
  schema: "pirate.web2-installed-dance-rewards/1";
  hostInstallationId: string;
  directoryInstallationId: Hex;
  nativeOriginalSha256: string;
  approvalSha256: string;
  selectionSha256: Hex;
  deploymentHash: Hex;
  configurationHash: Hex;
  offerId: string;
  profile: RewardsProfile;
  source: DanceSourceDocument;
}

/** Caller supplies the verified D1 original, never a request-supplied trust key. */
export async function verifyWeb2DanceRewardAttachment(
  original: Web2NativeOriginal,
  raw: string | undefined,
) {
  const digest = original.record.body.danceRewardIntentSha256;
  if (digest === undefined && raw === undefined) return undefined;
  insist(digest && typeof raw === "string" && new TextEncoder().encode(raw).byteLength <= maxWeb2DanceRewardBytes,
    "web2_dance_reward_attachment_required", 503);
  const signed: SignedRecord<Web2DanceRewardAttachment> = JSON.parse(raw);
  await verifyNativeRecord(signed, original.trust);
  const attachment = signed.body;
  exact(object(attachment), ["schema", "hostInstallationId", "directoryInstallationId", "nativeOriginalSha256", "approvalSha256", "selectionSha256",
    "deploymentHash", "configurationHash", "offerId", "profile", "source"]);
  const intent = web2DanceRewardIntent({ schema: "pirate.web2-dance-reward-intent/1", profile: attachment.profile, offerId: attachment.offerId });
  const { draft, installationId } = original.record.body;
  const { directoryProfile, posts } = draft.deployment;
  const source = web2DanceRewardSource(attachment.source, directoryProfile.communityId);
  insist(attachment.schema === "pirate.web2-installed-dance-rewards/1" &&
    attachment.hostInstallationId === installationId && attachment.directoryInstallationId === directoryProfile.installationId &&
    attachment.nativeOriginalSha256 === nativeDigest(original) &&
    /^[a-f0-9]{64}$/.test(attachment.approvalSha256) && hashJson(intent) === digest &&
    digest === original.release.body.danceRewardIntentSha256 && attachment.deploymentHash === hashJson(draft.deployment) &&
    source.domain.chainId === BigInt(directoryProfile.chainId) && source.domain.communityId === directoryProfile.communityId &&
    source.pin.directory === directoryProfile.directory && source.pin.directoryRuntimeHash === directoryProfile.directoryCodeHash &&
    source.pin.posts === posts.address && source.pin.postsRuntimeHash === posts.runtimeCodeHash,
    "web2_dance_reward_attachment_changed", 503);
  bytes32(attachment.configurationHash);
  bytes32(attachment.selectionSha256);
  return { attachment, source, signedSha256: nativeDigest(signed) };
}

/** Resolve the app port using the signed native mount and fresh Directory config. */
export async function readWeb2InstalledDanceRewards(input: {
  original: Web2NativeOriginal;
  attachmentJson?: string;
  publicationMountJson?: string;
}) {
  const { original, attachmentJson, publicationMountJson } = input;
  const selected = await verifyWeb2DanceRewardAttachment(original, attachmentJson);
  if (!selected) return undefined;
  insist(publicationMountJson && publicationMountJson.length <= 8192, "web2_dance_reward_publication_mount_required", 503);
  const signed: SignedRecord<Web2NativePublicationMount> = JSON.parse(publicationMountJson);
  await verifyNativeRecord(signed, original.trust);
  const { mount, nativeOriginalSha256 } = signed.body;
  const { attachment, source } = selected;
  const draft = original.record.body.draft;
  insist(signed.body.schema === "pirate.web2-native-publication-mount/1" && mount.schema === "pirate.publication-mount/1" &&
    nativeOriginalSha256 === attachment.nativeOriginalSha256 && mount.installedBindingSha256 === "0x" + nativeOriginalSha256 &&
    mount.selectionSha256 === attachment.selectionSha256 && mount.communityId === draft.enrollment.communityId &&
    mount.installationId === draft.enrollment.installationId && mount.origin === draft.origin,
    "web2_dance_reward_publication_selection_changed", 503);
  return selected;
}

export function assertWeb2DanceRewardConfiguration(
  selected: NonNullable<Awaited<ReturnType<typeof verifyWeb2DanceRewardAttachment>>>,
  configuration: Web2CommunityConfig,
) {
  const { attachment, source } = selected;
  insist(configuration.schema === "pirate.community-config/4" && configuration.configurationRevision === 2 &&
    configuration.chainId === 6343 && configuration.communityId === source.domain.communityId &&
    configuration.installationId === attachment.directoryInstallationId && configuration.directory === source.pin.directory &&
    configuration.learningRecords === source.pin.consentRegistry && configuration.postsContract === source.pin.posts &&
    hashJson(configuration) === attachment.configurationHash, "web2_dance_reward_publication_selection_changed", 503);
}
