import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Address } from "viem";
import type { InstalledTarget } from "../deploy/linux/local-target-controller.ts";
import type { FullRelease } from "../deploy/linux/installed-release.ts";
import type { NativeGraph } from "../deploy/linux/full-native-config.ts";
import { canonicalDigest, readPrivateJSON, signRecord } from "../deploy/linux/installed-records.ts";
import type { PublicIngress } from "../deploy/linux/public-ingress.ts";
import { expandedPublicationApprovalExists, readApprovedExpandedPublication, readApprovedWeb2Transition } from "../deploy/linux/web2-expanded-publication.ts";
import { authenticateWeb2Enrollment, readWeb2HostAdmission, web2TargetDigest, type Web2HostAdmission, type Web2InstallPlan } from "../deploy/linux/web2-profile-authority.ts";
import type { Web2RuntimeBindingPolicy } from "../deploy/linux/web2-runtime-binding.ts";
import {
  assertTrustedRevisionTwoTarget, readApprovedTrustedRevisionTwo, readTrustedRevisionTwoPolicy,
  requireTrustedRevisionTwoResources, trustedRevisionTwo, trustedRevisionTwoPolicyName, web2OriginalStartIntent,
  trustedRevisionTwoApprovalPath, type Web2TrustedRevisionTwoApproval,
} from "../deploy/linux/web2-trusted-revision-two.ts";
import { acquireWeb2ServiceControl } from "../deploy/linux/web2-service-lease.ts";
import {
  retainTrustedRevisionOneServingWitness, trustedRevisionOneResourceDigest, writeTrustedRevisionTwoApproval,
} from "../deploy/linux/web2-trusted-revision-two-producer.ts";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { nativeDigest } from "../packages/community/native-business-binding.ts";
import { nativeBusinessTransition } from "../packages/community/native-business-transition.ts";
import type { OwnerAuthorization } from "../packages/community/owner-authorization-typed-data.ts";
import { initializeWeb2NativeOriginal, web2ApplicationReleaseBody, type Web2NativeOriginal } from "../packages/community/web2-native-business-binding.ts";
import { ownerGrantDigest, validateOwnerGrant } from "../packages/release/owner-grant.ts";
import { nativeProducerFixture } from "./application-native-producer-fixture.ts";
import { installationAuthorityFixture } from "./fixtures/linux-web2-installation.ts";
import { web2Controller, web2Owner, web2OwnerAuthorizationData } from "./fixtures/web2-first-song-chain.ts";

