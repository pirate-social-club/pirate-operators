import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { hashJson } from "../packages/community/common.ts";
import { nativeDigest } from "../packages/community/native-business-binding.ts";
import {
  assertWeb2DanceRewardConfiguration, readWeb2InstalledDanceRewards, verifyWeb2DanceRewardAttachment,
  web2DanceRewardSourceDocument, type Web2DanceRewardAttachment, type Web2DanceRewardIntent,
} from "../packages/community/web2-dance-reward-attachment.ts";
import { danceSourceHash } from "../packages/dance-chain/v2/wire.ts";
import { web2NativeOriginal, type Web2NativeOriginal } from "../packages/community/web2-native-business-binding.ts";
import { signRecord } from "../deploy/linux/installed-records.ts";
import { authenticateWeb2Enrollment, type Web2InstallPlan } from "../deploy/linux/web2-profile-authority.ts";
import type { Web2NativePublicationMount } from "../deploy/linux/web2-publication-selection.ts";
import { installationAuthorityFixture } from "./fixtures/linux-web2-installation.ts";
import { address, rewardDanceV2Fixture, word } from "./fixtures/reward-dance-v2.ts";

test("signed reward intent and late Dance attachment admit only the same original and mounted revision", { timeout: 120_000 }, async t => {
  const fixture = await installationAuthorityFixture();
  t.after(fixture.close);
  const { draft, authority } = fixture;
  const evidence = await authenticateWeb2Enrollment(authority, draft);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trust = { keyId: "native-dance-reward-original-fixture", spki: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const sign = <T>(body: T) => signRecord(body, trust, privateKey.export({ format: "der", type: "pkcs8" }));
  const offerId = "selected_rehearsal_fixture";
  const intent: Web2DanceRewardIntent = { schema: "pirate.web2-dance-reward-intent/1", offerId, profile: {
    schema: "pirate.manual-rewards/1", programId: word(40), chainId: 6343, mode: "live-testnet", token: address(41), decimals: 6,
    operatorWallet: address(42), payoutWallet: address(43), ticketWallet: address(44), veryAppId: "test-rehearsal", rpcUrl: "https://rpc.fixture.test",
    resultSourceHash: word(45), rehearsal: { schema: "pirate.reward-rehearsal/1", offerId, prizeUsdcAtomic: "1" },
  } };
  const plan: Web2InstallPlan = { schema: "pirate.linux-web2-install-plan/1", installationId: "signed-host-fixture",
    planId: "web2-" + draft.enrollment.enrollmentId.slice(2), durableScope: "a".repeat(64), generation: 1, draft,
    releaseArtifactDigest: word(46), releaseSourceDigest: word(47), targetDigest: word(48), hostFingerprint: "fixture-host", enrollment: evidence,
    registrationAuthority: { registrar: authority.registrar, registrarRevision: String(authority.registrarRevision), maxSafeBlockAgeSeconds: "600" } };
  const formerRelease: Web2NativeOriginal["release"]["body"] = { schema: "pirate.complete-linux-web2-release/1",
    artifactDigest: plan.releaseArtifactDigest, sourceDigest: plan.releaseSourceDigest,
    graph: { installationId: plan.installationId, durableScope: plan.durableScope, directoryRuntimeBinding: JSON.stringify(draft.deployment) } };
  const makeOriginal = async (body: Web2InstallPlan, release: typeof formerRelease) => web2NativeOriginal(JSON.stringify({
    schema: "pirate.web2-native-application-original/1", trust, durableScope: plan.durableScope, record: sign(body), release: sign(release),
  }));
  const legacy = await makeOriginal(plan, formerRelease);
  assert.equal(await verifyWeb2DanceRewardAttachment(legacy, undefined), undefined);
  const digest = hashJson(intent);
  await assert.rejects(makeOriginal({ ...plan, danceRewardIntentSha256: digest }, formerRelease), /web2_native_original_binding_changed/);
  const original = await makeOriginal({ ...plan, danceRewardIntentSha256: digest }, { ...formerRelease, danceRewardIntentSha256: digest });
  const { source: example } = rewardDanceV2Fixture();
  const { directoryProfile, posts } = draft.deployment;
  const domain = { ...example.domain, communityId: directoryProfile.communityId };
  const pin = { ...example.pin, directory: directoryProfile.directory, directoryRuntimeHash: directoryProfile.directoryCodeHash,
    posts: posts.address, postsRuntimeHash: posts.runtimeCodeHash };
  const source = { ...example, domain, pin, sourceHash: danceSourceHash(domain, pin) };
  const config = { ...draft.configuration, configurationRevision: 2, learningRecords: source.pin.consentRegistry };
  const attachment: Web2DanceRewardAttachment = { schema: "pirate.web2-installed-dance-rewards/1", hostInstallationId: plan.installationId,
    directoryInstallationId: directoryProfile.installationId, nativeOriginalSha256: nativeDigest(original), approvalSha256: "b".repeat(64),
    selectionSha256: word(49), deploymentHash: hashJson(draft.deployment), configurationHash: hashJson(config),
    offerId, profile: intent.profile, source: web2DanceRewardSourceDocument(source) };
  const mount: Web2NativePublicationMount = { schema: "pirate.web2-native-publication-mount/1", nativeOriginalSha256: nativeDigest(original),
    transportRef: "fixture-role", issuerCapabilityRef: "controller", issuerAddress: config.controller,
    mount: { schema: "pirate.publication-mount/1", communityId: domain.communityId,
      installationId: directoryProfile.installationId, origin: draft.origin, incarnation: "1",
      installedBindingSha256: `0x${nativeDigest(original)}`, selectionSha256: attachment.selectionSha256 } };
  const attachmentJson = JSON.stringify(sign(attachment)), publicationMountJson = JSON.stringify(sign(mount));
  const input = { original, attachmentJson, publicationMountJson };
  const chosen = await readWeb2InstalledDanceRewards(input);
  assert(chosen && chosen.attachment.hostInstallationId !== chosen.attachment.directoryInstallationId);
  assert.deepEqual(chosen.source, source);
  assert.doesNotThrow(() => assertWeb2DanceRewardConfiguration(chosen, config));
  assert.throws(() => assertWeb2DanceRewardConfiguration(chosen, draft.configuration), /web2_dance_reward_publication_selection_changed/);
  await assert.rejects(readWeb2InstalledDanceRewards({ ...input, original: legacy }), /web2_dance_reward_attachment_required/);
  await assert.rejects(readWeb2InstalledDanceRewards({ ...input, attachmentJson: undefined }), /web2_dance_reward_attachment_required/);
  const otherOperator = { ...attachment, profile: { ...attachment.profile, operatorWallet: address(96) } };
  await assert.rejects(readWeb2InstalledDanceRewards({ ...input, attachmentJson: JSON.stringify(sign(otherOperator)) }), /web2_dance_reward_attachment_changed/);
  await assert.rejects(readWeb2InstalledDanceRewards({ ...input, attachmentJson: JSON.stringify({ ...sign(attachment), body: otherOperator }) }), /native_original_signature/);
  await assert.rejects(readWeb2InstalledDanceRewards({ ...input, publicationMountJson: JSON.stringify(sign({ ...mount,
    mount: { ...mount.mount, selectionSha256: word(50) } })) }), /web2_dance_reward_publication_selection_changed/);
});
