import { canonical, hashText, insist, integer } from "../packages/community/common.ts";
import { parseWeb2ProfileDocument } from "../packages/community/web2-directory.ts";
import type { Web2CommunityConfig } from "../packages/community/web2-config-manifest.ts";
import type { Web2CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import type { PublicReadPorts } from "./community-public.ts";
import { web2ApplicationOriginal } from "./application-native-readback.ts";
import { verifyDancePublicationSource } from "./dance-publication-source.ts";
import { openNativePublicationApplication, reuseNativePublicationApplication, type NativePublicationApplicationEnv } from "./linux-web2-publication.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";
import { publicationSelectionHash } from "./publication-app-selection.ts";
import { assertInstalledRewardDanceSource } from "./web2-installed-dance-song.ts";
import { assertInstalledDanceRewardConfiguration, readInstalledDanceRewardAttachment,
  type InstalledDanceRewardBindings, type InstalledDanceRewards } from "./web2-installed-dance-rewards.ts";
import type { Web2PublicDanceInputs } from "./web2-public-dance-start.ts";

/** W6's verified retained authority is the owning producer. This port is
 * in-process, server-owned and read-only. No HTTP body or bare env JSON can
 * supply this input. An incomplete funded or first-grant scope is unavailable. */
export interface NativeInstalledDanceAuthority {
  readonly attachmentDigest: InstalledDanceRewards["attachmentDigest"];
  readonly releaseSelectionHash: ReturnType<typeof publicationSelectionHash>;
  readonly configHash: InstalledDanceRewards["configurationHash"];
  readonly owner: Web2PublicDanceInputs["owner"];
  readonly policy: Web2PublicDanceInputs["policy"];
  readonly participants: NonNullable<Web2PublicDanceInputs["participants"]>;
  readonly actionOriginals: NonNullable<Web2PublicDanceInputs["actionOriginals"]>;
  /** Re-read the same signed native original, participant originals and
   * private lookup binding. This never reserves authority or dispatches. */
  assertCurrent(): Promise<void>;
}

export interface InstalledPublicDanceMount {
  readonly selection: Web2PublicDanceInputs;
  assertCurrent(): Promise<void>;
}

export async function openInstalledPublicDance(input: {
  env: NativePublicationApplicationEnv & InstalledDanceRewardBindings;
  deployment: Web2CommunityDeploymentProfile;
  config: Web2CommunityConfig;
  reads: PublicReadPorts;
  reward: InstalledDanceRewards;
  authority?: NativeInstalledDanceAuthority;
  publication?: PublicationApplicationPorts;
}): Promise<InstalledPublicDanceMount> {
  const { env, deployment, config, reads, reward, authority } = input;
  insist(authority?.owner && authority.policy && authority.participants?.pair?.length === 2 &&
    authority.participants.originals?.length === 2 &&
    typeof authority.participants.privateOriginalFences === "function" &&
    typeof authority.actionOriginals?.readRetainedAttempt === "function" && typeof authority.assertCurrent === "function",
  "dance_installed_authority_unavailable", 503);
  const selectedAuthority = authority;
  const { attachmentDigest, configHash } = selectedAuthority;
  const identity = env.NATIVE_APPLICATION_ORIGINAL_JSON;
  const mountBytes = env.PUBLICATION_NATIVE_MOUNT_JSON;
  const attachmentBytes = env.WEB2_DANCE_REWARD_ATTACHMENT_JSON;
  const verifiedReward = await readInstalledDanceRewardAttachment(env, await web2ApplicationOriginal(env), deployment);
  insist(verifiedReward && attachmentBytes && verifiedReward.attachmentDigest === reward.attachmentDigest &&
    verifiedReward.offerId === reward.offerId && verifiedReward.configurationHash === reward.configurationHash,
  "dance_installed_authority_changed", 503);
  const selectedReward = verifiedReward;
  assertInstalledRewardDanceSource(selectedReward, reward.source);
  insist(attachmentDigest === selectedReward.attachmentDigest && configHash === selectedReward.configurationHash,
    "dance_installed_authority_changed", 503);
  const db = env.DB, client = reads.client;
  const source = structuredClone(reward.source);
  const owner = structuredClone(selectedAuthority.owner), policy = structuredClone(selectedAuthority.policy);
  const { participants, actionOriginals } = selectedAuthority;
  const assertAuthority = selectedAuthority.assertCurrent.bind(selectedAuthority);
  const privateFences = participants.privateOriginalFences.bind(participants);
  const readOriginal = actionOriginals.readRetainedAttempt.bind(actionOriginals);
  const pair = structuredClone(participants.pair), originals = structuredClone(participants.originals);
  const publication = input.publication
    ? await reuseNativePublicationApplication(env, deployment, input.publication)
    : (await openNativePublicationApplication(env, deployment, client)).publication;
  const { installation, catalog } = publication;
  insist(installation && publication.db === db && installation.db === db &&
    installation.catalog === catalog && publication.client === client &&
    installation.expected.installationId === config.installationId,
  "dance_installed_publication_changed", 503);
  const release = catalog.fresh(), releaseHash = publicationSelectionHash(release);
  const configBytes = canonical(config);
  const learner = release.policies["dance-verdict"], reviewer = release.policies["dance-review-attribution"];
  insist(learner && reviewer && [learner, reviewer].every(rule =>
    rule.target === source.domain.verifier && rule.runtimeHash === source.pin.runtimeCodeHash &&
    rule.dancePublicityPolicyHash === source.pin.publicityPolicyHash) &&
    learner.policyHash === source.pin.learnerConsentPolicyHash && reviewer.policyHash === source.pin.reviewerConsentPolicyHash &&
    releaseHash === selectedAuthority.releaseSelectionHash && canonical(release.configuration) === configBytes &&
    hashText(policy.rules) === source.pin.rulesSha256 && hashText(policy.terms) === source.pin.termsSha256 &&
    hashText(policy.rubric) === source.pin.rubricSha256 && hashText(policy.media) === source.pin.mediaPolicySha256 &&
    typeof policy.consentVersion === "string" && policy.consentVersion.length >= 1 && policy.consentVersion.length <= 128,
  "dance_installed_authority_changed", 503);
  integer(policy.captureTtlMs, 1, 3600000);
  insist(pair[0].purpose === "dance-verdict" && pair[1].purpose === "dance-review-attribution" &&
    pair[0].accountId !== pair[1].accountId && pair[0].wallet !== pair[1].wallet && pair[0].grantId !== pair[1].grantId &&
    originals[0].hash !== originals[1].hash &&
    originals.every((entry, index) => entry.plan.accountId === pair[index]!.accountId &&
      entry.plan.wallet === pair[index]!.wallet && entry.plan.sourceHash === source.sourceHash &&
      entry.plan.publisher === config.publisher && entry.plan.ownerEpoch === owner.epoch &&
      entry.plan.configurationRevision === BigInt(config.configurationRevision)),
  "dance_installed_participants_changed", 503);

  async function assertCurrent() {
    await assertAuthority();
    await reuseNativePublicationApplication(env, deployment, publication);
    insist(env.DB === db && env.NATIVE_APPLICATION_ORIGINAL_JSON === identity &&
      env.PUBLICATION_NATIVE_MOUNT_JSON === mountBytes && env.WEB2_DANCE_REWARD_ATTACHMENT_JSON === attachmentBytes &&
      env.WEB2_DANCE_REWARD_ATTACHMENT_SHA256 === undefined && selectedAuthority.attachmentDigest === attachmentDigest &&
      selectedAuthority.configHash === configHash && selectedAuthority.releaseSelectionHash === releaseHash &&
      selectedAuthority.participants === participants &&
      selectedAuthority.actionOriginals === actionOriginals && canonical(config) === configBytes &&
      publicationSelectionHash(catalog.fresh()) === releaseHash,
    "dance_installed_authority_changed", 503);
    assertInstalledDanceRewardConfiguration(selectedReward, config);
    assertInstalledRewardDanceSource(selectedReward, source);
  }

  await assertCurrent();
  await verifyDancePublicationSource({
    client, selected: source, profile: parseWeb2ProfileDocument(release.profile),
    config, caller: config.publisher, owner, clock: publication.clock, afterAwait: assertCurrent,
  });
  await assertCurrent();
  const selection: Web2PublicDanceInputs = Object.freeze({
    publication, source, publisher: config.publisher, owner, policy, installedReward: selectedReward,
    participants: Object.freeze({
      pair, originals,
      async privateOriginalFences(expected: typeof pair) {
        await assertCurrent();
        insist(canonical(expected) === canonical(pair), "dance_installed_participants_changed", 503);
        const fences = await privateFences(expected);
        await assertCurrent();
        return [installation.mountFence(), ...fences];
      },
    }),
    actionOriginals: Object.freeze({
      async readRetainedAttempt(original: Parameters<typeof actionOriginals.readRetainedAttempt>[0]) {
        await assertCurrent();
        const retained = await readOriginal(original);
        await assertCurrent();
        return retained;
      },
    }),
  });
  return Object.freeze({ selection, assertCurrent });
}
