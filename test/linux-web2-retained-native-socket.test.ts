import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { hash } from "../deploy/linux/backend-state.ts";
import type { NativeGraph } from "../deploy/linux/full-native-config.ts";
import type { Web2BootstrapRelease } from "../deploy/linux/installed-release.ts";
import type { InstalledTarget } from "../deploy/linux/local-target-controller.ts";
import {
  assertNoBootstrapPractice, assertWeb2LocalStudyInputs, studyModule, validateWeb2LocalStudyPolicy, type Web2LocalStudyPolicy,
} from "../deploy/linux/web2-local-study.ts";
import {
  assertNoBootstrapNativeActivities, karaokeModule, validateNativeActivityPolicy, type Web2NativeActivityPolicy,
} from "../deploy/linux/web2-native-activities.ts";
import { hashText } from "../packages/community/common.ts";

async function nativeActivityFixture(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pna-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transport = join(root, "activity-transport"), credentials = join(root, "credentials");
  const studyRoot = join(root, "private-study"), karaokeRoot = join(root, "private-karaoke"), releaseRoot = join(root, "release");
  for (const path of [transport, credentials, studyRoot, karaokeRoot, releaseRoot]) await mkdir(path, { mode: 0o700 });

  // Established public fixture scalars. Neither account signs anything.
  const issuerKey = `0x${"11".repeat(32)}` as const;
  const operatorKey = `0x${"22".repeat(32)}` as const;
  const socket = join(transport, "host.sock"), auth = "a".repeat(43);
  const now = Date.now(), expiresAt = now + 60_000, nowS = Math.floor(now / 1000);
  const study: Web2LocalStudyPolicy = {
    schema: "pirate.web2-local-study-policy/1",
    issuer: privateKeyToAccount(issuerKey).address.toLowerCase() as `0x${string}`,
    operator: privateKeyToAccount(operatorKey).address.toLowerCase() as `0x${string}`,
    issuerFile: join(credentials, "study.key"),
    asr: { origin: "https://asr.example.test", upstream: "unix:" + socket, authFile: join(credentials, "asr.auth"),
      authSha256: hashText(auth), selectedProgramSha256: hashText("study fixture program") },
    speech: { keyGeneration: "fixture", dailyUnits: 2, websiteStudyReservedUnits: 1 },
  };
  const policy: Web2NativeActivityPolicy = {
    schema: "pirate.web2-native-activities/1", socket,
    karaoke: { operatorFile: join(credentials, "karaoke.key"), ingressFile: join(credentials, "karaoke.auth"),
      community: "0x3333333333333333333333333333333333333333", token: "0x4444444444444444444444444444444444444444",
      modelSha256: hashText("fixture model"), pythonSha256: hash("fixture interpreter"), scriptSha256: hash("fixture script"),
      validFrom: nowS - 1, validUntil: nowS + 55, retentionDays: 1 },
  };
  const karaoke = policy.karaoke!;
  for (const [path, contents] of [[study.issuerFile, issuerKey], [study.asr.authFile, auth],
    [karaoke.operatorFile, operatorKey], [karaoke.ingressFile, auth]] as const) {
    await writeFile(path, contents, { mode: 0o600 });
  }

  const graph: Omit<NativeGraph, "directoryRuntimeBinding"> = {
    installationId: "native-socket-fixture", durableScope: hash("fixture scope"), releaseRoot,
    schemaPath: join(releaseRoot, "workerd.capnp"), stateRoots: { "private-study": studyRoot, "private-karaoke": karaokeRoot },
    socket: join(root, "control.sock"), actors: [], requiredRoles: ["application"],
    applicationBindings: [], secretBindings: [], allowedOrigins: [], queueConfiguration: {}, maintenanceConfiguration: {},
    listenAddress: "127.0.0.1:8443", tls: { keyFile: join(root, "tls.key"), certificateFile: join(root, "tls.pem") },
    migrationPlanFile: join(releaseRoot, "migration-plan.json"), probePlanFile: join(root, "probe.json"),
    readbackKeyFile: join(credentials, "readback.key"),
  };
  const target: InstalledTarget = {
    installationId: graph.installationId, daemonId: "fixture-daemon", docker: join(root, "docker"), dockerSha256: hash("docker"),
    socket: join(root, "docker.sock"), dockerConfig: join(root, "docker-config"), stateRoot: root,
    maintenanceDirectory: join(root, "maintenance"), resourceDirectory: join(root, "resources"), outputDirectory: join(root, "output"),
    cwd: root, environment: {}, hostWriters: [], allowedReadOnlyRoots: [transport, credentials],
    allowedWritableRoots: [studyRoot, karaokeRoot],
    containers: [{ key: "application", name: "native-socket-fixture", imageId: "sha256:" + hash("image"),
      configurationDigest: hash("container"), ingress: false, user: "1000:1000", argv: ["fixture"],
      roles: ["application", "private-study", "private-karaoke"], network: hash("network"), ports: [],
      mounts: [transport, credentials, studyRoot, karaokeRoot].map(path => ({
        source: path, target: path, readOnly: path === transport || path === credentials,
      })) }],
  };
  const files: Record<string, string> = {};
  for (const name of [studyModule, karaokeModule]) {
    const bytes = `// Static module inventory fixture for ${name}\n`;
    await writeFile(join(releaseRoot, name), bytes, { mode: 0o600 });
    files[name] = hash(bytes);
  }
  const release: Web2BootstrapRelease = {
    schema: "pirate.linux-web2-bootstrap-release/1", sourceHead: "1".repeat(40), sourceTree: "2".repeat(40),
    root: releaseRoot, sourceRoot: join(releaseRoot, "source"), artifactDigest: hash("fixture artifacts"),
    sourceDigest: hash("fixture source"), imageId: target.containers[0]!.imageId, files, sourceHashes: {},
    execution: { node: "toolchain/node", nodeSha256: hash("fixture node"), nodeVersion: "v24.18.1",
      loader: "toolchain/node_modules/tsx/dist/loader.mjs", tsxVersion: "4.20.6", backend: "source/backend.ts" },
  };

  assertNoBootstrapPractice(graph);
  assertNoBootstrapNativeActivities(graph);
  validateWeb2LocalStudyPolicy(study, graph, release, target, policy.socket);
  await assertWeb2LocalStudyInputs(study, graph);
  const input = { policy, study, graph, target, release, expiresAt };
  const retained = { ...input, mode: "retained-dance-owner" as const };

  return { root, transport, socket, auth, karaoke, target, release, input, retained };
}

