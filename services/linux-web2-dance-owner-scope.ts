import { canonical, insist } from "../packages/community/common.ts";
import { nativeDigest } from "../packages/community/native-business-binding.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import { verifyWeb2DanceRetainedScope } from "../packages/community/web2-dance-retained-scope.ts";
import { readWeb2InstalledDanceRewards, web2DanceRewardSourceDocument } from "../packages/community/web2-dance-reward-attachment.ts";
import type { Web2NativePublicationMount } from "../deploy/linux/web2-publication-selection.ts";
import type { SignedRecord } from "../deploy/linux/installed-records.ts";
import { web2ApplicationOriginal, type ApplicationNativeEnv } from "./application-native-readback.ts";
import type { Web2CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import type { DanceV2OriginalLookup } from "./dance-v2-action-recovery.ts";
import { publicationSelectionHash } from "./publication-app-selection.ts";
import { loadPublicationInstallation } from "./publication-installed-selection.ts";
import type { InstalledDanceOwnerScopeReader } from "./web2-installed-dance-ordinary.ts";
import type { InstalledDanceRewardBindings } from "./web2-installed-dance-rewards.ts";

type Inputs = {
  env: ApplicationNativeEnv & InstalledDanceRewardBindings;
  /** Server-owned immutable artifact selection, supplied by the native mount. */
  readRecord(): string | undefined;
  /** The installed caller's actual fresh Directory reader. */
  readFreshConfiguration(deployment: Web2CommunityDeploymentProfile): Promise<Web2CommunityConfig>;
  /** Contracts' scoped read-only adapter to the same publisher Store. */
  actionOriginals?: DanceV2OriginalLookup;
};

/** Create the lazy reader only. Opening the ordinary Dance route still owns
 * D1 grant identity, withdrawal, current policy and BindIdentity verification. */
export function linuxWeb2DanceOwnerScopeReader(input: Inputs): InstalledDanceOwnerScopeReader {
  return async ({ deployment, config, reward }) => {
    const { readRecord, readFreshConfiguration, actionOriginals: lookup } = input;
    const raw = readRecord.call(input);
    if (raw === undefined || !lookup) return undefined;
    const readRetained = lookup.readRetainedAttempt;
    const { env } = input, db = env.DB;
    const nativeBytes = env.NATIVE_APPLICATION_ORIGINAL_JSON,
      rewardBytes = env.WEB2_DANCE_REWARD_ATTACHMENT_JSON,
      mountBytes = env.PUBLICATION_NATIVE_MOUNT_JSON;
    const deploymentBytes = canonical(deployment), configBytes = canonical(config);
    const sourceBytes = canonical(web2DanceRewardSourceDocument(reward.source));
    const rewardProfile = canonical(reward.profile), rewardOfferId = reward.offerId, rewardConfiguration = reward.configurationHash;
    const attachmentDigest = reward.attachmentDigest, releaseInput = structuredClone(deployment);
    function assertBindings() {
      insist(input.readRecord === readRecord && input.readFreshConfiguration === readFreshConfiguration &&
        readRecord.call(input) === raw && lookup.readRetainedAttempt === readRetained && env.DB === db &&
        env.NATIVE_APPLICATION_ORIGINAL_JSON === nativeBytes && env.WEB2_DANCE_REWARD_ATTACHMENT_JSON === rewardBytes &&
        env.PUBLICATION_NATIVE_MOUNT_JSON === mountBytes && env.WEB2_DANCE_REWARD_ATTACHMENT_SHA256 === undefined &&
        input.actionOriginals === lookup && canonical(deployment) === deploymentBytes && canonical(config) === configBytes &&
        reward.attachmentDigest === attachmentDigest && reward.offerId === rewardOfferId &&
        reward.configurationHash === rewardConfiguration && canonical(reward.profile) === rewardProfile &&
        canonical(web2DanceRewardSourceDocument(reward.source)) === sourceBytes,
        "linux_web2_dance_retained_bindings_changed", 503);
    }

    assertBindings();
    const original = await web2ApplicationOriginal(env);
    const originalDigest = nativeDigest(original);
    insist(canonical(original.record.body.draft.deployment) === deploymentBytes && mountBytes,
      "linux_web2_dance_retained_original_changed", 503);
    const rewards = await readWeb2InstalledDanceRewards({ original, attachmentJson: rewardBytes, publicationMountJson: mountBytes });
    insist(rewards && attachmentDigest === "0x" + rewards.signedSha256 &&
      rewards.attachment.configurationHash === reward.configurationHash && rewards.attachment.offerId === reward.offerId &&
      rewards.attachment.directoryInstallationId === reward.installationId && rewards.source.sourceHash === reward.sourceHash &&
      canonical(rewards.attachment.profile) === rewardProfile &&
      canonical(web2DanceRewardSourceDocument(rewards.source)) === sourceBytes, "linux_web2_dance_retained_reward_changed", 503);
    // The signed bytes above have already been verified under the native trust.
    const { body: { mount } }: SignedRecord<Web2NativePublicationMount> = JSON.parse(mountBytes);
    const installation = await loadPublicationInstallation(db, mount), release = installation.catalog.fresh();
    const releaseHash = publicationSelectionHash(release);
    insist(releaseHash === installation.catalog.active && canonical(release.configuration) === configBytes,
      "linux_web2_dance_retained_release_changed", 503);
    const scope = await verifyWeb2DanceRetainedScope({ raw, original, rewards, configuration: config,
      releaseSelectionHash: releaseHash });

    async function assertCurrent() {
      assertBindings();
      const [current, live] = await Promise.all([
        web2ApplicationOriginal(env), readFreshConfiguration.call(input, structuredClone(releaseInput)), installation.check(),
      ]);
      assertBindings();
      insist(nativeDigest(current) === originalDigest && canonical(live) === configBytes,
        "linux_web2_dance_retained_scope_stale", 503);
    }
    await assertCurrent();
    const actionOriginals: DanceV2OriginalLookup = Object.freeze({
      async readRetainedAttempt(offered: Parameters<DanceV2OriginalLookup["readRetainedAttempt"]>[0]) {
        const action = Object.freeze(structuredClone(offered));
        insist(action.chainId === 6343 && action.communityId === config.communityId &&
          action.verifier === rewards.source.domain.verifier && action.publisher === config.publisher &&
          action.sourceHash === rewards.source.sourceHash && (action.kind === "register" || action.kind === "verdict"),
          "linux_web2_dance_retained_action_scope_changed", 503);
        await assertCurrent();
        const retained = await readRetained.call(lookup, action);
        await assertCurrent();
        return retained;
      },
    });
    return Object.freeze({ ...scope, actionOriginals, assertCurrent });
  };
}