test("trusted revision two holds without signed proof and reopens the same initialized original", { timeout: 120_000 }, async t => {
  const fixture = await installationAuthorityFixture();
  t.after(fixture.close);
  const root = await mkdtemp(join(tmpdir(), "web2-trusted-revision-two-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { authority, chain, draft } = fixture;
  const enrollment = await authenticateWeb2Enrollment(authority, draft);
  const now = Number(authority.now());
  const installationId = "trusted-revision-two-test";
  const originalGrant = {
    schema: "pirate.owner-publishing-grant/1" as const, sha256: "0x" + "0".repeat(64),
    communityId: draft.enrollment.communityId, communityOrigin: draft.origin,
    ownerWallet: web2Owner.address.toLowerCase() as Address, policy: draft.configuration.policies.admission,
    destination: { chainId: 6343, postsContract: draft.configuration.postsContract, publisher: draft.configuration.publisher },
    validFrom: now - 60, expiresAt: now + 900,
    limits: { songs: 1, pinAdds: 5, pinBytes: "1048576", recognitionRequests: 4, postFeeWei: "90000000000000" },
  };
  const grant = validateOwnerGrant({ ...originalGrant, sha256: ownerGrantDigest(originalGrant) });
  const authorization: OwnerAuthorization = {
    schema: "pirate.owner-publishing-authorization/2", communityId: grant.communityId,
    ownerWallet: grant.ownerWallet, policy: grant.policy, validFrom: grant.validFrom, expiresAt: grant.expiresAt,
  };
  const selection = {
    schema: "pirate.web2-configured-owner-grant/1", grant, admissionReference: "disposable-trusted-test",
    scope: {
      schema: "pirate.web2-owner-grant-scope/1",
      enrollmentId: draft.enrollment.enrollmentId, hostInstallationId: installationId,
      installationId: draft.enrollment.installationId, communityId: grant.communityId,
      deploymentDigest: hashJson(draft.deployment), origin: draft.origin, ownerWallet: grant.ownerWallet,
      controller: draft.configuration.controller, publisher: draft.configuration.publisher,
      postsContract: draft.configuration.postsContract, policy: grant.policy, chainId: 6343,
    },
  };
  const attachment = {
    schema: "pirate.web2-publishing-attachment/1",
    selection: { ...selection, selectionDigest: hashJson(selection) },
    authorization: {
      authorization,
      signature: await web2Controller.signTypedData(web2OwnerAuthorizationData(authorization, draft.configuration)),
    },
    custodyBindingDigest: hashText("fixture scoped publishing"),
  };
  const attachmentDigest = hashJson(attachment);
  const graph: NativeGraph = {
    publicationExpansion: trustedRevisionTwo, installationId, durableScope: "a".repeat(64),
    releaseRoot: join(root, "release"), schemaPath: join(root, "workerd.capnp"),
    stateRoots: { configuration: root, database: join(root, "database"), objects: join(root, "objects"),
      jobs: join(root, "jobs"), scheduler: join(root, "scheduler") },
    socket: join(root, "native.sock"), actors: [], requiredRoles: [], queueConfiguration: {},
    maintenanceConfiguration: {}, allowedOrigins: [], directoryRuntimeBinding: JSON.stringify(draft.deployment),
    applicationBindings: [
      { name: "WEB2_PUBLISHING_ATTACHMENT_JSON", text: JSON.stringify({ ...attachment, digest: attachmentDigest }) },
      { name: "WEB2_PUBLISHING_ATTACHMENT_SHA256", text: attachmentDigest },
    ],
    secretBindings: [], listenAddress: "127.0.0.1:8845", tls: { keyFile: join(root, "key"), certificateFile: join(root, "cert") },
    migrationPlanFile: join(root, "migration-plan.json"), probePlanFile: join(root, "probe.json"),
    readbackKeyFile: join(root, "readback.key"),
  };
  const ingress: PublicIngress = {
    schema: "pirate.linux-public-ingress/1", origin: draft.origin, upstream: "https://127.0.0.1:8845",
    upstreamServerName: "local.test", upstreamCaFile: join(root, "ca.pem"), upstreamCaSha256: "0".repeat(64),
    executable: join(root, "caddy"), executableSha256: "0".repeat(64), configurationFile: join(root, "Caddyfile"),
    dataDirectory: join(root, "ingress"), httpPort: 80, httpsPort: 443,
    tls: { kind: "public-acme", directory: "https://acme.example/directory", email: "operator@example.com" },
  };
  assertTrustedRevisionTwoTarget(graph, ingress);
  assert.throws(() => assertTrustedRevisionTwoTarget(graph, { ...ingress, tls: { kind: "local-fixture-ca" } }),
    /trusted_revision_two_public_acme_required/);
  const fixtureTransport: NativeGraph["fixtureTransport"] = {
    schema: "pirate.linux-local-fixture-transport/1", peer: "10.0.0.1", routes: [],
  };
  assert.throws(() => assertTrustedRevisionTwoTarget({ ...graph, fixtureTransport }, ingress),
    /trusted_revision_two_public_acme_required/);
  const artifactDigest = hashText("fixture complete release");
  const sourceDigest = hashText("fixture complete source");
  const nowHost = () => Number(authority.now()) * 1000;
  const nativeRuntimeDirectory = join(root, "run");
  const target: InstalledTarget = {
    installationId, daemonId: "test", docker: join(root, "docker"), dockerSha256: "c".repeat(64),
    socket: join(root, "docker.sock"), dockerConfig: join(root, "docker-config"), stateRoot: root,
    maintenanceDirectory: join(root, "maintenance"), resourceDirectory: join(root, "resources"),
    outputDirectory: root, cwd: root, environment: { HOME: root }, hostWriters: [],
    containers: ["app", "store"].map(key => ({
      key, name: key, imageId: "fixture-only", configurationDigest: "d".repeat(64), ingress: false,
      user: "1000", network: "fixture", argv: [], roles: [], mounts: [], ports: [],
    })),
    allowedReadOnlyRoots: [], allowedWritableRoots: [root],
  };
  const { directoryRuntimeBinding: _unbound, ...policyGraph } = graph;
  const policy: Web2RuntimeBindingPolicy = {
    schema: "pirate.web2-runtime-binding-policy/1", generation: 1,
    bootstrapArtifactDigest: artifactDigest, bootstrapSourceDigest: sourceDigest, installationId, origin: draft.origin,
    issuedAt: (now - 30) * 1000, expiresAt: (now + 600) * 1000, hostFingerprint: "test signed application identity only",
    graph: policyGraph, target, ingress, bindingDirectory: root, currentAdmissionFile: join(root, "web2-host-admission.json"), nativeRuntimeDirectory,
  };
  const plan: Web2InstallPlan = {
    schema: "pirate.linux-web2-install-plan/1", planId: "web2-" + draft.enrollment.enrollmentId.slice(2),
    installationId, durableScope: graph.durableScope, generation: 1, draft, enrollment,
    releaseArtifactDigest: artifactDigest, releaseSourceDigest: sourceDigest, publishingAttachmentDigest: attachmentDigest,
    targetDigest: web2TargetDigest(target, ingress, nativeRuntimeDirectory), hostFingerprint: policy.hostFingerprint,
    registrationAuthority: { registrar: authority.registrar, registrarRevision: String(authority.registrarRevision),
      maxSafeBlockAgeSeconds: String(authority.maxSafeBlockAgeSeconds) },
  };
  const key = generateKeyPairSync("ed25519");
  const trust = { keyId: "trusted-revision-two-disposable", spki: key.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  const sign = <T>(value: T) => signRecord(value, trust, key.privateKey.export({ type: "pkcs8", format: "der" }));
  const original: Web2NativeOriginal = {
    schema: "pirate.web2-native-application-original/1", durableScope: graph.durableScope, trust,
    record: sign(plan),
    release: sign(web2ApplicationReleaseBody({
      schema: "pirate.complete-linux-web2-release/1", artifactDigest, sourceDigest, graph,
    })),
  };
  const originalBytes = canonical(original);
  const directory = await nativeProducerFixture(false);
  t.after(directory.dispose);
  await directory.db.batch(nativeBusinessTransition(directory.db, await readFile("packages/community/native-business.sql", "utf8")));
  const originalDigest = await initializeWeb2NativeOriginal(directory.db, originalBytes);

  // The exact private boot handler must hold on an empty companion object
  // store, even though D1 already has the genuine original. No media repair
  // or numbered-ledger creation is part of revision-two startup.
  const bootstrapModule: string = "../deploy/linux/maintenance.bootstrap.mjs";
  const { default: boot } = await import(bootstrapModule);
  const coldGuardEnv = {
    DB: directory.db, MEDIA: directory.env.MEDIA, NATIVE_APPLICATION_ORIGINAL_JSON: originalBytes,
    WEB2_REQUIRE_RETAINED_STATE: "1",
    MIGRATION_PLAN_JSON: JSON.stringify({
      schema: "pirate.linux-migration-plan/1", qualificationOnly: true,
      releaseSha256: artifactDigest.slice(2), migrations: [],
    }),
  };
  await assert.rejects(boot.fetch(new Request("http://private/initialize", { method: "POST" }), coldGuardEnv),
    /Native object readback changed/);
  assert.equal(await directory.db.prepare("SELECT name FROM sqlite_schema WHERE name='_pirate_linux_migrations'").first(), null);
  assert.equal(await directory.env.MEDIA.get("_qualification/" + artifactDigest.slice(2)), null);

  const originalPath = join(root, "web2-original.json");
  const recordBytes = JSON.stringify(original.record) + "\n";
  await writeFile(originalPath, recordBytes, { mode: 0o600 });
  const release: FullRelease = {
    schema: "pirate.complete-linux-web2-release/1", graph, artifactDigest, sourceDigest,
    sourceHead: "a".repeat(40), sourceTree: "b".repeat(40), root: graph.releaseRoot, sourceRoot: join(graph.releaseRoot, "source"),
    execution: { node: "toolchain/node", nodeSha256: "c".repeat(64), nodeVersion: "v24.18.1",
      loader: "toolchain/node_modules/tsx/dist/loader.mjs", tsxVersion: "4.20.6", backend: "source/backend.ts" },
    files: {}, sourceHashes: {}, requiredRoles: [], imageId: "fixture-only",
  };
  const admission: Web2HostAdmission = {
    schema: "pirate.linux-web2-host-admission/1", installationId, directoryInstallationId: draft.enrollment.installationId,
    communityId: draft.enrollment.communityId, generation: 1, issuedAt: nowHost(), expiresAt: policy.expiresAt,
    targetDigest: plan.targetDigest, draftDigest: canonicalDigest(draft), releaseArtifactDigest: artifactDigest,
    hostFingerprint: policy.hostFingerprint, revokedPlanIds: [],
  };
  const signedPolicy = sign(policy);
  const originalRecords = new Map([
    [originalPath, recordBytes],
    [join(root, trustedRevisionTwoPolicyName + ".json"), JSON.stringify(signedPolicy) + "\n"],
    [join(root, "web2-bound-runtime.json"), JSON.stringify({
      schema: "pirate.web2-bound-runtime/1", intent: {
        schema: "pirate.web2-runtime-binding-intent/1", policyDigest: canonicalDigest(signedPolicy), release, admission,
      }, release: sign(release), applicationRelease: original.release, admission: sign(admission),
    }) + "\n"],
  ]);
  for (const [path, bytes] of originalRecords) await writeFile(path, bytes, { mode: 0o600 });
  const assertOriginals = async () => {
    for (const [path, bytes] of originalRecords) assert.equal(await readFile(path, "utf8"), bytes);
  };
  assert.equal(await expandedPublicationApprovalExists(graph), false);
  assert.equal((await authenticateWeb2Enrollment(authority, draft)).configurationRevision, 1);
  assert.deepEqual(await readTrustedRevisionTwoPolicy({ graph, original, now: nowHost, currentAdmissionFile: policy.currentAdmissionFile }), policy);
  const readFromLiveInstaller = () => readApprovedWeb2Transition({ graph, original, chain: authority, now: nowHost });

  const startPath = join(root, "web2-start-intent.json");
  const startBytes = JSON.stringify(web2OriginalStartIntent(plan)) + "\n";
  const witnessPath = join(root, "web2-trusted-revision-one-served.json");
  const resources = target.containers.map((spec, index) => ({ spec, actual: { Id: String(index + 1).repeat(64) } }));
  const witnessScope = {
    graph, original, policy, resourcesSha256: trustedRevisionOneResourceDigest(target.containers.length, resources),
  };
  await t.test("serving observation must still prove revision one before the witness is retained", async () => {
    await writeFile(startPath, startBytes, { mode: 0o600 });
    // The real installed invocation also requires the actual ACME serve and owned
    // container checks. This test drives the remaining guard with the real chain.
    await assert.rejects(retainTrustedRevisionOneServingWitness({
      ...witnessScope, async assertCurrent() { throw new Error("owned TLS observation unavailable"); },
    }), /owned TLS observation unavailable/);
    await assert.rejects(readFile(witnessPath), { code: "ENOENT" });
  });
  await retainTrustedRevisionOneServingWitness({
    ...witnessScope, assertCurrent: () => authenticateWeb2Enrollment(authority, draft),
  });
  const witnessBytes = await readFile(witnessPath, "utf8");
  await rm(witnessPath);

  // Requires the exact managed qualification fixture that performs a genuine
  // local Registry deployment and canonical Directory configure transaction.
  const revision = await chain.nextRevision("learning-registry");
  assert(revision?.safe.hash);
  const { transition, registry, registryRuntimeHash, genesisHash, configuration, safe } = revision;
  assert.equal(await expandedPublicationApprovalExists(graph), false);
  await assert.rejects(authenticateWeb2Enrollment(authority, draft), /install_current_authority_changed/);
  const input = { graph, original, chain: authority, now: nowHost };
  await assert.rejects(readApprovedTrustedRevisionTwo(input), { code: "ENOENT" });
  const approval: Web2TrustedRevisionTwoApproval = {
    schema: "pirate.web2-trusted-revision-two-approval/1", ownerWallet: originalGrant.ownerWallet,
    nativeOriginalSha256: nativeDigest(original), graphSha256: canonicalDigest(graph), configuration,
    configurationSha256: hashJson(configuration), genesisHash, registry, registryRuntimeHash,
    registrationTransactionHash: enrollment.transactionHash, registrationBlock: enrollment.registrationBlock,
    registrationBlockHash: enrollment.registrationBlockHash, transitionTransactionHash: transition.transactionHash,
    transitionBlock: String(transition.blockNumber), transitionBlockHash: transition.blockHash,
    safeBlock: String(safe.number), safeBlockHash: revision.safe.hash,
    issuedAt: (now - 25) * 1000, expiresAt: (now + 300) * 1000,
  };
  await t.test("private producer requires the served original and refuses a signer race", async () => {
    const approvalPath = trustedRevisionTwoApprovalPath(graph);
    const admissionBytes = JSON.stringify(sign(admission)) + "\n";
    await writeFile(policy.currentAdmissionFile, admissionBytes, { mode: 0o600 });
    const controlRoot = join(root, "producer-control");
    await mkdir(controlRoot, { mode: 0o700 });
    const control = await acquireWeb2ServiceControl(controlRoot, installationId);
    let openControl = control, inspections = 0, signatures = 0;
    let actual = resources;
    const makeHost = () => ({
      original, release, chain: authority, now: nowHost, lease: openControl.lease,
      live() { assert(nowHost() < policy.expiresAt); },
      async assertRetainedOriginal() { await assertOriginals(); },
      async inspect() { inspections++; return actual; },
      admission: () => readWeb2HostAdmission({
        path: policy.currentAdmissionFile, trust, now: nowHost, installationId, draft, planId: plan.planId,
        releaseArtifactDigest: plan.releaseArtifactDigest, targetDigest: plan.targetDigest,
        hostFingerprint: plan.hostFingerprint, minimumGeneration: plan.generation,
      }),
    });
    const issue = async (body: Web2TrustedRevisionTwoApproval) => { signatures++; return sign(body); };
    try {
      await assert.rejects(writeTrustedRevisionTwoApproval(makeHost(), issue), /trusted_revision_two_original_not_served/);
      assert.equal(inspections, 0);
      assert.equal(signatures, 0);
      await assert.rejects(readFile(approvalPath), { code: "ENOENT" });
      await writeFile(witnessPath, witnessBytes, { mode: 0o600 });
      actual = resources.map(row => ({ ...row, actual: { Id: "a".repeat(64) } }));
      await assert.rejects(writeTrustedRevisionTwoApproval(makeHost(), issue), /trusted_revision_two_original_resource_identity_required/);
      actual = resources;
      const witness = JSON.parse(witnessBytes);
      await writeFile(witnessPath, JSON.stringify({ ...witness, safeBlockHash: hashText("another fork") }));
      await assert.rejects(writeTrustedRevisionTwoApproval(makeHost(), issue), /trusted_revision_two_serving_anchor_changed/);
      assert.equal(signatures, 0);
      await writeFile(witnessPath, witnessBytes);
      await assert.rejects(writeTrustedRevisionTwoApproval(makeHost(), async body => sign({
        ...body, registryRuntimeHash: hashText("issuer changed the authenticated configuration"),
      })), /trusted_revision_two_issuer_changed_body/);
      await assert.rejects(writeTrustedRevisionTwoApproval(makeHost(), async (body) => {
        await writeFile(policy.currentAdmissionFile, JSON.stringify(sign({ ...admission, revokedPlanIds: [plan.planId] })));
        return issue(body);
      }), /web2_install_plan_revoked/);
      await assert.rejects(readFile(approvalPath), { code: "ENOENT" });
      await writeFile(policy.currentAdmissionFile, admissionBytes);
      let signedSafeBlock: string | undefined;
      const digest = await writeTrustedRevisionTwoApproval(makeHost(), async body => {
        signedSafeBlock = body.safeBlock;
        await chain.rpc("anvil_mine", ["0x4", "0x0"]);
        return issue(body);
      });
      const bytes = await readFile(approvalPath, "utf8");
      const selected = await readApprovedTrustedRevisionTwo(input);
      assert.equal(selected.approvalSha256, digest);
      assert.deepEqual(selected.approval.configuration, configuration);
      assert.equal(selected.approval.configurationSha256, hashJson(configuration));
      assert.equal(selected.approval.transitionTransactionHash, transition.transactionHash);
      assert.equal(selected.approval.registryRuntimeHash, registryRuntimeHash);
      assert.equal(selected.approval.safeBlock, signedSafeBlock);
      assert(BigInt(selected.authority.safeBlock) > BigInt(selected.approval.safeBlock));
      assert.equal(selected.approval.expiresAt, policy.expiresAt);
      assert.equal(signatures, 2);
      await openControl.closeControl();
      openControl = await acquireWeb2ServiceControl(controlRoot, installationId);
      assert.equal(await writeTrustedRevisionTwoApproval(makeHost(), issue), digest);
      assert.equal(signatures, 2);
      assert.equal(await readFile(approvalPath, "utf8"), bytes);
      assert.equal(await readFile(witnessPath, "utf8"), witnessBytes);
      assert.deepEqual(await readPrivateJSON(policy.currentAdmissionFile), sign(admission));
      await assertOriginals();
    } finally {
      await openControl.closeControl();
      await rm(approvalPath, { force: true });
      await rm(policy.currentAdmissionFile, { force: true });
      await rm(startPath);
      await rm(witnessPath, { force: true });
    }
  });

  // The revision-one policy and reader already exist when a validly signed
  // approval appears. Live Apply/verify and direct boot use this same reader.
  for (const override of [{ issuedAt: policy.issuedAt - 1 }, { expiresAt: policy.expiresAt + 1 }]) {
    await writeFile(trustedRevisionTwoApprovalPath(graph), JSON.stringify(sign({ ...approval, ...override })), { mode: 0o600 });
    await assert.rejects(readFromLiveInstaller(), /trusted_revision_two_approval_outside_policy/);
    await assert.rejects(readApprovedTrustedRevisionTwo(input), /trusted_revision_two_approval_outside_policy/);
    await assertOriginals();
  }
  await writeFile(trustedRevisionTwoApprovalPath(graph), JSON.stringify(sign(approval)));
  await assert.rejects(readFromLiveInstaller(), /trusted_revision_two_original_start_required/);
  await assert.rejects(readFile(startPath), { code: "ENOENT" });
  await writeFile(startPath, JSON.stringify({ ...web2OriginalStartIntent(plan), planDigest: "d".repeat(64) }), { mode: 0o600 });
  await assert.rejects(readFromLiveInstaller(), /original_start_intent_changed/);
  await writeFile(startPath, startBytes);
  originalRecords.set(startPath, startBytes);
  await assertOriginals();
  await writeFile(trustedRevisionTwoApprovalPath(graph), JSON.stringify(sign({
    ...approval, transitionBlock: String(transition.blockNumber - 1n),
  })), { mode: 0o600 });
  await assert.rejects(readApprovedTrustedRevisionTwo(input), /install_expanded_configuration_changed|trusted_revision_two_signed_original_changed/);

  const signed = sign(approval);
  await writeFile(trustedRevisionTwoApprovalPath(graph), JSON.stringify({ ...signed, signature: "A".repeat(86) }));
  await assert.rejects(readApprovedTrustedRevisionTwo(input), /record_signature_invalid/);
  await writeFile(trustedRevisionTwoApprovalPath(graph), JSON.stringify(sign({
    ...approval, registryRuntimeHash: hashText("not the authenticated Registry"),
  })));
  await assert.rejects(readApprovedTrustedRevisionTwo(input), /install_expanded_chain_or_registry_changed/);
  await writeFile(trustedRevisionTwoApprovalPath(graph), JSON.stringify(signed));
  const admitted = await readFromLiveInstaller();
  assert("approval" in admitted);
  assert.equal(admitted.approvalSha256, canonicalDigest(signed));
  assert.deepEqual(admitted.configuration, configuration);
  assert.equal(admitted.authority.transactionHash, enrollment.transactionHash);
  assert.equal(admitted.authority.configurationRevision, 2);
  assert.equal(admitted.expiresAt, now + 300);
  const policyPath = join(root, trustedRevisionTwoPolicyName + ".json");
  await writeFile(policyPath, JSON.stringify(sign({ ...policy, expiresAt: policy.expiresAt + 1000 })));
  await assert.rejects(readFromLiveInstaller(), /trusted_revision_two_binding_policy_changed/);
  await writeFile(policyPath, originalRecords.get(policyPath)!);
  await assert.rejects(readApprovedExpandedPublication(input), /native_expanded_fixture_selection_required/);
  assert.equal(await readFile(originalPath, "utf8"), recordBytes);
  assert.equal(await initializeWeb2NativeOriginal(directory.db, originalBytes), originalDigest);
  const reopened = await readApprovedTrustedRevisionTwo({ ...input, original: structuredClone(original) });
  assert.equal(reopened.approvalSha256, admitted.approvalSha256);

  fixture.setNow(BigInt(admitted.expiresAt));
  await assert.rejects(readApprovedTrustedRevisionTwo(input), /trusted_revision_two_approval_expired/);
  await assertOriginals();
});

test("trusted effects require every controller-validated original application and storage resource", () => {
  for (const incomplete of [[], [{ actual: null }], [{ actual: {} }, { actual: null }], [{ actual: {} }, { actual: undefined }]]) {
    assert.throws(() => requireTrustedRevisionTwoResources(2, incomplete), /trusted_revision_two_original_resources_required/);
  }
  assert.throws(() => requireTrustedRevisionTwoResources(0, []), /trusted_revision_two_original_resources_required/);
  requireTrustedRevisionTwoResources(2, [{ actual: { Id: "original-app" } }, { actual: { Id: "original-storage" } }]);
});
