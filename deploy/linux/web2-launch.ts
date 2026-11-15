#!/usr/bin/env node
/** Installed Web2 process owner. No default profile, HNS adapter or shell. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { createPublicClient, http } from "viem";
import { canonicalDigest, readPrivateJSON, type SignedRecord, type TrustAnchor } from "./installed-records.ts";
import { verifyInstalledRelease, type FullRelease } from "./installed-release.ts";
import { createBootDirectory } from "./local-installation.ts";
import { hash, privateDirectory, processIdentity, sameProcess, syncDirectory } from "./backend-state.ts";
import { renderFullNativeConfig } from "./full-native-config.ts";
import { assertStartAllowed } from "./maintenance-guard.ts";
import { authenticateWeb2Enrollment, readWeb2HostAdmission, type Web2InstallPlan } from "./web2-profile-authority.ts";
import { web2NativeOriginal, type Web2NativeOriginal } from "../../packages/community/web2-native-business-binding.ts";
import { communityIpfsTransport } from "../../services/community-deployment-profile.ts";

export interface Web2LaunchConfiguration {
  schema: "pirate.linux-web2-launch/1";
  release: SignedRecord<FullRelease>;
  trust: TrustAnchor;
  currentAdmissionFile: string;
  minimumGeneration: number;
  privateRuntimeDirectory: string;
  maintenanceDirectory: string;
}
async function writeExclusive(path: string, value: string) {
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}
async function privateReady(socketPath: string) {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = request({ socketPath, path: "/initialize", method: "POST", timeout: 2000 }, res => {
          let body = "";
          res.on("data", chunk => { body += String(chunk); if (body.length > 65536) req.destroy(Error("web2_initialize_response_limit")); });
          res.once("error", reject);
          res.once("end", () => { try { assert(res.statusCode === 200); resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.once("error", reject); req.once("timeout", () => req.destroy(Error("web2_initialize_request_timeout"))); req.end();
      });
    } catch (error) {
      // Retry only absence before listener creation; failed initialization is terminal.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

export async function runWeb2Native(configPath: string) {
  const config = await readPrivateJSON<Web2LaunchConfiguration>(configPath);
  assert(config.schema === "pirate.linux-web2-launch/1");
  assert.deepEqual(Object.keys(config).sort(), ["currentAdmissionFile", "maintenanceDirectory", "minimumGeneration",
    "privateRuntimeDirectory", "release", "schema", "trust"]);
  const release = await verifyInstalledRelease(config.release, config.trust), graph = release.graph;
  assert(release.schema === "pirate.complete-linux-web2-release/1", "web2_release_required");
  const signed = await readPrivateJSON<SignedRecord<Web2InstallPlan>>(join(graph.stateRoots.configuration!, "web2-original.json"));
  const original: Web2NativeOriginal = { schema: "pirate.web2-native-application-original/1", record: signed,
    release: config.release, trust: config.trust, durableScope: graph.durableScope };
  await web2NativeOriginal(JSON.stringify(original));
  const plan = original.record.body, deployment = plan.draft.deployment;
  const { communityId: _id, communityKey: _key, installationId: _installation, ...directory } = deployment.directoryProfile;
  const client = createPublicClient({ transport: http(deployment.rpcUrl, { retryCount: 0 }) });
  const current = async () => {
    await assertStartAllowed(config.maintenanceDirectory);
    await verifyInstalledRelease(config.release, config.trust);
    const admission = () => readWeb2HostAdmission({ path: config.currentAdmissionFile, trust: config.trust, now: Date.now,
      installationId: plan.installationId, draft: plan.draft, releaseArtifactDigest: release.artifactDigest,
      targetDigest: plan.targetDigest, hostFingerprint: plan.hostFingerprint,
      minimumGeneration: Math.max(config.minimumGeneration, plan.generation), planId: plan.planId });
    await admission();
    await authenticateWeb2Enrollment({ client, send: communityIpfsTransport(deployment), now: () => BigInt(Math.floor(Date.now() / 1000)),
      maxSafeBlockAgeSeconds: BigInt(plan.registrationAuthority.maxSafeBlockAgeSeconds), deployment: directory,
      registrar: plan.registrationAuthority.registrar, registrarRevision: BigInt(plan.registrationAuthority.registrarRevision) }, plan.draft);
    await admission();
  };
  await current();
  for (const root of Object.values(graph.stateRoots)) await privateDirectory(root);
  const scratch = await createBootDirectory(config.privateRuntimeDirectory);
  const nativeOriginalFile = join(scratch, "web2-original.json");
  await writeExclusive(nativeOriginalFile, JSON.stringify(original) + "\n");
  await syncDirectory(scratch);
  const executable = join(release.root, "workerd");
  assert(await realpath(executable) === executable && hash(await readFile(executable)) === release.files.workerd, "web2_native_binary_changed");
  let stopped = false, active: { stop(): Promise<void> } | undefined;
  const stop = () => { stopped = true; void active?.stop().catch(() => { process.exitCode = 1; }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  async function phase(mode: "initialize" | "serve") {
    assert(!stopped, "web2_native_cancelled"); await current();
    const bootId = randomBytes(32).toString("hex"), socket = join(scratch, mode + ".sock");
    const file = join(scratch, mode + ".capnp");
    await writeExclusive(file, renderFullNativeConfig(graph, mode, bootId, nativeOriginalFile, socket));
    await syncDirectory(scratch); await current(); assert(!stopped, "web2_native_cancelled");
    const child = spawn(executable, ["serve", "--experimental", file], {
      cwd: release.root, env: { PATH: "/usr/bin:/bin", TZ: "UTC" }, stdio: ["ignore", "inherit", "inherit"], detached: true,
    });
    const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", reject);
    });
    // Register the rejection handler immediately; a spawn failure has one owner.
    void terminal.catch(() => undefined);
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const identity = await processIdentity(child.pid!); assert(identity, "actual_native_process_unavailable");
    let stopping: Promise<void> | undefined;
    const owner = { stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        assert(sameProcess(identity, await processIdentity(identity.hostPid)), "native_process_identity_changed");
        child.kill("SIGTERM");
        const timer = setTimeout(() => { void (async () => {
          assert(sameProcess(identity, await processIdentity(identity.hostPid)), "native_process_identity_changed"); child.kill("SIGKILL");
        })().catch(() => { process.exitCode = 1; }); }, 10000);
        try { const result = await terminal; assert(result.code === 0 && result.signal === null, "web2_native_unclean_exit"); }
        finally { clearTimeout(timer); }
        assert(await processIdentity(identity.hostPid) === null, "web2_native_lifetime_remains");
      })(); return stopping;
    } };
    active = owner;
    try {
      await writeExclusive(join(scratch, mode + "-process.json"), JSON.stringify(identity) + "\n");
      const reply = await privateReady(socket);
      assert(reply.initialized === true && (mode === "initialize" || reply.bootId === bootId), "actual_web2_startup_required");
      await current();
      await writeExclusive(join(scratch, mode + "-readback.json"), JSON.stringify({ installationId: plan.installationId,
        planDigest: canonicalDigest(plan), artifactDigest: release.artifactDigest, reply }) + "\n");
      await syncDirectory(scratch);
      if (mode === "serve") {
        const result = await terminal;
        assert(stopped && result.code === 0 && result.signal === null, "unexpected_web2_native_exit");
      }
    } finally {
      if (await processIdentity(identity.hostPid)) await owner.stop();
      active = undefined;
    }
  }
  try {
    // The real idempotent initializer checks the retained ledger/original on every
    // boot before queue/scheduler ingress opens. It does not reset application data.
    await phase("initialize"); await phase("serve");
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert(process.argv.length === 3, "exact_web2_launch_configuration_required");
  await runWeb2Native(process.argv[2]!);
}
