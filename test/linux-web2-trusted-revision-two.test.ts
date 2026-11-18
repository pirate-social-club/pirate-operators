import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Address } from "viem";
import type { InstalledTarget } from "../deploy/linux/local-target-controller.ts";
import type { FullRelease } from "../deploy/linux/installed-release.ts";
import { renderFullNativeConfig, type NativeGraph } from "../deploy/linux/full-native-config.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Miniflare } from "miniflare";
import { publicationMountFor } from "../deploy/linux/web2-publication-selection.ts";
import { readTrustedNativePublication } from "../deploy/linux/web2-trusted-publication.ts";
import { web2DanceLiveProofHeader } from "../packages/community/web2-dance-live-proof.ts";
import { trustedWeb2PublicationFile, trustedWeb2PublicationReadbackPath, verifyTrustedWeb2Publication,
  type Web2TrustedPublicationAttachment } from "../packages/community/web2-trusted-publication.ts";
import { publicationSelectionHash, type PublicationAppRelease } from "../services/publication-app-selection.ts";
import type { PublicationInstallationSpec } from "../services/publication-installed-selection.ts";
import { scriptedPublicationAuthority } from "./fixtures/publication-app-rpc.ts";
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
import { nativeMigrationNames, nativeProducerFixture } from "./application-native-producer-fixture.ts";
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
  const issuer: Address = "0x000000000000000000000000000000000000abcd";
  const transport = {
    schema: "pirate.web2-native-publication-transport/1" as const,
    directory: join(root, "publication-transport"), transportRef: "public-publication",
    issuerCapabilityRef: "publication-envelope:fixture", issuerAddress: issuer,
    operatorAddress: draft.configuration.publisher,
  };
  const graph: NativeGraph = {
    publicationExpansion: trustedRevisionTwo, nativePublication: transport, localActivitySocket: "/run/activity.sock",
    installationId, durableScope: "a".repeat(64),
    releaseRoot: join(root, "release"), schemaPath: join(root, "release", "workerd.capnp"),
    stateRoots: { configuration: root, database: join(root, "database"), objects: join(root, "objects"),
      jobs: join(root, "jobs"), scheduler: join(root, "scheduler"), readiness: join(root, "readiness") },
    socket: join(root, "native.sock"), actors: [], requiredRoles: [], queueConfiguration: { scope: "a".repeat(64) },
    maintenanceConfiguration: { scope: "a".repeat(64) }, allowedOrigins: [], directoryRuntimeBinding: JSON.stringify(draft.deployment),
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

  await t.test("public rev2 companion unlocks only the exact original consent selection", async () => {
    assert.notEqual(issuer, configuration.controller);
    const read = () => readTrustedNativePublication({ graph, original, approval: admitted });
    const path = join(root, trustedWeb2PublicationFile);
    assert.equal(await read(), undefined);
    const source = draft.deployment.directoryProfile;
    // Fixture descriptors exercise the exact release decoder. Live descriptor
    // authority is independently verified through the ordinary prepare path.
    const { release: scripted } = scriptedPublicationAuthority("https://policies.example", BigInt(now), {
      issuer, operator: configuration.publisher,
    });
    const release: PublicationAppRelease = {
      ...scripted, configuration, profile: source,
      fee: { ...scripted.fee, chainId: source.chainId },
      source: {
        schema: "pirate.publication-source/1", resultsVersion: 5, chainId: source.chainId,
        directory: source.directory, directoryRuntimeHash: source.directoryCodeHash,
        communityId: source.communityId, installationId: source.installationId, registry, registryRuntimeHash,
      },
      policies: {
        "dance-verdict": scripted.policies["dance-verdict"]!,
        "dance-review-attribution": scripted.policies["dance-review-attribution"]!,
      },
    };
    const selection: PublicationInstallationSpec = {
      schema: "pirate.publication-installation/1", communityId: source.communityId,
      installationId: source.installationId, origin: draft.origin, incarnation: "1",
      installedBindingSha256: `0x${nativeDigest(original)}`, previous: null,
      active: publicationSelectionHash(release), entries: [{ release, transportRef: transport.transportRef }],
    };
    const bodyFor = (selected: PublicationInstallationSpec, selectedTransport = transport): Web2TrustedPublicationAttachment => ({
      schema: "pirate.web2-trusted-revision-two-publication/1", nativeOriginalSha256: nativeDigest(original),
      graphSha256: canonicalDigest(graph), approvalSha256: admitted.approvalSha256,
      initialization: { schema: "pirate.web2-native-publication-initialization/1", selection: selected,
        selector: sign(publicationMountFor(original, selected, selectedTransport)) },
    });
    const body = bodyFor(selection), raw = canonical(sign(body));
    const write = (bytes: string) => writeFile(path, bytes, { mode: 0o600 });
    await write(raw + "\n");
    await assert.rejects(read, /trusted_web2_publication_attachment_not_canonical/);
    const signed = sign(body);
    await write(canonical({ ...signed, signature: "A".repeat(86) }));
    await assert.rejects(read, /native_original_signature/);
    for (const change of [{ nativeOriginalSha256: "1".repeat(64) }, { graphSha256: "1".repeat(64) },
      { approvalSha256: "1".repeat(64) }]) {
      await write(canonical(sign({ ...body, ...change })));
      await assert.rejects(read, /trusted_web2_publication_(original|approval)_changed/);
    }
    const singleRelease = structuredClone(release);
    delete singleRelease.policies["dance-review-attribution"];
    await write(canonical(sign(bodyFor({ ...selection, active: publicationSelectionHash(singleRelease),
      entries: [{ release: singleRelease, transportRef: transport.transportRef }] }))));
    await assert.rejects(read, /trusted_web2_publication_active_release_changed/);
    for (const occupied of [configuration.controller, configuration.publisher, admitted.approval.ownerWallet]) {
      const aliasRelease = { ...release, issuer: occupied };
      const aliasTransport = { ...transport, issuerAddress: occupied };
      const alias = bodyFor({ ...selection, active: publicationSelectionHash(aliasRelease),
        entries: [{ release: aliasRelease, transportRef: transport.transportRef }] }, aliasTransport);
      await assert.rejects(verifyTrustedWeb2Publication(canonical(sign(alias)), original, {
        graphSha256: alias.graphSha256, approvalSha256: alias.approvalSha256, configuration,
        registryRuntimeHash, transport: aliasTransport, ownerWallet: admitted.approval.ownerWallet,
      }), /trusted_web2_publication_(active_release|approval)_changed/);
    }
    await write(raw);
    assert.deepEqual((await read())?.initialization, body.initialization);
    await rm(path);
    assert.equal(await read(), undefined);
    await write(raw);
    const bootFile = "/run/authorized-boot/web2-original.json";
    const revOne = renderFullNativeConfig(graph, "serve", "e".repeat(64), bootFile);
    assert.doesNotMatch(revOne, /PUBLICATION_NATIVE_MOUNT_JSON|PUBLICATION_OPERATOR_HOST|PUBLICATION_RETAINED_LOOKUP_AUTH/);
    const snapshot = { selector: "/run/authorized-boot/trusted-publication-mount.json",
      initialization: "/run/authorized-boot/trusted-publication-initialization.json", expiresAtMs: Date.now() + 60000 };
    assert.throws(() => renderFullNativeConfig(graph, "initialize", undefined, bootFile,
      graph.socket, false, snapshot), /trusted_web2_publication_boot_snapshot_required/);
    const revTwo = renderFullNativeConfig(graph, "serve", "e".repeat(64), bootFile,
      graph.socket, false, snapshot);
    const initializeRevTwo = renderFullNativeConfig(graph, "initialize", undefined, bootFile,
      graph.socket, true, snapshot);
    assert.match(initializeRevTwo, /WEB2_TRUSTED_PUBLICATION_INITIALIZATION_JSON/);
    assert.match(initializeRevTwo, /WEB2_TRUSTED_PUBLICATION_EXPIRES_AT_MS/);
    assert.doesNotMatch(initializeRevTwo, /PUBLICATION_NATIVE_MOUNT_JSON|PUBLICATION_OPERATOR_HOST_AUTH/);
    assert.match(revTwo, /PUBLICATION_NATIVE_MOUNT_JSON/);
    assert.match(revTwo, /PUBLICATION_OPERATOR_HOST_AUTH/);
    assert.match(revTwo, /PUBLICATION_RETAINED_LOOKUP_AUTH/);
    assert.doesNotMatch(revTwo, /WEB2_TRUSTED_PUBLICATION_INITIALIZATION_JSON/);

    const split = async (sourceRoot: string, paths: string[], overlay = false) => JSON.parse(
      (await promisify(execFile)("/usr/bin/python3", ["-B", "deploy/linux/split-migrations.py",
        sourceRoot, JSON.stringify(paths), ...(overlay ? ["web2-first-song/1"] : [])], { maxBuffer: 4 * 1024 ** 2 })).stdout);
    const migrations = await split("apps/community-wizard/infra/migrations",
      [...nativeMigrationNames, "0020_publication_consent.sql", "0021_publication_installed_selection.sql",
        "0022_dance_private_practice.sql"]);
    const overlays = await split(process.cwd(), ["packages/community/catalog-phase-rebuild.sql",
      "packages/community/catalog-obligation.sql", "packages/community/native-business.sql"], true);
    const runtime = new Miniflare({
      modules: true, script: "export default {fetch(){return new Response(null)}}",
      compatibilityDate: "2026-08-06", d1Databases: ["DB", "ORPHAN"], r2Buckets: ["MEDIA"],
    });
    try {
      const db = await runtime.getD1Database("DB"), orphan = await runtime.getD1Database("ORPHAN");
      const { MEDIA: media } = await runtime.getBindings<{ MEDIA: R2Bucket }>();
      const env = {
        DB: db, MEDIA: media, NATIVE_APPLICATION_ORIGINAL_JSON: originalBytes,
        MIGRATION_PLAN_JSON: JSON.stringify({ schema: "pirate.linux-migration-plan/1", qualificationOnly: true,
          releaseSha256: artifactDigest.slice(2), migrations, web2Schema: { schema: "pirate.linux-web2-schema/1", overlays } }),
      };
      const initialize = (selectedEnv: typeof env & {
        WEB2_TRUSTED_PUBLICATION_INITIALIZATION_JSON?: string; WEB2_TRUSTED_PUBLICATION_EXPIRES_AT_MS?: string;
        WEB2_REQUIRE_RETAINED_STATE?: "1";
      }) => boot.fetch(new Request("http://private/initialize", { method: "POST" }), selectedEnv);
      const count = (d: D1Database, table: string) => d.prepare(`SELECT count(*) AS n FROM ${table}`).first("n");
      await assert.rejects(initialize({ ...env, WEB2_TRUSTED_PUBLICATION_INITIALIZATION_JSON: raw }),
        /Trusted publication requires the retained Web2 original/);
      assert.equal(await db.prepare("SELECT name FROM sqlite_schema WHERE name='_pirate_linux_migrations'").first(), null);
      const fresh = await (await initialize(env)).json();
      assert.equal(fresh.publicationSelectionSha256, undefined);
      assert.equal(await count(db, "publication_v1_release_archive"), 0);
      const retained = { ...env, WEB2_REQUIRE_RETAINED_STATE: "1" as const, WEB2_TRUSTED_PUBLICATION_INITIALIZATION_JSON: raw,
        WEB2_TRUSTED_PUBLICATION_EXPIRES_AT_MS: String(Date.now() + 60000) };
      const originalState = async () => Promise.all(["native_application_original", "application_identity",
        "_pirate_linux_migrations", "_pirate_web2_schema"].map(async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results));
      const before = await originalState();
      await assert.rejects(initialize({ ...retained, WEB2_TRUSTED_PUBLICATION_EXPIRES_AT_MS: undefined }),
        /Trusted publication cutoff missing or invalid/);
      const expires = Date.now() + 150;
      let delayedOriginalRead = false;
      const delayedMedia = new Proxy(media, {
        get(target, property, receiver) {
          if (property !== "get") return Reflect.get(target, property, receiver);
          return async (key: string) => {
            const object = await target.get(key);
            delayedOriginalRead = true;
            await delay(Math.max(0, expires - Date.now() + 10));
            return object;
          };
        },
      });
      await assert.rejects(initialize({ ...retained, MEDIA: delayedMedia, WEB2_TRUSTED_PUBLICATION_EXPIRES_AT_MS: String(expires) }),
        /publication_first_selection_expired/);
      assert(delayedOriginalRead);
      assert.equal(await count(db, "publication_v1_installed_selection"), 0);
      assert.equal(await count(db, "publication_v1_release_archive"), 0);
      assert.deepEqual(await originalState(), before);
      const first = await (await initialize(retained)).json();
      assert.equal(first.publicationSelectionSha256, body.initialization.selector.body.mount.selectionSha256);
      assert.equal(first.retainedState, true);
      assert.equal(first.objectEtag, fresh.objectEtag);
      assert.deepEqual(await originalState(), before);
      const selected = () => db.prepare("SELECT * FROM publication_v1_installed_selection").first();
      const archived = () => db.prepare("SELECT * FROM publication_v1_release_archive").first();
      const both = [await selected(), await archived()];
      assert((await initialize(retained)).ok);
      assert.deepEqual([await selected(), await archived()], both);
      await assert.rejects(initialize({ ...retained, WEB2_TRUSTED_PUBLICATION_EXPIRES_AT_MS: String(Date.now() - 1) }),
        /publication_first_selection_expired/);
      assert.deepEqual([await selected(), await archived()], both);
      assert.equal(await count(db, "publication_v1_commands"), 0);
      const gatewayModule: string = "../deploy/linux/full-gateway.worker.mjs";
      const { default: gateway } = await import(gatewayModule);
      const { default: app } = await import("../services/linux-community.ts");
      const bootId = "b".repeat(64), key = "c".repeat(64);
      const startup = { fetch: async () => Response.json({ initialized: true, bootId }) };
      const observer = { fetch: async () => { throw Error("unexpected_generic_observer"); } };
      const appEnv = { ...directory.env, DB: db, MEDIA: media,
        COMMUNITY_DEPLOYMENT_PROFILE_JSON: JSON.stringify(draft.deployment),
        NATIVE_APPLICATION_ORIGINAL_JSON: originalBytes, NATIVE_READBACK_KEY: key,
        WEB2_PUBLISHING_ATTACHMENT_SHA256: attachmentDigest };
      const mounted = { ...appEnv, PUBLICATION_NATIVE_MOUNT_JSON: canonical(body.initialization.selector),
        PUBLICATION_OPERATOR_HOST_AUTH: "d".repeat(64), PUBLICATION_RETAINED_LOOKUP_AUTH: "e".repeat(64),
        PUBLICATION_OPERATOR_HOST: { fetch: async () => { throw Error("readback_must_not_open_publisher_transport"); } } };
      const url = draft.origin + trustedWeb2PublicationReadbackPath;
      let applicationReads = 0;
      const prove = (candidate: typeof appEnv, access: string, path = url, proof?: "dormant" | "reward" | "reward-only" | "scope") => gateway.fetch(
        new Request(path, { headers: { "X-Pirate-Readback-Key": access, ...(proof ? { [web2DanceLiveProofHeader]: proof } : {}) } }),
        { STARTUP: startup, OBSERVER: observer, READBACK_KEY: key,
          APPLICATION: { fetch(request: Request) { applicationReads++; return app.fetch(request, candidate); } } },
      );
      assert.equal((await prove(mounted, "0".repeat(64))).status, 404);
      assert.equal(applicationReads, 0);
      const dormant = await prove(appEnv, key);
      assert.equal(dormant.status, 503);
      assert.equal(dormant.headers.get("X-Pirate-Native-Boot-Id"), null);
      assert.equal((await prove(mounted, key, url + "?unexpected=1")).status, 404);
      const serving = await prove(mounted, key);
      assert.equal(serving.status, 200);
      assert.equal(serving.headers.get("X-Pirate-Native-Boot-Id"), bootId);
      assert.deepEqual(await serving.json(), { mount: body.initialization.selector.body.mount, active: selection.active });
      for (const proof of ["dormant", "reward", "reward-only"] as const)
        assert.equal((await prove(mounted, key, url, proof)).status, 503);
      const inactiveScope = await prove(mounted, key, url, "scope");
      assert.equal(inactiveScope.status, 503);
      assert.equal(inactiveScope.headers.get("X-Pirate-Native-Boot-Id"), null);
      assert.equal((await prove(mounted, key)).status, 200);
      assert.equal(await count(db, "publication_v1_commands"), 0);
      const differingRelease = structuredClone(release);
      differingRelease.fee.cap = (BigInt(differingRelease.fee.cap) + 1n).toString();
      const differing = canonical(sign(bodyFor({ ...selection, active: publicationSelectionHash(differingRelease),
        entries: [{ release: differingRelease, transportRef: transport.transportRef }] })));
      await assert.rejects(initialize({ ...retained, WEB2_TRUSTED_PUBLICATION_INITIALIZATION_JSON: differing }),
        /publication_installation_changed/);
      assert.deepEqual([await selected(), await archived()], both);
      await initialize({ ...env, DB: orphan });
      await orphan.prepare(`INSERT INTO publication_v1_release_archive
        (community_id,release_sha256,release_json,transport_ref,admitted_binding_sha256) VALUES(?,?,?,?,?)`)
        .bind(selection.communityId, selection.active, canonical(release), transport.transportRef, selection.installedBindingSha256).run();
      await assert.rejects(initialize({ ...retained, DB: orphan }), /NOT NULL|constraint/i);
      assert.equal(await count(orphan, "publication_v1_installed_selection"), 0);
      assert.equal(await count(orphan, "publication_v1_release_archive"), 1);
    } finally {
      await runtime.dispose();
      await rm(path, { force: true });
    }
  });

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
