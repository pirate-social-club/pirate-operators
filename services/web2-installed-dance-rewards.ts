import type { Hex } from "viem";
import { hashJson, insist } from "../packages/community/common.ts";
import { readWeb2InstalledDanceRewards } from "../packages/community/web2-dance-reward-attachment.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { Web2NativeOriginal } from "../packages/community/web2-native-business-binding.ts";
import { danceOfferId } from "../packages/dance-chain/v2/wire.ts";
import type { DanceOfferSelection } from "../packages/dance/contracts.ts";
import type { RewardsProfile } from "../packages/rewards/contracts.ts";
import { selectedManualDanceOffer } from "../packages/rewards/offers.ts";
import { rewardProfileAncestors } from "../packages/rewards/rehearsal.ts";
import { RewardStore, type OfferRow } from "../packages/rewards/store.ts";

import type { Web2CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import type { DancePublicationSourceV2 } from "./dance-publication-source.ts";

export interface InstalledDanceRewardBindings {
  WEB2_DANCE_REWARD_ATTACHMENT_JSON?: string;
  WEB2_DANCE_REWARD_ATTACHMENT_SHA256?: string;
  PUBLICATION_NATIVE_MOUNT_JSON?: string;
}

export interface ManualDanceOfferSelection {
  readonly offerId: string;
  readonly sourceHash: Hex;
}

export interface InstalledDanceRewards extends ManualDanceOfferSelection {
  readonly attachmentDigest: Hex;
  readonly installationId: Hex;
  readonly configurationHash: Hex;
  readonly profile: RewardsProfile;
  readonly source: DancePublicationSourceV2;
}

/** An exact, signed installer record selects the same wire source for rewards
 * and Dance. The verified original is supplied by the installed application. */
export async function readInstalledDanceRewardAttachment(
  env: InstalledDanceRewardBindings,
  original: Web2NativeOriginal | undefined,
  deployment: Web2CommunityDeploymentProfile,
): Promise<InstalledDanceRewards | undefined> {
  const raw = env.WEB2_DANCE_REWARD_ATTACHMENT_JSON;
  const publicationMountJson = env.PUBLICATION_NATIVE_MOUNT_JSON;
  insist(env.WEB2_DANCE_REWARD_ATTACHMENT_SHA256 === undefined, "dance_reward_attachment_unverified", 503);
  if (!original) {
    insist(raw === undefined, "dance_reward_attachment_unverified", 503);
    return undefined;
  }
  const selected = await readWeb2InstalledDanceRewards({ original, attachmentJson: raw, publicationMountJson });
  insist(env.WEB2_DANCE_REWARD_ATTACHMENT_JSON === raw && env.PUBLICATION_NATIVE_MOUNT_JSON === publicationMountJson,
    "dance_reward_attachment_changed", 503);
  if (!selected) return undefined;
  const { attachment, source } = selected;
  insist(attachment.deploymentHash === hashJson(deployment), "dance_reward_attachment_changed", 503);
  return {
    attachmentDigest: `0x${selected.signedSha256}`, installationId: attachment.directoryInstallationId,
    configurationHash: attachment.configurationHash, profile: attachment.profile, offerId: attachment.offerId,
    sourceHash: source.sourceHash, source,
  };
}

export function assertInstalledDanceRewardConfiguration(
  selection: InstalledDanceRewards,
  config: CommunityConfig,
) {
  const { domain, pin } = selection.source;
  insist(
    config.schema === "pirate.community-config/4" &&
      config.installationId === selection.installationId &&
      config.communityId === domain.communityId &&
      config.chainId === 6343 &&
      config.learningRecords.toLowerCase() ===
        pin.consentRegistry.toLowerCase() &&
      config.postsContract.toLowerCase() === pin.posts.toLowerCase() &&
      config.directory.toLowerCase() === pin.directory.toLowerCase() &&
      hashJson(config) === selection.configurationHash,
    "dance_reward_configuration_changed",
    503,
  );
}

export function allowsInstalledDanceReward(
  method: string,
  path: string,
  selection: ManualDanceOfferSelection | undefined,
) {
  return (
    !!selection &&
    ((method === "GET" &&
      (path === "/api/rewards/offers" || path === "/api/operator/rewards")) ||
      (method === "POST" &&
        (path === "/api/operator/rewards/offers" ||
          path === `/api/operator/rewards/offers/${selection.offerId}/close`)))
  );
}

/** The original attachment row is the only producer of the offer input hash. */
export async function readInstalledDanceOffer(
  store: RewardStore,
  selection: ManualDanceOfferSelection,
) {
  const row = await store
    .statement(
      "SELECT * FROM reward_offers WHERE program_id=? AND offer_id=?",
      store.program,
      selection.offerId,
    )
    .first<OfferRow>();
  if (!row) return null;
  return {
    row,
    offer: selectedManualDanceOffer(row, store.profile, selection),
  };
}

/** For the installed publication-bound catalogue branch only. Its existing
 * capture writer consumes the returned terms in the original DB fence. */
export async function installedDanceOfferForSong(
  db: D1Database,
  selection: InstalledDanceRewards,
  songKey: string,
  time: number,
): Promise<{ offerProgramId: string; offer: DanceOfferSelection } | null> {
  const store = new RewardStore(db, selection.profile);
  const stored = await readInstalledDanceOffer(store, selection);
  if (
    !stored ||
    stored.offer.songKey !== songKey ||
    stored.offer.state !== "open" ||
    time < stored.offer.opensAt ||
    time >= stored.offer.cutoffAt
  )
    return null;
  const program = await store
    .statement(
      "SELECT profile_hash FROM reward_programs WHERE program_id=?",
      store.program,
    )
    .first<{ profile_hash: string }>();
  const acceptedProfiles = [
    selection.profile,
    ...rewardProfileAncestors(selection.profile),
  ];
  insist(
    program &&
      acceptedProfiles.some(
        (profile) => hashJson(profile) === program.profile_hash,
      ),
    "reward_program_configuration_changed",
    503,
  );
  return {
    offerProgramId: selection.profile.programId,
    offer: {
      offerId: selection.offerId,
      offerIdCommitment: danceOfferId(
        selection.source.domain,
        selection.offerId,
      ),
      inputHash: stored.row.input_hash,
      sourceHash: selection.sourceHash,
      opensAtMs: stored.offer.opensAt,
      cutoffAtMs: stored.offer.cutoffAt,
    },
  };
}