test("retained native owner accepts an absent socket and still validates the static scope", async t => {
  const { root, transport, socket, auth, karaoke, target, release, input, retained } = await nativeActivityFixture(t);
  await assert.rejects(lstat(socket), { code: "ENOENT" });
  await assert.rejects(validateNativeActivityPolicy({ ...input, mode: "setup" }), { code: "ENOENT" });
  await validateNativeActivityPolicy(retained);

  await symlink(join(transport, "missing.sock"), socket);
  await assert.rejects(validateNativeActivityPolicy(retained), /private_activity_listener_required/);
  await rm(socket);
  const writableTarget = structuredClone(target);
  writableTarget.containers[0]!.mounts.find(mount => mount.target === transport)!.readOnly = false;
  await assert.rejects(validateNativeActivityPolicy({ ...retained, target: writableTarget }), /owned_activity_socket_mount_required/);
  await writeFile(karaoke.ingressFile, "changed");
  await assert.rejects(validateNativeActivityPolicy(retained), /private_activity_credential_changed/);
  await writeFile(karaoke.ingressFile, auth);
  await assert.rejects(validateNativeActivityPolicy({ ...retained, release: { ...release, files: {} } }), /private_karaoke_scope_required/);
  await rename(transport, join(root, "other-transport"));
  await assert.rejects(validateNativeActivityPolicy(retained), { code: "ENOENT" });
});


test("native owner validation follows a real foreground Unix socket drain", async t => {
  const { socket, input, retained } = await nativeActivityFixture(t);
  const foreground = createServer();
  try {
    foreground.listen(socket);
    await once(foreground, "listening");
    await chmod(socket, 0o600);
    await validateNativeActivityPolicy({ ...input, mode: "setup" });
    await validateNativeActivityPolicy(retained);
  } finally {
    if (foreground.listening) await new Promise<void>((resolve, reject) =>
      foreground.close(error => error ? reject(error) : resolve()));
  }
  await assert.rejects(lstat(socket), { code: "ENOENT" });
  await assert.rejects(validateNativeActivityPolicy({ ...input, mode: "setup" }), { code: "ENOENT" });
  await validateNativeActivityPolicy(retained);

});
