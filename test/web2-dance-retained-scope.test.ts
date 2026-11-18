// Native original setup follows the signed Rewards attachment fixture.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { keccak256, zeroHash } from "viem";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { nativeDigest } from "../packages/community/native-business-binding.ts";
import { readWeb2InstalledDanceRewards, web2DanceRewardSourceDocument, type Web2DanceRewardAttachment,
  type Web2DanceRewardIntent } from "../packages/community/web2-dance-reward-attachment.ts";
import { verifyWeb2DanceRetainedScope, web2DanceRetainedPeer,
  type Web2DanceRetainedScopeDocument } from "../packages/community/web2-dance-retained-scope.ts";
import { danceAccountCommitment, danceCommand, danceSingletonId, danceSourceHash } from "../packages/dance-chain/v2/wire.ts";
import { web2NativeOriginal, type Web2NativeOriginal } from "../packages/community/web2-native-business-binding.ts";
import { signRecord } from "../deploy/linux/installed-records.ts";
import { authenticateWeb2Enrollment, type Web2InstallPlan } from "../deploy/linux/web2-profile-authority.ts";
import type { Web2NativePublicationMount } from "../deploy/linux/web2-publication-selection.ts";
import { installationAuthorityFixture } from "./fixtures/linux-web2-installation.ts";
import { address, rewardDanceV2Fixture, word } from "./fixtures/reward-dance-v2.ts";
import { web2Owner, web2Publisher } from "./fixtures/web2-first-song-chain.ts";

test("retained Dance owner scope authenticates both exact BindIdentity originals and rejects re-signed cross-wires", { timeout: 120_000 }, async t => {
  const fixture = await installationAuthorityFixture();
  t.after(fixture.close);
  const { draft, authority } = fixture;
  const evidence = await authenticateWeb2Enrollment(authority, draft);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trust = { keyId: "native-dance-retained-scope-fixture", spki: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
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
  const digest = hashJson(intent);
  const original = await makeOriginal({ ...plan, danceRewardIntentSha256: digest }, { ...formerRelease, danceRewardIntentSha256: digest });
  const { source: example } = rewardDanceV2Fixture();
  const { directoryProfile, posts } = draft.deployment;
  const domain = { ...example.domain, communityId: directoryProfile.communityId };
  const policy = { rules: "rules\r\n", terms: "terms\n", rubric: "rubric\n", media: "media\n",
    consentVersion: "fixture/1", captureTtlMs: 60_000 };
  const pin = { ...example.pin, rulesSha256: hashText(policy.rules), termsSha256: hashText(policy.terms),
    rubricSha256: hashText(policy.rubric), mediaPolicySha256: hashText(policy.media),
    directory: directoryProfile.directory, directoryRuntimeHash: directoryProfile.directoryCodeHash,
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
  assert(chosen);
  assert.equal(config.publisher, web2Publisher.address.toLowerCase());
  const owner = { epoch: "1", wallet: web2Owner.address.toLowerCase() as `0x${string}` };
  async function originalBinding(index: number) {
    const accountId = "00000000-0000-4000-a000-00000000000" + (index + 1);
    const wallet = address(80 + index), commandId = word(90 + index), nonce = 70 + index;
    const accountCommitment = danceAccountCommitment(domain, accountId, wallet);
    const groupId = danceSingletonId(domain, accountCommitment);
    const command = danceCommand(domain, "bindIdentity", config.publisher, commandId, {
      expectedOwnerEpoch: 1n, expectedConfigurationRevision: 2n, accountCommitment, wallet,
      expectedIdentityEpoch: 0n, sourceGroupId: zeroHash, sourceBindingGroupEpoch: 0n, sourceCurrentGroupEpoch: 0n,
      destinationGroupId: groupId, destinationGroupEpoch: 0n, createSingleton: true, active: true,
    });
    const raw = await web2Publisher.signTransaction({ type: "legacy", to: domain.verifier, data: command.data,
      gas: 500000n, gasPrice: 1n, chainId: 6343, nonce, value: 0n });
    return { raw, hash: keccak256(raw), nonce, plan: { accountId, wallet, commandId,
      publisher: config.publisher, sourceHash: source.sourceHash, ownerEpoch: 1n, configurationRevision: 2n } };
  }
  const learner = await originalBinding(0), reviewer = await originalBinding(1);
  const releaseSelectionHash = word(54);
  const doc: Web2DanceRetainedScopeDocument = {
    schema: "pirate.web2-dance-retained-owner-scope/1", nativeOriginalSha256: nativeDigest(original),
    hostInstallationId: plan.installationId, directoryInstallationId: config.installationId,
    selectionSha256: attachment.selectionSha256, releaseSelectionHash, configurationHash: hashJson(config),
    attachmentDigest: `0x${chosen.signedSha256}`, sourceHash: source.sourceHash, owner, policy,
    grants: [web2DanceRetainedPeer("dance-verdict", word(95), learner),
      web2DanceRetainedPeer("dance-review-attribution", word(96), reviewer)],
  };
  const selected = { original, rewards: chosen, configuration: config, releaseSelectionHash };
  const verify = (body: unknown) => verifyWeb2DanceRetainedScope({ ...selected, raw: canonical(sign(body)) });
  const scope = await verify(doc);
  assert.deepEqual(scope.grants, [{ commandId: word(95), original: learner }, { commandId: word(96), original: reviewer }]);
  assert.deepEqual(scope.policy, policy);
  await assert.rejects(verify({ ...doc, grants: [doc.grants[1], doc.grants[0]] }), /web2_dance_retained_role_changed/);
  await assert.rejects(verify({ ...doc, grants: [doc.grants[0], { ...doc.grants[1],
    appGrantCommandId: doc.grants[0].appGrantCommandId }] }), /web2_dance_retained_peers_not_independent/);
  await assert.rejects(verify({ ...doc, grants: [doc.grants[0], { ...doc.grants[1],
    binding: { ...doc.grants[1].binding, plan: { ...doc.grants[1].binding.plan, sourceHash: word(99) } } }] }),
  /web2_dance_retained_binding_scope_changed/);
  await assert.rejects(verify({ ...doc, grants: [{ ...doc.grants[0], binding: { ...doc.grants[0].binding, nonce: 73 } }, doc.grants[1]] }),
  /web2_dance_retained_binding_scope_changed/);
  await assert.rejects(verify({ ...doc, attachmentDigest: word(53) }), /web2_dance_retained_scope_changed/);
  await assert.rejects(verify({ ...doc, policy: { ...policy, rules: policy.rules.replace("\r", "") } }), /web2_dance_retained_policy_bytes_changed/);
  await assert.rejects(verifyWeb2DanceRetainedScope({ ...selected, raw: canonical({ ...sign(doc),
    body: { ...doc, releaseSelectionHash: word(55) } }) }), /native_original_signature/);
});
