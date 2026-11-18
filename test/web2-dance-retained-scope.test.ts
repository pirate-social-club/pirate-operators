// Native original setup follows the signed Rewards attachment fixture.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import { keccak256, parseTransaction, zeroHash } from "viem";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { nativeCanonical, nativeDigest } from "../packages/community/native-business-binding.ts";
import { readWeb2InstalledDanceRewards, web2DanceRewardBinding, web2DanceRewardFile, web2DanceRewardSourceDocument, type Web2DanceRewardAttachment,
  type Web2DanceRewardIntent } from "../packages/community/web2-dance-reward-attachment.ts";
import { verifyWeb2DanceRetainedScope, web2DanceRetainedPeer,
  type Web2DanceRetainedScopeDocument } from "../packages/community/web2-dance-retained-scope.ts";
import { danceAccountCommitment, danceCommand, danceSingletonId, danceSourceHash } from "../packages/dance-chain/v2/wire.ts";
import { initializeWeb2NativeOriginal, web2NativeOriginal, type Web2NativeOriginal } from "../packages/community/web2-native-business-binding.ts";
import { canonicalDigest, signRecord } from "../deploy/linux/installed-records.ts";
import { authenticateWeb2Enrollment, type Web2HostAdmission, type Web2InstallPlan } from "../deploy/linux/web2-profile-authority.ts";
import type { Web2NativePublicationMount } from "../deploy/linux/web2-publication-selection.ts";
import { renderFullNativeConfig, type NativeGraph } from "../deploy/linux/full-native-config.ts";
import { danceActivationPaths, web2DanceScopeBinding, web2DanceScopeFile } from "../deploy/linux/web2-dance-retained-files.ts";
import {
  assertPublicDancePreparedGrants, readTrustedPublicDanceArtifacts, readWeb2DanceActivation, stageWeb2DanceActivation,
} from "../deploy/linux/web2-dance-retained-activation.ts";
import { readRetainedWeb2DanceControl, recoverWeb2BindingControlRecords } from "../deploy/linux/web2-runtime-binding.ts";
import { trustedRevisionTwo, web2OriginalStartIntent } from "../deploy/linux/web2-trusted-revision-two.ts";
import { createNativeDanceRetainedStore } from "../deploy/linux/web2-native-dance-retained-store.ts";
import { openPinnedNativeDanceOperatorStore } from "../deploy/linux/web2-native-dance-store-connection.ts";
import { operatorDatabase } from "./fixtures/publication-app-http.ts";
import { acquireWeb2ServiceControl } from "../deploy/linux/web2-service-lease.ts";
import type { FullRelease } from "../deploy/linux/installed-release.ts";
import { readRetainedWeb2DanceBindPrepare, retainWeb2DanceBindPrepare, web2DanceIntentFile, web2DancePrepareFile } from "../deploy/linux/web2-dance-bind-prepare.ts";
import { web2DancePrepareContentType } from "../packages/community/web2-dance-bind-intent.ts";
import { nativePublicationLookupFetch } from "../services/linux-web2-publication.ts";
import { publicationAcceptSessionHeader, publicationLookupPath } from "../services/native-publication-reference.ts";
import { digest as protocolDigest } from "../packages/protocol/index.ts";
import {
  web2PublicDanceCustodyFile, web2PublicDanceStagedCustodyFile, type Web2PublicDanceCustody,
} from "../deploy/linux/web2-public-dance-custody.ts";
import { readWeb2DanceRewardApproval } from "../deploy/linux/web2-dance-reward-installation.ts";
import type { ObservedDanceGrant } from "../services/web2-dance-observed-grant.ts";
import type { InstalledDanceBindIntent } from "../services/web2-installed-dance-bind-prepare.ts";
import { scriptedPublicationAuthority } from "./fixtures/publication-app-rpc.ts";
import { publicationSelectionHash, publicationSelectionSource, type PublicationAppRelease } from "../services/publication-app-selection.ts";
import type { Web2DancePublicationApproval } from "../deploy/linux/web2-dance-publication-authority.ts";
import { nativeBusinessTransition } from "../packages/community/native-business-transition.ts";
import { nativeMigrationNames } from "./application-native-producer-fixture.ts";
import { migrateOwnerDatabase } from "./owner-publishing-migration-fixture.ts";
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
  async function originalBinding(index: number, commandId = word(90 + index)) {
    const accountId = "00000000-0000-4000-a000-00000000000" + (index + 1);
    const wallet = address(80 + index), nonce = 70 + index;
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

  await t.test("owner Prepare retains one exact ordered result and never re-prepares it", async t => {
    const parent = await mkdtemp(join(tmpdir(), "web2-dance-bind-prepare-"));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const draftIntent: InstalledDanceBindIntent = {
      schema: "pirate.installed-dance-bind-intent/1", intentId: word(110),
      installedBindingSha256: `0x${nativeDigest(original)}`, communityId: domain.communityId,
      installationId: directoryProfile.installationId, releaseSha256: releaseSelectionHash,
      configurationSha256: hashJson(config), sourceHash: source.sourceHash,
      ownerEpoch: owner.epoch, ownerWallet: owner.wallet,
      grants: [
        { purpose: "dance-verdict", commandId: word(95), accountId: learner.plan.accountId },
        { purpose: "dance-review-attribution", commandId: word(96), accountId: reviewer.plan.accountId },
      ],
    };
    const rawIntent = canonical(sign(draftIntent));
    const intentSha256 = protocolDigest(draftIntent);
    const plans = draftIntent.grants.map((grant, position) => {
      const wallet = position === 0 ? learner.plan.wallet : reviewer.plan.wallet;
      const grantId = word(116 + position), grantReceiptSha256 = word(120 + position);
      const commandId = protocolDigest({ schema: "pirate.installed-dance-bind-command/1",
        intentSha256, position, appCommandId: grant.commandId, grantId });
      const accountCommitment = danceAccountCommitment(domain, grant.accountId, wallet);
      return {
        purpose: grant.purpose, appGrantCommandId: grant.commandId, grantId, grantReceiptSha256,
        plan: { accountId: grant.accountId, wallet, publisher: config.publisher, sourceHash: source.sourceHash,
          ownerEpoch: "1", configurationRevision: "2", commandId },
        command: danceCommand(domain, "bindIdentity", config.publisher, commandId, {
          expectedOwnerEpoch: 1n, expectedConfigurationRevision: 2n, accountCommitment, wallet, expectedIdentityEpoch: 0n,
          sourceGroupId: zeroHash, sourceBindingGroupEpoch: 0n, sourceCurrentGroupEpoch: 0n,
          destinationGroupId: danceSingletonId(domain, accountCommitment), destinationGroupEpoch: 0n,
          createSingleton: true, active: true,
        }),
      };
    });
    const rawPrepare = canonical({ schema: "pirate.installed-dance-bind-prepare/1", intentSha256, plans });
    let approved = rawIntent, available = false, ownerReads = 0, requests = 0;
    const options = {
      directory: parent, original, source, approved: { releaseSha256: releaseSelectionHash,
        configurationSha256: hashJson(config), ownerWallet: owner.wallet, publisher: config.publisher, configurationRevision: 2 },
      owner: { async approvedIntent(selection: {nativeOriginalSha256: string; releaseSelectionHash: unknown}) {
        ownerReads++;
        assert.deepEqual(selection, { nativeOriginalSha256: nativeDigest(original), releaseSelectionHash });
        return approved;
      } },
      async assertCurrent() { assert(available, "missing_current_admission"); },
      async prepare(raw: string) {
        requests++;
        assert.equal(raw, rawIntent);
        assert.equal(await readFile(join(parent, web2DanceIntentFile), "utf8"), rawIntent);
        return rawPrepare;
      },
    };
    await assert.rejects(retainWeb2DanceBindPrepare(options), /missing_current_admission/);
    assert.equal(ownerReads, 0);
    assert.equal(requests, 0);
    assert.deepEqual(await readdir(parent), []);

    available = true;
    const first = await retainWeb2DanceBindPrepare(options);
    assert.deepEqual(first, { intentSha256, prepareSha256: hashText(rawPrepare).slice(2), status: "prepared" });
    const resultPath = join(parent, web2DancePrepareFile);
    assert.equal(await readFile(resultPath, "utf8"), rawPrepare);
    assert.equal(requests, 1);
    assert.deepEqual(await retainWeb2DanceBindPrepare({
      ...options, async prepare() { throw Error("already_bound_prefix_must_not_reprepare"); },
    }), { ...first, status: "retained" });
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")).plans, JSON.parse(rawPrepare).plans);
    assert.equal(requests, 1);

    approved = canonical(sign({ ...draftIntent, intentId: word(115) }));
    await assert.rejects(retainWeb2DanceBindPrepare(options), /web2_dance_bind_prepare_original_changed/);
    assert.equal(await readFile(resultPath, "utf8"), rawPrepare);
    approved = rawIntent;
    await writeFile(resultPath, rawPrepare.slice(0, -3));
    await assert.rejects(retainWeb2DanceBindPrepare(options), SyntaxError);
    assert.equal(requests, 1);

    const interrupted = join(parent, "interrupted");
    await mkdir(interrupted, { mode: 0o700 });
    await assert.rejects(retainWeb2DanceBindPrepare({
      ...options, directory: interrupted,
      async prepare(raw) {
        assert.equal(raw, rawIntent);
        assert.equal(await readFile(join(interrupted, web2DanceIntentFile), "utf8"), rawIntent);
        available = false;
        return rawPrepare;
      },
    }), /missing_current_admission/);
    assert.deepEqual(await readdir(interrupted), [web2DanceIntentFile]);
    assert.equal(await readFile(join(interrupted, web2DanceIntentFile), "utf8"), rawIntent);
  });

  await t.test("private Prepare rejects forward and ambient credentials before touching the app", async () => {
    const forward = "a".repeat(64), reverse = "b".repeat(64);
    let dbReads = 0;
    const env = {
      PUBLICATION_OPERATOR_HOST_AUTH: forward, PUBLICATION_RETAINED_LOOKUP_AUTH: reverse,
      COMMUNITY_DEPLOYMENT_PROFILE_JSON: JSON.stringify(draft.deployment),
      get DB(): D1Database { dbReads++; throw Error("private_d1_must_not_be_opened"); },
    };
    const endpoint = draft.origin + publicationLookupPath;
    const req = (url: string, authorization?: string, extra: Record<string, string> = {}) => new Request(url, {
      method: "POST", headers: { "content-type": web2DancePrepareContentType,
        ...(authorization ? { authorization: "Bearer " + authorization } : {}), ...extra },
      body: "not-an-intent",
    });
    for (const request of [req(endpoint), req(endpoint, forward), req(endpoint + "?owner=1", reverse),
      req(endpoint, reverse, { "X-Pirate-Native-Request": "ambient-native-role" }),
      req(endpoint, reverse, { [publicationAcceptSessionHeader]: word(111) })]) {
      assert.equal((await nativePublicationLookupFetch(request, env)).status, 404);
    }
    assert.equal(dbReads, 0);
    // A valid directional credential alone still cannot select an unsigned
    // original, D1 mount or fallback transport.
    assert.equal((await nativePublicationLookupFetch(req(endpoint, reverse), env)).status, 503);
  });

  await t.test("grant-free serving then a retained scope boot projection keeps the same signed enrollment and stores", async t => {
    const directory = await mkdtemp(join(tmpdir(), "web2-dance-scope-boot-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, "database"), objects = join(directory, "objects");
    async function openStores() {
      const runtime = new Miniflare({
        name: "dance-retained-scope-reopen", modules: true, compatibilityDate: "2026-08-06",
        script: "export default {fetch(){return new Response(null,{status:404})}}",
        d1Databases: { DB: "dance-retained-d1" }, r2Buckets: { MEDIA: "dance-retained-media" },
        d1Persist: database, r2Persist: objects,
      });
      let disposing: Promise<void> | undefined;
      const close = () => disposing ??= runtime.dispose();
      t.after(close);
      return { ...await runtime.getBindings<{ DB: D1Database; MEDIA: R2Bucket }>(), close };
    }
    const application = await openStores();
    await migrateOwnerDatabase(application.DB,
      nativeMigrationNames.map(name => "apps/community-wizard/infra/migrations/" + name));
    await application.DB.batch(nativeBusinessTransition(application.DB,
      await readFile(new URL("../packages/community/native-business.sql", import.meta.url), "utf8")));
    const enrolled = nativeCanonical(original);
    assert.equal(await initializeWeb2NativeOriginal(application.DB, enrolled), nativeDigest(original));
    const mediaKey = "retained-test-original";
    await application.MEDIA.put(mediaKey, "same fixture media");

    const releaseRoot = join(directory, "release"), publicationDirectory = join(directory, "publication-transport");
    const graph: NativeGraph = {
      installationId: plan.installationId, durableScope: plan.durableScope, releaseRoot,
      schemaPath: join(releaseRoot, "workerd.capnp"), stateRoots: {
        configuration: directory, database, objects,
        jobs: join(directory, "jobs"), scheduler: join(directory, "scheduler"), readiness: join(directory, "readiness"),
      },
      socket: join(directory, "control.sock"), localActivitySocket: join(directory, "activities.sock"), actors: [],
      requiredRoles: ["application"], queueConfiguration: { scope: plan.durableScope },
      maintenanceConfiguration: { scope: plan.durableScope }, directoryRuntimeBinding: JSON.stringify(draft.deployment),
      allowedOrigins: ["https://rpc.fixture.test"],
      fixtureTransport: { schema: "pirate.linux-local-fixture-transport/1", peer: "10.0.0.1",
        routes: [{ origin: "https://rpc.fixture.test", upstream: "http://10.0.0.1:8888/fixture/rpc" }] },
      nativePublication: { schema: "pirate.web2-native-publication-transport/1", directory: publicationDirectory,
        transportRef: mount.transportRef, issuerCapabilityRef: mount.issuerCapabilityRef,
        issuerAddress: mount.issuerAddress, operatorAddress: config.publisher },
      publicationExpansion: "registry-revision-two/1", danceRewardIntent: intent,
      applicationBindings: [
        { name: "WEB2_DANCE_REWARD_ATTACHMENT_JSON", file: join(directory, "dance-rewards/dance-reward-attachment.json") },
        { name: web2DanceScopeBinding, file: join(directory, web2DanceScopeFile) },
      ],
      secretBindings: [], listenAddress: "127.0.0.1:8443",
      tls: { keyFile: join(directory, "tls.key"), certificateFile: join(directory, "tls.pem") },
      migrationPlanFile: join(releaseRoot, "migration-plan.json"), probePlanFile: join(directory, "probe.json"),
      readbackKeyFile: join(directory, "readback.key"),
    };
    const locators = danceActivationPaths(graph);
    assert(locators);
    const installationFile = join(directory, "web2-original.json");
    const planBytes = JSON.stringify(original.record) + "\n";
    await writeFile(installationFile, planBytes, { mode: 0o600 });
    const selected = { original, graph, publicationMount: publicationMountJson, approval: {
      approvalSha256: attachment.approvalSha256, selectionSha256: attachment.selectionSha256, configuration: config,
      selection: { active: releaseSelectionHash }, ownerWallet: owner.wallet,
    } };
    const firstBoot = async () => {
      assert.equal(await readWeb2DanceActivation(selected), undefined);
      const rendered = renderFullNativeConfig(graph, "serve", "1".repeat(64));
      assert(!rendered.includes(web2DanceScopeBinding));
    };
    await firstBoot();
    await assert.rejects(readFile(locators.scope), { code: "ENOENT" });

    await t.test("public rev2 can mount signed Rewards alone and final exact scope without fixture authority", async t => {
      const publicState = await mkdtemp(join(await realpath(tmpdir()), "web2-public-dance-boot-"));
      let closeControl: (() => Promise<void>) | undefined;
      let closeStore: (() => Promise<void>) | undefined;
      t.after(async () => {
        try {
          await closeStore?.();
        } finally {
          try {
            await closeControl?.();
          } finally {
            await rm(publicState, { recursive: true, force: true });
          }
        }
      });
      const { fixtureTransport, ...base } = graph;
      const transport = { ...graph.nativePublication!, directory: join(publicState, "publication-transport"), issuerAddress: address(199) };
      const publicGraph: NativeGraph = {
        ...base, nativePublication: transport, publicationExpansion: trustedRevisionTwo, localActivitySocket: "/run/public-dance.sock",
        stateRoots: { ...graph.stateRoots, configuration: publicState },
        applicationBindings: [
          { name: web2DanceRewardBinding, file: join(publicState, "dance-rewards", web2DanceRewardFile + ".json") },
          { name: web2DanceScopeBinding, file: join(publicState, web2DanceScopeFile) },
        ],
      };
      const paths = danceActivationPaths(publicGraph);
      assert(paths && paths.mode === "trusted-public");
      assert.throws(() => danceActivationPaths({ ...publicGraph, fixtureTransport }), /web2_dance_activation_original_mount_required/);
      assert.throws(() => danceActivationPaths({ ...publicGraph, applicationBindings: publicGraph.applicationBindings.slice(0, 1) }),
        /web2_public_dance_scope_locator_required/);
      const file = "/run/public-dance-boot/web2-original.json";
      const renderedDormant = renderFullNativeConfig(publicGraph, "serve", "1".repeat(64), file);
      assert.doesNotMatch(renderedDormant, /WEB2_DANCE_REWARD_ATTACHMENT_JSON|WEB2_DANCE_RETAINED_SCOPE_JSON|PUBLICATION_NATIVE_MOUNT_JSON/);
      const consent = { selector: "/run/public-dance-boot/trusted-publication-mount.json",
        initialization: "/run/public-dance-boot/trusted-publication-initialization.json", expiresAtMs: Date.now() + 60000 };
      const snapshot = { directory: "/run/public-dance-boot", reward: "/run/public-dance-boot/" + web2DanceRewardFile + ".json" };
      assert.throws(() => renderFullNativeConfig(publicGraph, "serve", "1".repeat(64), file,
        publicGraph.socket, false, undefined, snapshot), /web2_dance_activation_boot_snapshot_required/);
      const rewardsOnly = renderFullNativeConfig(publicGraph, "serve", "2".repeat(64), file,
        publicGraph.socket, false, consent, snapshot);
      assert(rewardsOnly.includes('(name="' + web2DanceRewardBinding + '",text=embed "' + snapshot.reward + '")'));
      assert(!rewardsOnly.includes(web2DanceScopeBinding));
      assert(!rewardsOnly.includes(paths.reward));
      const initialize = renderFullNativeConfig(publicGraph, "initialize", undefined, file, publicGraph.socket, true, consent);
      assert.doesNotMatch(initialize, /WEB2_DANCE_REWARD_ATTACHMENT_JSON|WEB2_DANCE_RETAINED_SCOPE_JSON/);
      const scopeSnapshot = { ...snapshot, scope: join(snapshot.directory, web2DanceScopeFile) };
      assert(renderFullNativeConfig(publicGraph, "serve", "3".repeat(64), file, publicGraph.socket, false, consent, scopeSnapshot)
        .includes('(name="' + web2DanceScopeBinding + '",text=embed "' + scopeSnapshot.scope + '")'));

      const { release: scripted } = scriptedPublicationAuthority("https://policies.example", authority.now(),
        { issuer: transport.issuerAddress, operator: config.publisher });
      const pubRelease: PublicationAppRelease = {
        ...scripted, profile: directoryProfile, configuration: config,
        source: { ...scripted.source, chainId: directoryProfile.chainId, communityId: directoryProfile.communityId,
          installationId: directoryProfile.installationId, directory: directoryProfile.directory,
          directoryRuntimeHash: directoryProfile.directoryCodeHash, registry: source.pin.consentRegistry,
          registryRuntimeHash: source.pin.consentRegistryRuntimeHash },
        fee: { ...scripted.fee, chainId: directoryProfile.chainId },
        policies: {
          "dance-verdict": { ...scripted.policies["dance-verdict"]!, target: domain.verifier,
            runtimeHash: source.pin.runtimeCodeHash, policyHash: source.pin.learnerConsentPolicyHash },
          "dance-review-attribution": { ...scripted.policies["dance-review-attribution"]!, target: domain.verifier,
            runtimeHash: source.pin.runtimeCodeHash, policyHash: source.pin.reviewerConsentPolicyHash },
        },
      };
      const selected: Web2DancePublicationApproval["selection"] = {
        schema: "pirate.publication-installation/1", communityId: config.communityId, installationId: config.installationId,
        origin: draft.origin, installedBindingSha256: `0x${nativeDigest(original)}`, incarnation: "1", previous: null,
        active: publicationSelectionHash(pubRelease), entries: [{ release: pubRelease, transportRef: transport.transportRef }],
      };
      const approval: Web2DancePublicationApproval = {
        approvalSha256: attachment.approvalSha256, selectionSha256: protocolDigest(selected), selection: selected,
        configuration: config, ownerWallet: owner.wallet, publicGenesisHash: word(221),
      };
      const publicMount = canonical(sign({ ...mount, issuerAddress: transport.issuerAddress,
        mount: { ...mount.mount, selectionSha256: approval.selectionSha256 } }));
      const publicRewards = { ...attachment, selectionSha256: approval.selectionSha256 };
      const rewardRaw = canonical(sign(publicRewards));
      const scoped = { ...doc, selectionSha256: approval.selectionSha256, releaseSelectionHash: selected.active,
        attachmentDigest: `0x${nativeDigest(sign(publicRewards))}` };
      const crossWiredScope = canonical(sign(scoped));
      const publicInput = { graph: publicGraph, original, approval, publicationMount: publicMount };
      const read = (approved = approval) => readTrustedPublicDanceArtifacts({ ...publicInput, approval: approved });
      assert.equal(await read(), undefined);
      await writeFile(paths.scope, crossWiredScope, { mode: 0o600 });
      await assert.rejects(read(), /web2_dance_reward_attachment_required/);
      await rm(paths.scope);
      await mkdir(join(publicState, "dance-rewards"), { mode: 0o700 });
      await writeFile(paths.reward, rewardRaw, { mode: 0o600 });
      const only = await read();
      assert(only && only.reward === rewardRaw && only.scope === undefined);
      const wrong = structuredClone(pubRelease);
      wrong.policies["dance-review-attribution"]!.policyHash = word(219);
      await assert.rejects(read({ ...approval, selection: { ...selected, active: publicationSelectionHash(wrong),
        entries: [{ release: wrong, transportRef: transport.transportRef }] } }), /web2_dance_reward_publication_source_changed/);
      await assert.rejects(read({ ...approval, approvalSha256: "a".repeat(64) }), /web2_dance_reward_approved_original_changed/);
      await t.test("public reward read detects invalid UTF-8 and growth after the first FD stat", async t => {
        const reward = () => readWeb2DanceRewardApproval(publicGraph, original, approval);
        const expected = nativeDigest(sign(publicRewards));
        assert.equal(await reward(), expected);
        await writeFile(paths.reward, Buffer.concat([Buffer.from(rewardRaw), Buffer.from([0xff])]));
        await assert.rejects(reward(), TypeError);
        await writeFile(paths.reward, rewardRaw);

        const marker = await open(paths.reward, "r");
        const filePrototype: FileHandle = Object.getPrototypeOf(marker);
        const originalRead = filePrototype.read;
        await marker.close();
        let grew = false;
        const spy = t.mock.method(filePrototype, "read", async function (this: FileHandle, ...args: unknown[]) {
          if (!grew && await readlink("/proc/self/fd/" + this.fd) === paths.reward) {
            grew = true;
            await appendFile(paths.reward, Buffer.alloc(256 * 1024, 0x20));
          }
          return Reflect.apply(originalRead, this, args);
        });
        try {
          await assert.rejects(reward(), /web2_dance_activation_file_changed/);
          assert(grew);
        } finally {
          spy.mock.restore();
          await writeFile(paths.reward, rewardRaw);
        }
        assert.equal(await reward(), expected);
      });

      assert(selected.active);
      const prepareIntent: InstalledDanceBindIntent = {
        schema: "pirate.installed-dance-bind-intent/1", intentId: word(220),
        installedBindingSha256: `0x${nativeDigest(original)}`, communityId: domain.communityId,
        installationId: config.installationId, releaseSha256: selected.active, configurationSha256: hashJson(config),
        sourceHash: source.sourceHash, ownerEpoch: owner.epoch, ownerWallet: owner.wallet,
        grants: [
          { purpose: "dance-verdict", commandId: word(95), accountId: learner.plan.accountId },
          { purpose: "dance-review-attribution", commandId: word(96), accountId: reviewer.plan.accountId },
        ],
      };
      const intentSha256 = protocolDigest(prepareIntent);
      const intentRaw = canonical(sign(prepareIntent));
      const publicationSource = publicationSelectionSource(pubRelease);
      const grants = await Promise.all(prepareIntent.grants.map(async (item, position) => {
        const grantId = word(225 + position);
        const commandId = protocolDigest({ schema: "pirate.installed-dance-bind-command/1", intentSha256,
          position, appCommandId: item.commandId, grantId });
        const original = await originalBinding(position, commandId);
        const { plan } = original;
        const accountCommitment = danceAccountCommitment(domain, plan.accountId, plan.wallet);
        const command = danceCommand(domain, "bindIdentity", config.publisher, commandId, {
          expectedOwnerEpoch: 1n, expectedConfigurationRevision: 2n, accountCommitment, wallet: plan.wallet,
          expectedIdentityEpoch: 0n, sourceGroupId: zeroHash, sourceBindingGroupEpoch: 0n, sourceCurrentGroupEpoch: 0n,
          destinationGroupId: danceSingletonId(domain, accountCommitment), destinationGroupEpoch: 0n, createSingleton: true, active: true,
        });
        assert.equal(parseTransaction(original.raw).data, command.data);
        const receipt: ObservedDanceGrant["receipt"] = {
          schema: "pirate.publication-command-receipt/1", commandId: item.commandId, digest: grantId,
          action: "grant", purpose: item.purpose, source: publicationSource, state: "recorded",
          transactionHash: word(227 + position), transactionIndex: position,
          observed: { blockNumber: "10", blockHash: word(229), timestampS: "120" },
        };
        return { original, observed: { command: {
          action: "grant" as const, commandId: item.commandId, digest: grantId, message: { purpose: item.purpose },
        }, receipt }, plan: {
          purpose: item.purpose, appGrantCommandId: item.commandId, grantId, grantReceiptSha256: protocolDigest(receipt),
          plan: { ...plan, ownerEpoch: String(plan.ownerEpoch), configurationRevision: String(plan.configurationRevision) },
          command,
        }};
      }));
      const resultRaw = canonical({ schema: "pirate.installed-dance-bind-prepare/1", intentSha256, plans: grants.map(g => g.plan) });
      const intentPath = join(paths.directory, web2DanceIntentFile), resultPath = join(paths.directory, web2DancePrepareFile);
      const custodyRoot = join(publicState, "stage-owner"), composerPath = join(publicState, "composer");
      await mkdir(custodyRoot, { mode: 0o700 });
      await mkdir(composerPath, { mode: 0o700 });
      const control = await acquireWeb2ServiceControl(custodyRoot, plan.installationId);
      closeControl = () => control.closeControl();
      const storePath = join(publicState, "operator.sqlite");
      const scopeIdentity: Web2PublicDanceCustody["scope"] = {
        chainId: 6343, communityId: domain.communityId, installationId: config.installationId,
        releaseSha256: selected.active, publisher: config.publisher, verifier: domain.verifier, sourceHash: source.sourceHash,
      };
      const readIdentity = async (path: string) => {
        const physical = await stat(path, { bigint: true });
        return { device: String(physical.dev), inode: String(physical.ino) };
      };
      const journalId = word(230), genesisHash = word(221);
      const seed = operatorDatabase(storePath, Number(authority.now()));
      try {
        seed.store.set("publicationOperatorIdentity:v1", { schema: "pirate.local-publication-operator-journal/1",
          journalId, chainId: 6343, genesisHash, communityId: domain.communityId,
          installationId: config.installationId, publisher: config.publisher });
      } finally {
        seed.close();
      }
      await chmod(storePath, 0o600);
      const storeIdentity = { path: storePath, ...await readIdentity(storePath), journalId };
      const databaseBeforeStage = await readFile(storePath);
      const database = await openPinnedNativeDanceOperatorStore({
        identity: storeIdentity, lease: control.lease, readOnly: true,
      });
      closeStore = () => database.close();
      assert.notEqual(database.store, seed.store);
      const directoryIdentity = await readIdentity(composerPath);
      const composerRunId = "retained-run";
      const composerIntent = canonical({ runId: composerRunId, genesisHash, nativeOriginalSha256: nativeDigest(original),
        publisher: scopeIdentity.publisher, localOnly: false });
      await writeFile(join(composerPath, "selection-intent.json"), composerIntent, { mode: 0o600 });
      const retainedDance = await createNativeDanceRetainedStore({ store: database.store, storeIdentity,
        journalDirectory: composerPath, directoryIdentity, runId: composerRunId,
        genesisHash, scope: scopeIdentity, assertCustody: () => control.lease.assertHeld() });
      const beforeGrantProof = Error("test stopped at the independent application grant proof");
      let approvals = 0, appReads = 0, stageScope = crossWiredScope;
      const stage = (lease = control.lease) => stageWeb2DanceActivation({ ...publicInput, chain: authority, lease,
        assertCurrent: () => lease.assertHeld(), owner: {
          publicCustody: { lease, operatorStore: database.store, retainedDance },
          async approvedScope() { approvals++; return stageScope; },
          async observedAppGrants() { appReads++; throw beforeGrantProof; },
        },
      });
      await assert.rejects(stage(), /web2_public_dance_prepare_required/);
      assert.equal(approvals, 1);
      assert.equal(appReads, 0);
      await assert.rejects(readFile(paths.scope), { code: "ENOENT" });
      await writeFile(paths.scope, crossWiredScope, { mode: 0o600 });
      await assert.rejects(read(), /web2_public_dance_prepare_required/);
      await writeFile(intentPath, intentRaw, { mode: 0o600 });
      await assert.rejects(read(), /web2_public_dance_prepare_required/);
      await writeFile(resultPath, resultRaw, { mode: 0o600 });
      await assert.rejects(stage(), /web2_public_dance_prepare_binding_changed/);
      assert.equal(appReads, 0);
      await assert.rejects(read(), /web2_public_dance_prepare_binding_changed/);
      const prepare = await readRetainedWeb2DanceBindPrepare({ original, source, directory: paths.directory,
        approved: { releaseSha256: selected.active, configurationSha256: hashJson(config), ownerWallet: owner.wallet,
          publisher: config.publisher, configurationRevision: config.configurationRevision } });
      const observed = grants.map(g => g.observed);
      assertPublicDancePreparedGrants(prepare.prepared, observed);
      assert.throws(() => assertPublicDancePreparedGrants(prepare.prepared, observed.toReversed()), /web2_public_dance_prepare_grant_changed/);
      assert.throws(() => assertPublicDancePreparedGrants(prepare.prepared, [
        { ...observed[0]!, receipt: { ...observed[0]!.receipt, transactionHash: word(235) } }, observed[1]!,
      ]), /web2_public_dance_prepare_grant_changed/);
      assert.throws(() => assertPublicDancePreparedGrants(prepare.prepared, [
        { ...observed[0]!, command: { ...observed[0]!.command, digest: word(236) } }, observed[1]!,
      ]), /web2_public_dance_prepare_grant_changed/);

      const scopeRaw = canonical(sign({ ...scoped, grants: [
        web2DanceRetainedPeer("dance-verdict", word(95), grants[0]!.original),
        web2DanceRetainedPeer("dance-review-attribution", word(96), grants[1]!.original),
      ] }));
      await writeFile(paths.scope, scopeRaw);
      await assert.rejects(read(), /web2_public_dance_custody_required/);
      const custody: Web2PublicDanceCustody = {
        schema: "pirate.public-web2-dance-custody/1", nativeOriginalSha256: nativeDigest(original), hostInstallationId: plan.installationId,
        approvalSha256: approval.approvalSha256, selectionSha256: approval.selectionSha256, rewardSha256: nativeDigest(sign(publicRewards)),
        scopeSha256: hashText(scopeRaw).slice(2), prepareIntentSha256: hashText(intentRaw).slice(2), prepareResultSha256: hashText(resultRaw).slice(2),
        scope: scopeIdentity,
        store: storeIdentity,
        composer: { path: composerPath, ...directoryIdentity, runId: composerRunId,
          genesisHash, intentSha256: hashText(composerIntent).slice(2) },
      };
      const nominee = join(paths.directory, web2PublicDanceCustodyFile);
      const staged = join(paths.directory, web2PublicDanceStagedCustodyFile);
      const custodyRaw = canonical(sign(custody));
      await writeFile(nominee, custodyRaw, { mode: 0o600 });
      await assert.rejects(read(), /web2_public_dance_staged_custody_changed/);
      await rm(paths.scope);
      stageScope = scopeRaw;
      const otherControl = await acquireWeb2ServiceControl(await mkdtemp(join(publicState, "other-stage-owner-")),
        control.lease.installationId);
      try {
        assert.notEqual(otherControl.lease, control.lease);
        assert.equal(otherControl.lease.installationId, control.lease.installationId);
        await control.lease.assertHeld();
        await otherControl.lease.assertHeld();
        await assert.rejects(stage(otherControl.lease), /native_dance_connected_store_lease_changed/);
        assert.equal(appReads, 0);
        await assert.rejects(readFile(paths.scope), { code: "ENOENT" });
        await assert.rejects(readFile(staged), { code: "ENOENT" });
      } finally {
        await otherControl.closeControl();
      }
      await assert.rejects(stage(), error => error === beforeGrantProof);
      assert.equal(appReads, 1);
      assert.deepEqual(await readFile(storePath), databaseBeforeStage);
      await assert.rejects(readFile(paths.scope), { code: "ENOENT" });
      await assert.rejects(readFile(staged), { code: "ENOENT" });
      await writeFile(staged, custodyRaw, { mode: 0o600 });
      await writeFile(paths.scope, scopeRaw, { mode: 0o600 });
      const complete = await read();
      assert(complete?.scope === scopeRaw && complete.custody.record.scope.releaseSha256 === selected.active);
      assert.equal(complete.scopeSha256, hashText(scopeRaw).slice(2));
      assert.equal(complete.custody.recordSha256, hashText(custodyRaw).slice(2));
      await writeFile(nominee, canonical(sign({ ...custody, store: { ...custody.store, inode: "35" } })));
      await assert.rejects(read(), /web2_public_dance_staged_custody_changed/);
      assert.equal(await readFile(staged, "utf8"), custodyRaw);
    });

    await t.test("Dance owner intake refuses missing current admission without repairing the bound original", async t => {
      const controlDirectory = join(directory, "owner-control"), maintenanceDirectory = join(directory, "maintenance");
      const nativeRuntimeDirectory = join(directory, "run");
      for (const selected of [controlDirectory, maintenanceDirectory, nativeRuntimeDirectory])
        await mkdir(selected, { mode: 0o700 });
      const control = await acquireWeb2ServiceControl(controlDirectory, plan.installationId);
      t.after(() => control.closeControl());
      const nowMs = Date.now();
      const admission: Web2HostAdmission = {
        schema: "pirate.linux-web2-host-admission/1", installationId: plan.installationId,
        directoryInstallationId: draft.enrollment.installationId, communityId: draft.enrollment.communityId,
        generation: plan.generation, issuedAt: nowMs - 100, expiresAt: nowMs + 30000,
        hostFingerprint: plan.hostFingerprint, releaseArtifactDigest: plan.releaseArtifactDigest,
        targetDigest: plan.targetDigest, draftDigest: canonicalDigest(draft), revokedPlanIds: [],
      };
      // Only signed control records are under test. The inert release
      // inventory cannot qualify a native process or an installed backend.
      const release: FullRelease = {
        schema: "pirate.complete-linux-web2-release/1", graph, root: releaseRoot, sourceRoot: join(releaseRoot, "source"),
        artifactDigest: plan.releaseArtifactDigest, sourceDigest: plan.releaseSourceDigest,
        imageId: "sha256:" + "1".repeat(64), sourceHead: "2".repeat(40), sourceTree: "3".repeat(40),
        files: {}, sourceHashes: {}, requiredRoles: graph.requiredRoles,
        execution: { node: "toolchain/node", nodeSha256: "4".repeat(64), nodeVersion: "v24.18.1",
          loader: "toolchain/node_modules/tsx/dist/loader.mjs", tsxVersion: "4.20.6", backend: "source/backend.ts" },
      };
      const bound = {
        schema: "pirate.web2-bound-runtime/1" as const,
        intent: { schema: "pirate.web2-runtime-binding-intent/1" as const, bootstrapDigest: "5".repeat(64),
          policyDigest: "6".repeat(64), draft, release, admission },
        release: sign(release), applicationRelease: original.release, admission: sign(admission),
      };
      const route = join(directory, "web2-host-admission.json"), intentPath = join(directory, "web2-binding-intent.json");
      const records = {
        "web2-binding-intent": bound.intent, "web2-bound-runtime": bound,
        "web2-start-intent": web2OriginalStartIntent(original.record.body),
        "web2-launch": { schema: "pirate.linux-web2-launch/1", release: bound.release,
          applicationRelease: original.release, trust, currentAdmissionFile: route,
          minimumGeneration: plan.generation, privateRuntimeDirectory: nativeRuntimeDirectory, maintenanceDirectory },
      };
      const bytes = (value: unknown) => JSON.stringify(value) + "\n";
      for (const [name, value] of Object.entries(records))
        await writeFile(join(directory, name + ".json"), bytes(value), { mode: 0o600, flag: "wx" });
      const admitted = {
        directory, bound, maintenanceDirectory, nativeRuntimeDirectory, registrationAuthority: plan.registrationAuthority,
        lease: control.lease, live() { assert(Date.now() < admission.expiresAt); },
        admission: { ...admission, path: route, trust, now: Date.now, draft, minimumGeneration: plan.generation },
      };
      async function snapshot() {
        const paths = (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name));
        return Promise.all(paths.map(async row => {
          if (!row.isFile()) return [row.name, row.isDirectory() ? "directory" : "other"];
          const path = join(directory, row.name), info = await stat(path, { bigint: true });
          return [row.name, info.ino, info.mtimeNs, info.ctimeNs, await readFile(path, "utf8")];
        }));
      }
      const before = await snapshot();
      await assert.rejects(readRetainedWeb2DanceControl(admitted), { code: "ENOENT", path: route });
      assert.deepEqual(await snapshot(), before);
      await assert.rejects(readFile(locators.scope), { code: "ENOENT" });

      // The very same post-authentication record recovery used by normal
      // binder reentry still finishes the interrupted original bind.
      await recoverWeb2BindingControlRecords(admitted);
      assert.equal(await readFile(route, "utf8"), bytes(bound.admission));
      const resumed = await snapshot();
      const checkRetained = await readRetainedWeb2DanceControl(admitted);
      await checkRetained();
      assert.deepEqual(await snapshot(), resumed);
      await rm(route);
      const missingAgain = await snapshot();
      await assert.rejects(checkRetained(), { code: "ENOENT", path: route });
      assert.deepEqual(await snapshot(), missingAgain);

      const revoked = bytes(sign({ ...admission, generation: 2, revokedPlanIds: [plan.planId] }));
      await writeFile(route, revoked, { mode: 0o600, flag: "wx" });
      await assert.rejects(checkRetained(), /web2_install_plan_revoked/);
      assert.equal(await readFile(route, "utf8"), revoked);
      const later = bytes(sign({ ...admission, generation: 2 }));
      await writeFile(route, later);
      await rm(intentPath);
      const missingIntent = await snapshot();
      await assert.rejects(readRetainedWeb2DanceControl(admitted), { code: "ENOENT", path: intentPath });
      assert.deepEqual(await snapshot(), missingIntent);
      await recoverWeb2BindingControlRecords(admitted);
      assert.equal(await readFile(intentPath, "utf8"), bytes(bound.intent));
      assert.equal(await readFile(route, "utf8"), later);
      await checkRetained();
      await assert.rejects(readFile(locators.scope), { code: "ENOENT" });
      assert.equal(await readFile(installationFile, "utf8"), planBytes);
    });

    // The signed codec fixture is sufficient to test boot materialization.
    // Actual staging also requires live grants and canonical BindIdentity receipts.
    await mkdir(join(directory, "dance-rewards"), { mode: 0o700 });
    await writeFile(locators.reward, attachmentJson, { mode: 0o600 });
    await writeFile(locators.scope, Buffer.from([0xff]), { mode: 0o600 });
    await assert.rejects(readWeb2DanceActivation(selected), TypeError);
    await writeFile(locators.scope, canonical(sign(doc)) + "\n");
    await assert.rejects(readWeb2DanceActivation(selected), /web2_dance_retained_scope_not_canonical/);
    const rawScope = canonical(sign(doc));
    await writeFile(locators.scope, rawScope);
    const approved = await readWeb2DanceActivation(selected);
    assert(approved && approved.scope === rawScope);
    const bootDirectory = join(directory, "boot-successor");
    await mkdir(bootDirectory, { mode: 0o700 });
    const snapshot = { directory: bootDirectory, scope: join(bootDirectory, web2DanceScopeFile) };
    await writeFile(snapshot.scope, approved.scope, { mode: 0o600 });
    const next = renderFullNativeConfig(graph, "serve", "2".repeat(64), undefined, graph.socket, false, undefined, snapshot);
    assert(next.includes('(name="' + web2DanceScopeBinding + '",text=embed "' + snapshot.scope + '")'));
    assert(!next.includes('text=embed "' + locators.scope + '"'));
    assert(!renderFullNativeConfig(graph, "initialize").includes(web2DanceScopeBinding));

    // Reopen the persistence directories in a second runtime before making
    // any writes. A copied or reinitialized database would fail this read.
    await application.close();
    const reopened = await openStores();
    const retained = () => reopened.DB.prepare(
      "SELECT original_digest, original_json FROM native_application_original WHERE singleton=1",
    ).first<{ original_digest: string; original_json: string }>();
    const expected = { original_digest: nativeDigest(original), original_json: enrolled };
    assert.deepEqual(await retained(), expected);
    const retainedMedia = await reopened.MEDIA.get(mediaKey);
    assert(retainedMedia);
    assert.equal(await retainedMedia.text(), "same fixture media");
    assert.equal(await initializeWeb2NativeOriginal(reopened.DB, enrolled), nativeDigest(original));
    assert.deepEqual(await retained(), expected);
    assert.equal(await readFile(installationFile, "utf8"), planBytes);
  });

});
