import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonical, hashJson, hashText } from "../packages/community/common.ts";
import { nativeDigest } from "../packages/community/native-business-binding.ts";
import type { Web2NativeOriginal } from "../packages/community/web2-native-business-binding.ts";
import type { NativeGraph } from "../deploy/linux/full-native-config.ts";
import type { InstalledTarget } from "../deploy/linux/local-target-controller.ts";
import { signRecord } from "../deploy/linux/installed-records.ts";
import type { Web2ExpandedPublicationApproval } from "../deploy/linux/web2-expanded-publication.ts";
import { captureFreshPostsSelection, readFreshPostsSelection } from "../deploy/linux/web2-fresh-posts-selection.ts";
import { stagePostsSelector } from "../deploy/linux/web2-posts-selector-installation.ts";
import { authenticateWeb2Enrollment, type Web2InstallPlan } from "../deploy/linux/web2-profile-authority.ts";
import { publicationSelectionHash, type PublicationAppRelease } from "../services/publication-app-selection.ts";
import { installationAuthorityFixture } from "./fixtures/linux-web2-installation.ts";
import { scriptedPublicationAuthority } from "./fixtures/publication-app-rpc.ts";

test("fresh Posts staging binds the approved original and reopens without a fresh producer", { timeout: 120_000 }, async t => {
  const installed = await installationAuthorityFixture();
  t.after(installed.close);
  const root = await mkdtemp(join(tmpdir(), "native-fresh-posts-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { authority } = installed;
  const draft = { ...installed.draft, deployment: { ...installed.draft.deployment, rpcUrl: "https://rpc.fixture.test/rpc" } };
  const first = draft.configuration;
  const enrollment = await authenticateWeb2Enrollment(authority, draft);
  const keys = generateKeyPairSync("ed25519");
  const trust = { keyId: "test-install-original", spki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  const key = keys.privateKey.export({ type: "pkcs8", format: "der" });
  const installationId = "staging-fixture";
  const directory = join(root, "posts-custody"), path = join(directory, "selection.json");
  await mkdir(directory, { mode: 0o700 });
  const rpcOrigin = new URL(draft.deployment.rpcUrl).origin;
  const graph: NativeGraph = {
    installationId, durableScope: "a".repeat(64), releaseRoot: join(root, "release"), schemaPath: join(root, "release/workerd.capnp"),
    stateRoots: { configuration: join(root, "configuration") }, socket: join(root, "runtime.sock"),
    applicationBindings: [{ name: "POSTS_CUSTODY_SELECTION_JSON", file: path }],
    secretBindings: [{ name: "POSTS_CUSTODY_HOST_AUTH", path: join(directory, "host.auth") }],
    actors: [], requiredRoles: ["application"], queueConfiguration: {}, maintenanceConfiguration: {},
    directoryRuntimeBinding: canonical(draft.deployment), allowedOrigins: [rpcOrigin], publicationExpansion: "registry-revision-two/1",
    nativePublication: { schema: "pirate.web2-native-publication-transport/1", directory: join(root, "publication-transport"),
      transportRef: "fixture-publication", issuerCapabilityRef: "controller", issuerAddress: first.controller, operatorAddress: first.publisher },
    listenAddress: "0.0.0.0:8443", tls: { keyFile: join(root, "tls/key"), certificateFile: join(root, "tls/cert") },
    migrationPlanFile: join(root, "release/migration-plan.json"), probePlanFile: join(root, "probe.json"), readbackKeyFile: join(root, "readback"),
    fixtureTransport: { schema: "pirate.linux-local-fixture-transport/1", peer: "10.2.3.4", routes: [{ origin: rpcOrigin, upstream: "/rpc" }] },
  };
  const plan: Web2InstallPlan = {
    schema: "pirate.linux-web2-install-plan/1", planId: "web2-" + draft.enrollment.enrollmentId.slice(2), installationId,
    durableScope: graph.durableScope, generation: 1, draft, releaseArtifactDigest: hashText("artifact"), releaseSourceDigest: hashText("source"),
    targetDigest: hashText("staging target").slice(2), hostFingerprint: "fixture-host", enrollment,
    registrationAuthority: { registrar: authority.registrar, registrarRevision: String(authority.registrarRevision), maxSafeBlockAgeSeconds: "600" },
  };
  const original: Web2NativeOriginal = {
    schema: "pirate.web2-native-application-original/1", record: signRecord(plan, trust, key),
    release: signRecord({ schema: "pirate.complete-linux-web2-release/1", artifactDigest: plan.releaseArtifactDigest,
      sourceDigest: plan.releaseSourceDigest, graph: { installationId, durableScope: graph.durableScope,
        directoryRuntimeBinding: graph.directoryRuntimeBinding } }, trust, key),
    trust, durableScope: graph.durableScope,
  };
  key.fill(0);
  // Scripted revision-two evidence exercises the selector handoff only. It
  // does not replace the launcher's canonical signed-approval check.
  const { release: scripted } = scriptedPublicationAuthority(draft.origin, authority.now(), { issuer: first.controller, operator: first.publisher });
  const second = { ...first, configurationRevision: 2, learningRecords: scripted.source.registry };
  const release: PublicationAppRelease = { ...scripted, configuration: second, profile: draft.deployment.directoryProfile,
    source: { ...scripted.source, chainId: 6343, communityId: draft.enrollment.communityId,
      installationId: draft.enrollment.installationId, directory: first.directory }, fee: { ...scripted.fee, chainId: 6343 } };
  const releaseSha256 = publicationSelectionHash(release);
  const { communityId, installationId: directoryInstallationId } = draft.enrollment;
  const selection: Web2ExpandedPublicationApproval["proof"]["selection"] = {
    schema: "pirate.publication-installation/1", communityId, installationId: directoryInstallationId,
    origin: draft.origin, incarnation: "1", previous: null, installedBindingSha256: `0x${nativeDigest(original)}`,
    active: releaseSha256, entries: [{ release, transportRef: graph.nativePublication!.transportRef }],
  };
  const genesisHash = (await authority.client.getBlock({ blockNumber: 0n })).hash;
  const directRpcUrl = authority.client.transport.url;
  assert(genesisHash && typeof directRpcUrl === "string");
  const proof: Web2ExpandedPublicationApproval["proof"] = { selection, evidence: {
    schema: "pirate.local-native-expanded-directory-selection/1", nativeOriginalSha256: nativeDigest(original),
    releaseArtifactDigest: plan.releaseArtifactDigest, releaseSourceDigest: plan.releaseSourceDigest,
    hostInstallationId: installationId, directoryInstallationId, genesisHash, communityId,
    registrationHash: enrollment.transactionHash, registrationBlockHash: enrollment.registrationBlockHash,
    configurationRevision: 2, configurationHash: hashText("scripted new revision tx"), configurationBlockHash: hashText("scripted new block"),
    safeBlock: enrollment.safeBlock, safeBlockHash: enrollment.safeBlockHash, registry: release.source.registry,
    registryRuntimeHash: release.source.registryRuntimeHash, releaseSha256, selectionSha256: hashJson(selection),
  } };
  const scope = { chainId: 6343 as const, genesisHash, communityId, installationId: directoryInstallationId, publisher: first.publisher };
  const publisher = { ...scope, releaseSelectionSha256: releaseSha256, rpcUrl: directRpcUrl };
  const input = { original, graph, scope, proof, publisher, directRpcUrl, history: [first, second] };
  for (const changed of [
    { ...input, scope: { ...scope, genesisHash: hashText("different genesis") } },
    { ...input, publisher: { ...publisher, rpcUrl: "http://127.0.0.1:1" } },
    { ...input, history: [first] },
    { ...input, history: [first, { ...second, publisher: first.controller }] },
    { ...input, graph: { ...graph, allowedOrigins: [] } },
  ]) assert.throws(() => captureFreshPostsSelection(changed), /native_fresh_posts_selection_changed/);
  const captured = captureFreshPostsSelection(input);
  for (const changed of [
    { ...input, graph: { ...graph, listenAddress: "0.0.0.0:9443" } },
    { ...input, proof: { ...proof, evidence: { ...proof.evidence, safeBlockHash: hashText("new anchor") } } },
  ]) assert.throws(() => readFreshPostsSelection(captured, changed), /native_fresh_posts_original_unavailable/);

  const target: InstalledTarget = {
    installationId, daemonId: "unused-fixture-daemon", docker: "/unused-fixture-docker", dockerSha256: "c".repeat(64),
    socket: join(root, "unused-daemon.sock"), dockerConfig: join(root, "docker"), stateRoot: root,
    maintenanceDirectory: join(root, "maintenance"), resourceDirectory: join(root, "resources"), outputDirectory: join(root, "output"),
    cwd: root, environment: {}, hostWriters: [], allowedReadOnlyRoots: [directory], allowedWritableRoots: [],
    containers: [{ key: "application", name: "staging-fixture-app", imageId: "sha256:" + "d".repeat(64),
      configurationDigest: "b".repeat(64), ingress: true, user: "1000:1000", argv: [], roles: ["application"], network: "unused-fixture-net",
      mounts: [{ source: directory, target: directory, readOnly: true }], ports: [] }],
  };
  const stage = { original, graph, target, async assertCurrent() { assert.deepEqual(original.record.body.enrollment, enrollment); } };
  await assert.rejects(stagePostsSelector({ ...stage, startRetained: false, owner: {
    async selection() { return readFreshPostsSelection(undefined, input); },
  } }), /native_fresh_posts_original_unavailable/);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await assert.rejects(stagePostsSelector({ ...stage, startRetained: true, owner: {
    async selection() { return assert.fail("incomplete restart must not request a new selector"); },
  } }), /native_posts_install_original_selector_missing/);
  await stagePostsSelector({ ...stage, startRetained: false, owner: {
    async selection(retained, selectedGraph) { return readFreshPostsSelection(captured, { original: retained, graph: selectedGraph, proof }); },
  } });
  const bytes = await readFile(path, "utf8");
  assert.equal(bytes, canonical(captured.selected));
  await stagePostsSelector({ ...stage, startRetained: true, owner: {
    async selection() { return assert.fail("restart must reopen the original selector"); },
  } });
  assert.equal(await readFile(path, "utf8"), bytes);
});
