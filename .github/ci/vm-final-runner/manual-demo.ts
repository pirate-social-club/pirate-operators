// Derived from the sealed native fixture. The participant drives all Wizard actions.
// Actual installed app and bundled services; provider/account SDK transports explicitly simulated.
import assert from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as tlsServer, request as tlsRequest } from "node:https";
import { generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, readdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { getHeapSpaceStatistics } from "node:v8";
import { bytesToHex, createWalletClient, http, keccak256, sha256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Browser } from "../../apps/community-wizard/node_modules/playwright-core/types/types.d.ts";
import { web2SongChain, web2Owner } from "../../test/fixtures/web2-first-song-chain.ts";
import { canonical, hashJson, hashText, object, publicId, token } from "../../packages/community/common.ts";
import { address } from "../../packages/community/manifest-core.ts";
import { directoryV3Abi } from "../../packages/community/web2-directory.ts";
import { provisionHostedInvite, allOperations } from "../../packages/community/hosted-enrollment-store.ts";
import { policyDocument, parsePlan, type HostedPolicy } from "../../packages/community/hosted-enrollment.ts";
import { canonicalDigest, signRecord, verifyRecord, readPrivateJSON, type SignedRecord } from "../../deploy/linux/installed-records.ts";
import { acquireOperation, createJSON, processIdentity, sameProcess, privateDirectory } from "../../deploy/linux/backend-state.ts";
import { startManagedKeyAgent, createManagedKeyClient } from "../../deploy/linux/managed-key-channel.ts";
import type { InstalledTarget } from "../../deploy/linux/local-target-controller.ts";
import { verifyWeb2BootstrapRelease, type Web2BootstrapRelease } from "../../deploy/linux/installed-release.ts";
import { publicIngressFrom } from "../../deploy/linux/public-ingress.ts";
import {
 assertOfflineGuestNetwork, backendSha256, requireOfflineFixtureBridge, requirePreparedRehearsalImage, signDisposableBackendSelection,
 sourceHead, sourceTree, verifyRehearsalInputs,
} from "./rehearsal-preflight.ts";
import type { Web2RuntimeBindingPolicy } from "../../deploy/linux/web2-runtime-binding.ts";
import type { Web2PublishingAttachment } from "../../deploy/linux/web2-operator-inputs.ts";
import type { Web2InstallPlan } from "../../deploy/linux/web2-profile-authority.ts";
import { publishingAttachment } from "../../deploy/linux/web2-publishing-attachment.ts";
import { availablePort } from "../../test/fixtures/linux-web2-installation.ts";
import { ownedManagedPackageDependencies } from "../../test/fixtures/managed-package-dependencies.ts";
import { preparePin } from "../../packages/community/ipfs.ts";
import { validateCommunityDeploymentProfile } from "../../services/community-deployment-profile.ts";
import { managedGrantScope } from "../../packages/release/managed-publishing-admission.ts";
import { actualExternalServices, hostedProducer, recognitionInputs } from "./actual-external-services-v25.ts";
import { assertMachineImage, observeUnpairedWizard } from "./machine-startup.ts";
import type { Journal } from "../../apps/community-wizard/server/web2-journal.ts";
import { rehearsalDeadline, requireSuccessfulRehearsalTerminal } from "./rehearsal-terminal.ts";
import { installedIdentity } from "./installed-continuity.ts";
// Root chooses the exact integrated commit and the tree of the complete build.
const SOURCE = process.env.PIRATE_NATIVE_CANDIDATE_HEAD, TREE = process.env.PIRATE_NATIVE_CANDIDATE_TREE;
const releaseRecordLimit = 16 * 1024 ** 2;
assert(SOURCE === sourceHead && TREE === sourceTree, "exact_integrated_native_source_required");
const args = process.argv.slice(2), machineOnly = args.length === 1 && args[0] === "--machine-only";
assert(machineOnly || args.length === 0, "native_rehearsal_arguments_invalid");
// Root supplies the same absolute deadline used by the outer launch bound.
const rawDemoDeadline = process.env.PIRATE_DEMO_DEADLINE_MS;
assert(typeof rawDemoDeadline === "string" && /^[0-9]{13}$/.test(rawDemoDeadline), "manual_demo_deadline_required");
const demoDeadlineMs = Number(rawDemoDeadline), demoEntryMs = Date.now();
assert(Number.isSafeInteger(demoDeadlineMs) && demoDeadlineMs > demoEntryMs && demoDeadlineMs - demoEntryMs <= 5400 * 1000,
 "manual_demo_deadline_invalid");

const ROOT = process.env.PIRATE_MANUAL_RUN_ROOT;
assert(typeof ROOT === "string" && ROOT.startsWith("/") && !ROOT.includes(".."), "explicit_private_manual_run_root_required");
const roots = { artifacts: ROOT + "/artifacts", tmp: ROOT + "/tmp", controls: ROOT + "/controls" };
const own = fileURLToPath(new URL("./", import.meta.url)), worktree = resolve(own, "../.."), execute = promisify(execFile);
assert(ROOT !== "/" && ROOT !== worktree && !ROOT.startsWith(worktree + "/"), "manual_effect_root_must_be_outside_source");
assert.equal(process.cwd(), worktree); assert.equal(process.version, "v24.18.1"); assert.equal(process.env.TMPDIR, roots.tmp);
assert.equal((await execute("/usr/bin/git", ["rev-parse", "HEAD", "HEAD^{tree}"])).stdout, SOURCE + "\n" + TREE + "\n");
assert.equal((await execute("/usr/bin/git", ["status", "--porcelain=v1"])).stdout, "");
const engine = process.env.MINIFLARE_WORKERD_PATH;
assert(engine?.startsWith("/") && await realpath(engine) === engine, "exact_local_workerd_required");
assert.equal(sha256(await readFile(engine)).slice(2), "620d9f7e5eb461067e08af17316aaa087445b4232e0e98e3dd146763bd9ab394");
assert.equal(sha256(await readFile(engine + ".capnp")).slice(2), "07f642c45a85b11b7dcae8699b50fda0a14bcab8a16dea657ec706831c69014d");
assert.equal(process.env.PIRATE_MANUAL_BUILD_DIRECTORY, join(ROOT, "build"));
const { readback: isolation, isolationSha256, release, built } = await verifyRehearsalInputs(
 ROOT, join(own, "exact-wizard-installer-pins.json"), machineOnly ? "machine-only" : "interactive",
);
assertMachineImage(isolation.imageId, release, built);
const subnet = process.env.PIRATE_MANUAL_SUBNET;
assert(typeof subnet === "string" && /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}\/28$/.test(subnet), "explicit_unused_private_subnet_required");
const caddy = process.env.PIRATE_REHEARSAL_CADDY;
assert(caddy?.startsWith("/") && await realpath(caddy) === caddy, "exact_local_caddy_required");
const caddySha256 = "a563843e11cbce39c557bd429ebb787d56f49d51d9bbb3292cd9b36b37a60cdf";
assert.equal(sha256(await readFile(caddy)).slice(2), caddySha256);
const browserExecutable = process.env.PIRATE_MANUAL_CHROMIUM, browserSha256 = process.env.PIRATE_MANUAL_CHROMIUM_SHA256;
assert(process.stdin.isTTY && process.stdout.isTTY && (!machineOnly || process.stderr.isTTY), "private_rehearsal_tty_required");
if (machineOnly) {
 const [stdin, stdout, stderr] = await Promise.all([0, 1, 2].map(fd => readlink("/proc/self/fd/" + fd)));
 assert(/^\/dev\/pts\/[0-9]+$/.test(stdin!) && stdin === stdout && stdout === stderr,
  "native_machine_private_pty_required");
}
if (!machineOnly) {
 assert(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, "manual_tty_and_display_required");
 assert(process.env.PIRATE_MANUAL_CAPTURE_MODE !== "virtual", "notes_virtual_capture_unavailable");
 assert(typeof browserExecutable === "string" && browserExecutable.startsWith("/"));
 assert(typeof browserSha256 === "string" && /^[a-f0-9]{64}$/.test(browserSha256));
 assert.equal(sha256(await readFile(browserExecutable)).slice(2), browserSha256);
}
const runId = "manual-" + randomBytes(6).toString("hex"), installationId = "rehearsal-" + runId;
const state = join(ROOT, "host"), scratch = join(ROOT, "socket"),
 artifacts = join(roots.artifacts, runId), control = join(roots.controls, runId);
const nativeRuntime = "/run/pirate-visit2-native-runtime";
await privateDirectory(nativeRuntime);
assert(Buffer.byteLength(join(state, "external-transport/router.sock")) < 108, "rehearsal_unix_socket_path_too_long");
for (const path of Object.values(roots)) await privateDirectory(path);
const fixtureDockerConfig = join(ROOT, "docker");
await privateDirectory(fixtureDockerConfig);
const docker = (args: string[]) => execute("/usr/bin/docker", [
 "--host", "unix://" + isolation.dockerSocket, "--config", fixtureDockerConfig, ...args,
], { timeout: 90000, maxBuffer: 2 ** 22 });
const daemonId = (await docker(["info", "--format", "{{.ID}}"])).stdout.trim();
assert.equal(daemonId, isolation.daemonId, "rehearsal_daemon_changed");
const imageId = isolation.imageId;
const imageRows = JSON.parse((await docker(["image", "inspect", imageId])).stdout);
requirePreparedRehearsalImage(imageRows, imageId, built.files);
await assertOfflineGuestNetwork();
// Relaunching this preparation cannot silently create a child of an uncertain run.
// A stopped process needs Root's retained-state investigation, not another invite.
await writeFile(join(ROOT, "manual-run-original.json"), JSON.stringify({ schema: "pirate.web2-manual-run-original/1",
 source: SOURCE, tree: TREE, runId, installationId, state, scratch, artifacts, control,
 restart: "HELD_NO_AUTOMATIC_RELAUNCH_OR_NEW_ORIGINAL" }) + "\n", { flag: "wx", mode: 0o600 });
for (const p of [state, scratch, artifacts, control]) await mkdir(p, { mode: 0o700 });
for (const name of ["authority", "service-secrets", "control", "wizard", "nonces", "docker", "docker-build", "resources", "outputs", "maintenance", "configuration", "database", "objects", "jobs", "scheduler", "readiness", "caddy-data", "caddy-config", "external-transport", "key-channel"]) await mkdir(join(state, name), { mode: 0o700 });
const privateJSON = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item) + "\n", { flag: "wx", mode: 0o600 });
const record = (name: string, value: unknown) => privateJSON(join(artifacts, name), value);
const issuer = generateKeyPairSync("ed25519"), trust = { keyId: installationId, spki: issuer.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
const issuerFile = join(state, "service-secrets/issuer.pk8"); await writeFile(issuerFile, issuer.privateKey.export({ format: "der", type: "pkcs8" }), { flag: "wx", mode: 0o600 });
const sign = <T>(body: T) => signRecord(body, trust, issuer.privateKey.export({ format: "der", type: "pkcs8" }));
let external: Awaited<ReturnType<typeof actualExternalServices>> | undefined, hosted: Awaited<ReturnType<typeof hostedProducer>> | undefined;
let router: ReturnType<typeof createServer> | undefined, socketRouter: ReturnType<typeof createServer> | undefined, helperServer: ReturnType<typeof tlsServer> | undefined;
let sidecarId: string | undefined, appId: string | undefined, service: ChildProcess | undefined, currentBrowser: Browser | undefined, imageNetwork: string | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined, tickWork = Promise.resolve(), miningWork = Promise.resolve(), closing: Promise<void> | undefined;
let serviceStdout = "", serviceStderr = "";
// Bounded rehearsal-progress instrumentation: append-only, synchronous, crash-durable.
// Operation entry/return rows and role bindings go to native-progress.ndjson; periodic
// resident-memory samples go to native-memory.ndjson. Both are diagnostic captures and
// must never affect the rehearsal, so every row write is failure-tolerant.
const progressLogPath = join(ROOT, "logs", "native-progress.ndjson"), memoryLogPath = join(ROOT, "logs", "native-memory.ndjson");
const ndjsonLine = (path: string, row: Record<string, unknown>) => { try { appendFileSync(path, JSON.stringify(row) + "\n"); } catch { /* diagnostic capture never affects the rehearsal */ } };
const progressMark = (op: string, event: "enter" | "return") => ndjsonLine(progressLogPath, { at: new Date().toISOString(), kind: "op", op, event });
const procStat = (pid: number) => {
 try {
  const raw = readFileSync("/proc/" + pid + "/stat", "utf8"), open = raw.indexOf("("), close = raw.lastIndexOf(")");
  if (open < 0 || close <= open) return null;
  const fields = raw.slice(close + 2).split(/\s+/), rssKb = Number(fields[21]) * 4, ppid = Number(fields[1]);
  if (!Number.isFinite(rssKb) || !Number.isFinite(ppid)) return null;
  return { pid, ppid, startTicks: fields[19], comm: raw.slice(open + 1, close), rssKb };
 } catch { return null; }
};
const roleMark = (role: "launcher" | "service", pid: number) => {
 const stat = procStat(pid);
 if (stat) ndjsonLine(progressLogPath, { at: new Date().toISOString(), kind: "role", role, pid: stat.pid, ppid: stat.ppid, startTicks: stat.startTicks, comm: stat.comm });
};
// Cumulative response-transfer counters attribute the transient binary peaks:
// every response proxied by the fixture transport is fully buffered, so the
// peak bytes and busiest paths identify what the big allocations carry.
const transferStats = { count: 0, bytes: 0, peakBytes: 0, peakPath: null as string | null };
const noteTransfer = (path: string, bytes: number) => {
 transferStats.count++; transferStats.bytes += bytes;
 if (bytes > transferStats.peakBytes) { transferStats.peakBytes = bytes; transferStats.peakPath = path.slice(0, 48); }
};
// /proc/self/smaps aggregation answers what the V8 counters cannot: which
// resident mappings stay large after the JavaScript heap contracts. Anonymous
// native zones, file-backed mappings and memfd or deleted-file shared memory
// are separated so a single run attributes the unaccounted resident majority.
const smapsBreakdown = () => {
 try {
  const lines = readFileSync("/proc/self/smaps", "utf8").split("\n");
  let anonKb = 0, fileKb = 0, sharedKb = 0, name = "";
  for (const line of lines) {
   if (/^[0-9a-f]+-[0-9a-f]+ /.test(line)) {
    const rest = line.replace(/^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \S+\s*/, "").trim();
    name = rest;
   } else if (line.startsWith("Rss:")) {
    const kb = Number(line.slice(4).trim().split(/\s+/)[0]);
    if (!Number.isFinite(kb)) continue;
    if (name.includes("memfd") || name.includes("/dev/shm") || name.includes("(deleted)")) sharedKb += kb;
    else if (name === "" || name.startsWith("[")) anonKb += kb;
    else fileKb += kb;
   }
  }
  return { smapsAnonKb: anonKb, smapsFileKb: fileKb, smapsSharedKb: sharedKb };
 } catch { return { smapsAnonKb: null, smapsFileKb: null, smapsSharedKb: null }; }
};
const memorySample = () => {
 try {
  const meminfo = readFileSync("/proc/meminfo", "utf8"), available = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo);
  let uidRssKb: number | null = 0;
  const uidProcs: { pid: number, comm: string, rssKb: number }[] = [];
  for (const entry of readdirSync("/proc")) {
   if (!/^[0-9]+$/.test(entry)) continue;
   try {
    if (lstatSync("/proc/" + entry).uid !== process.getuid!()) continue;
    const stat = procStat(Number(entry));
    if (stat) { uidRssKb += stat.rssKb; uidProcs.push({ pid: stat.pid, comm: stat.comm, rssKb: stat.rssKb }); }
   } catch { /* process exited during the sweep */ }
  }
  const self = procStat(process.pid), servicePid = service?.pid, serviceStat = typeof servicePid === "number" ? procStat(servicePid) : null;
  const usage = process.memoryUsage(), kb = (bytes: number) => Math.round(bytes / 1024);
  const topRss = uidProcs.sort((a, b) => b.rssKb - a.rssKb).slice(0, 5);
  ndjsonLine(memoryLogPath, { at: new Date().toISOString(), kind: "sample", launcherRssKb: self?.rssKb ?? null,
   servicePid: serviceStat ? servicePid ?? null : null, serviceRssKb: serviceStat?.rssKb ?? null,
   memAvailableKb: available ? Number(available[1]) : null, uidRssKb,
   heapUsedKb: kb(usage.heapUsed), heapTotalKb: kb(usage.heapTotal), externalKb: kb(usage.external), arrayBuffersKb: kb(usage.arrayBuffers),
   largeObjectKb: kb(getHeapSpaceStatistics().filter(space => space.space_name === "large_object_space").reduce((total, space) => total + space.space_used_size, 0)),
   ...smapsBreakdown(),
   transferCount: transferStats.count, transferBytes: transferStats.bytes, transferPeakBytes: transferStats.peakBytes, transferPeakPath: transferStats.peakPath,
   topRss });
 } catch { /* diagnostic capture never affects the rehearsal */ }
};
roleMark("launcher", process.pid);
memorySample();
const memorySampler = setInterval(memorySample, 2000); memorySampler.unref();
const bootstrapBody: Web2BootstrapRelease = { schema: "pirate.linux-web2-bootstrap-release/1", sourceHead: SOURCE, sourceTree: TREE, root: release, sourceRoot: release + "/source", execution: built.execution, files: built.files, sourceHashes: built.sourceHashes, imageId, artifactDigest: "0x" + canonicalDigest(built.files), sourceDigest: "0x" + canonicalDigest(built.sourceHashes) }, bootstrap = sign(bootstrapBody);
const validatedRelease = await verifyWeb2BootstrapRelease(bootstrap, trust);
 assert(validatedRelease.imageId === imageId && validatedRelease.files["source/backend.ts"] === backendSha256,
  "rehearsal_signed_bootstrap_changed");
const holder = await processIdentity(process.pid); assert(holder);
const lease = await acquireOperation(control, "native25-" + runId, installationId, { source: SOURCE, tree: TREE, state, scratch, artifacts }, holder.pidNamespace);
const dockerConfig = join(state, "docker");
const roleNames = ["registrar", "funder", "publisher", "moderator", "recognizer"] as const;
const roles = new Map<string, { address: `0x${string}`; file: string }>();
for (const name of roleNames) { const key = generatePrivateKey(), account = privateKeyToAccount(key), file = join(state, "service-secrets", name + ".key");
 await writeFile(file, Buffer.from(key.slice(2), "hex"), { flag: "wx", mode: 0o600 }); roles.set(name, { address: address(account.address.toLowerCase()), file });
 if (name === "publisher") await writeFile(join(state, "authority/publisher.key"), key, { flag: "wx", mode: 0o600 }); }
const auth = randomBytes(32), roleSocket = join(control, "roles.sock");
const { roleAgent, roleClient, role, recognition, chain } = await (async () => {
 const roleAgent = await startManagedKeyAgent({ directory: control, socket: roleSocket, installationId, lease, authenticationKey: auth,
 keys: ["registrar", "funder", "moderator", "recognizer"].map(ref => ({ ref, generation: 1, path: roles.get(ref)!.file, bytes: 32 })), signingKeyFile: issuerFile, trust, permittedProfileDigests: new Set(), capturedRoots: [join(state, "database"), join(state, "objects")] });
 let roleClient: Awaited<ReturnType<typeof createManagedKeyClient>> | undefined;
 try {
  roleClient = await createManagedKeyClient({ socket: roleSocket, installationId, authenticationKey: auth, lease });
  const client = roleClient, role = (ref: string) => client.withKey(ref, 1, async bytes => bytesToHex(bytes));
  const recognition = recognitionInputs(await role("recognizer"), runId);
  const chainStarted = performance.now();
  const chain = await web2SongChain(recognition.profile, { evidenceDirectory: join(artifacts, "chain"), historyLimit: 20000 })
   .catch(async (error: unknown) => {
    try {
     if (!machineOnly && process.env.PIRATE_MANUAL_BROWSER_CONTROL === "disposable-loopback") {
      const name = error instanceof Error ? error.name : "";
      const classes = ["WaitForTransactionReceiptTimeoutError", "TransactionReceiptNotFoundError",
       "TransactionNotFoundError", "HttpRequestError", "TimeoutError", "AssertionError", "AbortError"];
      const errorClass = classes.includes(name) ? name : "Other";
      const elapsedMs = Math.round(performance.now() - chainStarted);
      await writeFile(join(ROOT, "notes-chain-init-refusal.json"),
       JSON.stringify({ phase: "fixture-chain-init", errorClass, elapsedMs }) + "\n",
       { flag: "wx", mode: 0o600, flush: true });
     }
    } catch { /* Preserve the original chain failure even if the diagnostic write fails. */ }
    throw error;
   });
  return { roleAgent, roleClient, role, recognition, chain };
 } catch (error) { roleClient?.dispose(); await roleAgent.close(); throw error; }
 finally { auth.fill(0); }
})();
const cancel = new AbortController(), tickFacts: unknown[] = [];

const deadline = setTimeout(() => cancel.abort(Error(rehearsalDeadline)), Math.max(0, demoDeadlineMs - Date.now()));
const nativeName = "pw2-" + runId + "-app";
async function container(id: string) { const rows: unknown = JSON.parse((await docker(["inspect", id])).stdout); assert(Array.isArray(rows) && rows.length === 1); return object(rows[0]); }
async function stopContainer(id: string, label: "io.pirate.fixture" | "io.pirate.installation") { const row = await container(id); assert(row.Id === id && row.Image === imageId && object(object(row.Config).Labels)[label] === installationId); if (object(row.State).Running) await docker(["stop", "--time", "5", id]); }
async function stopChild(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return; const terminal = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([terminal, new Promise<never>((_, reject) => setTimeout(() => reject(Error("owned_service_shutdown_uncertain")), 30000).unref())]); }
const closeMark = (step: string) => appendFileSync(join(ROOT, "logs", "close.stderr.log"), new Date().toISOString() + " " + step + "\n");
async function close() { return closing ??= (async () => { closeMark("enter"); clearTimeout(deadline); if (tickTimer) clearInterval(tickTimer); const errors: unknown[] = [];
 const settle = async (f: () => Promise<unknown>) => { try { await f(); } catch (e) { errors.push(e); } };
 closeMark("browser-before"); await settle(async () => currentBrowser?.close()); closeMark("browser-after");
 // Do not stop the application or fixture stack while the selected service may
 // still hold its control lock or an in-progress original operation.
 closeMark("service-before"); if (service) {
  try { await stopChild(service); }
  catch (error) {
   await createJSON(artifacts, "installed-shutdown-held", { pid: service.pid, stateRetained: true });
   throw error;
  }
  assert(service.exitCode === 0 && service.signalCode === null, "installed_shutdown_terminal_uncertain"); closeMark("service-after");
 }
 closeMark("containers-before"); await settle(async () => {
  for (const [name, label] of [[nativeName, "io.pirate.installation"], ["pw2-" + runId + "-transport", "io.pirate.fixture"]] as const) {
   const ids = (await docker(["ps", "--all", "--no-trunc", "--filter", "name=^/" + name + "$", "--filter", "label=" + label + "=" + installationId, "--format", "{{.ID}}"])).stdout.trim().split("\n").filter(Boolean);
   assert(ids.length <= 1); if (ids[0]) await stopContainer(ids[0], label);
  }
 }); closeMark("containers-after");
 closeMark("servers-before"); for (const server of [helperServer, socketRouter, router]) if (server?.listening) await settle(() => new Promise<void>((yes, no) => { server.closeAllConnections(); server.close(error => error ? no(error) : yes()); }));
 closeMark("servers-after"); await settle(() => tickWork); closeMark("tick-after"); await settle(() => miningWork); closeMark("mining-after"); await settle(async () => external?.close()); closeMark("external-after"); await settle(async () => hosted?.close()); closeMark("hosted-after");
 closeMark("chain-dump-before"); await settle(async () => record("owned-local-chain-state.json", { dump: await chain.rpc("anvil_dumpState", [false]), localOnly: true })); closeMark("chain-dump-after");
 await settle(() => chain.close()); closeMark("chain-close-after"); roleClient.dispose(); await settle(() => roleAgent.close()); closeMark("role-agent-after");
 closeMark("lease-before"); await lease.record("native25-terminal", { errors: errors.length, stateRetained: true }); closeMark("lease-after");
 await writeFile(join(artifacts, "installed-service.stdout.log"), serviceStdout.replace(/Private pairing code: [A-Za-z0-9_-]+/g, "Private pairing code: [redacted]"), { flag: "wx", mode: 0o600 });
 await writeFile(join(artifacts, "installed-service.stderr.log"), serviceStderr, { flag: "wx", mode: 0o600 });
 closeMark("terminal-before"); await record("terminal.json", { at: new Date().toISOString(), ownPid: holder, appId, sidecarId, imageId, imageNetwork, observedCleanupErrors: errors.map(e => e instanceof Error ? e.message : "unknown"), stateRetained: true, tickFacts, realMoss: "UNRUN", publicProvider: "UNRUN" }); closeMark("terminal-after");
 if (errors.length) throw new AggregateError(errors, "owned_native25_cleanup_uncertain");
 })(); }
process.once("SIGUSR2", () => cancel.abort(Error("root_native32_diagnostic_cancel")));
process.once("SIGTERM", () => cancel.abort(Error("root_native25_cancelled"))); process.once("SIGINT", () => cancel.abort(Error("root_native25_cancelled")));
let machineObservation: (Awaited<ReturnType<typeof observeUnpairedWizard>> & {
 observedAt: string;
 servicePid: number;
 signedBootstrapSha256: string;
 signedBindingPolicySha256: string;
 fixtureIssuerSpkiSha256: string;
 publisherCustodyBindingDigest: Hex;
}) | undefined;
fixtureRun: try {
 for (const name of roleNames) await chain.rpc("anvil_setBalance", [roles.get(name)!.address, "0x3635c9adc5dea00000"]);
 const admin = privateKeyToAccount(`0x${"61".repeat(32)}`), adminWallet = createWalletClient({ account: admin, chain: chain.client.chain, transport: http(chain.deployment.rpcUrl, { retryCount: 0 }) });
 const registrarContract = { address: chain.profile.directory, abi: directoryV3Abi };
 const registrarBeforeBlock = await chain.client.getBlock({ blockTag: "latest" });
 const registrarBefore = await chain.client.readContract({ ...registrarContract, functionName: "registrarPermission", blockNumber: registrarBeforeBlock.number });
 const registrarValidUntil = BigInt(Math.floor(demoDeadlineMs / 1000)), registrarTotalLimit = 10n;
 const fixtureSetupRpc = machineOnly ? null : chain.deployment.rpcUrl;
 if (fixtureSetupRpc !== null) {
  const rpc = new URL(fixtureSetupRpc);
  assert(rpc.protocol === "http:" && rpc.hostname === "127.0.0.1" && Number(rpc.port) > 0 &&
   rpc.pathname === "/rpc" && !rpc.username && !rpc.password && !rpc.search && !rpc.hash,
   "native_fixture_setup_rpc_scope_required");
  assert.deepEqual([chain.effects.broadcasts, chain.broadcastTransactions.length], [0, 0],
   "native_fixture_setup_prior_broadcast");
 }
 // The existing chain fixture has already consumed its registrar permission.
 // Use the observed global revision once; a conflict must fail, never retry/reset.
 const registrarHash = await adminWallet.writeContract({ ...registrarContract, functionName: "configureRegistrar", args: [roles.get("registrar")!.address, registrarValidUntil, registrarTotalLimit, registrarBefore.revision], gasPrice: 1000000n });
 const registrarReceipt = await chain.client.waitForTransactionReceipt({ hash: registrarHash }); assert.equal(registrarReceipt.status, "success");
 await fresh(); // Existing owned local safe-view helper; no authority/state shortcut.
 const registrarConfirmedBlock = await chain.client.getBlock({ blockTag: "safe" }); assert(registrarReceipt.blockNumber <= registrarConfirmedBlock.number);
 assert.equal((await chain.client.getBlock({ blockNumber: registrarBeforeBlock.number })).hash, registrarBeforeBlock.hash);
 assert.equal((await chain.client.getBlock({ blockNumber: registrarReceipt.blockNumber })).hash, registrarReceipt.blockHash);
 const registrarSuccessor = await chain.client.readContract({ ...registrarContract, functionName: "registrarPermission", blockNumber: registrarConfirmedBlock.number });
 assert.equal((await chain.client.getBlock({ blockNumber: registrarConfirmedBlock.number })).hash, registrarConfirmedBlock.hash);
 assert.equal(address(registrarSuccessor.account.toLowerCase()), roles.get("registrar")!.address);
 assert.equal(registrarSuccessor.validUntil, registrarValidUntil); assert.equal(registrarSuccessor.totalLimit, registrarTotalLimit);
 assert.equal(registrarSuccessor.revision, registrarBefore.revision + 1n); assert.equal(registrarSuccessor.totalRegistered, registrarBefore.totalRegistered);
 function verifiedFixtureSetupBroadcast(rpcUrl: string) {
  assert.equal(chain.deployment.rpcUrl, rpcUrl, "native_fixture_setup_rpc_changed");
  assert.equal(registrarReceipt.transactionHash, registrarHash, "native_fixture_setup_receipt_changed");
  assert.deepEqual([chain.effects.broadcasts, chain.broadcastTransactions.length], [1, 1],
   "native_fixture_setup_unexpected_broadcasts");
  assert.equal(keccak256(chain.broadcastTransactions[0]!), registrarHash, "native_fixture_setup_broadcast_changed");
  return chain.effects.broadcasts;
 }
 if (fixtureSetupRpc !== null) verifiedFixtureSetupBroadcast(fixtureSetupRpc);
 await record("registrar-permission-succession.json", { directory: registrarContract.address, beforeBlock: { number: registrarBeforeBlock.number, hash: registrarBeforeBlock.hash }, before: registrarBefore,
  transactionHash: registrarHash, receiptBlock: { number: registrarReceipt.blockNumber, hash: registrarReceipt.blockHash }, confirmedBlock: { number: registrarConfirmedBlock.number, hash: registrarConfirmedBlock.hash }, successor: registrarSuccessor });
 const dependencies = await ownedManagedPackageDependencies(), rpcOrigin = "https://rpc.native25.test", contentOrigin = "https://content.native25.test", hostedOrigin = "https://hosted.native25.test", managedOrigin = "https://managed.web2.example";
 const ports = { front: await availablePort(), inner: await availablePort(), upstream: await availablePort(), http: await availablePort(), https: await availablePort(), helper: await availablePort() };
 assert.equal(new Set(Object.values(ports)).size, Object.values(ports).length);
 const origin = "https://localhost:" + ports.https, helperOrigin = "https://signing.native25.test:" + ports.helper, wizardOrigin = "http://127.0.0.1:" + ports.front;
 const { communityKey: _community, communityId: _identity, installationId: _installation, ...directory } = chain.profile;
 const notice = "Disposable local pilot; no public availability or restore guarantee.";
 const policy: HostedPolicy = { schema: "pirate.hosted-enrollment-policy/1", pilotId: "native25-local", serviceOrigin: hostedOrigin, deployment: directory,
 registrar: roles.get("registrar")!.address, funder: roles.get("funder")!.address, registrarRevision: registrarSuccessor.revision.toString(), noticeSha256: hashText(notice), inviteMaxSeconds: 3600, challengeSeconds: 1800, maxSafeBlockAgeSeconds: 600, broadcastRetrySeconds: 10, maxBroadcastAttempts: 3,
 registrationGas: "3000000", topupGas: "50000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1", extraFeeCeiling: "0", extraFeeField: "none", globalCeiling: "1000000000000000000", communityCeiling: "100000000000000000", recipientCeiling: "100000000000000000", controllerInitialWei: "1000000000000000", publisherInitialWei: "2000000000000000" };
 hosted = await hostedProducer({ dependencies, chain, state, artifacts, runId, policy, rpcOrigin, contentOrigin, registrar: await role("registrar"), funder: await role("funder"), effectsDisabled: machineOnly });
 const inviteToken = machineOnly ? undefined : token();
 if (inviteToken) await provisionHostedInvite(hosted.db(), policy, { id: publicId(), token: inviteToken, allowanceId: publicId(), expiresAt: Math.min(Math.floor(Date.now() / 1000) + 3500, Math.floor(demoDeadlineMs / 1000)) }, Math.floor(Date.now() / 1000), hosted.pkg.profile.configuration.schemaContext);
 const publisher = roles.get("publisher")!.address, custodyBinding = { keyReference: "publisher", generation: 1, installationId, publisher }, custody = { ...custodyBinding, custodyBindingDigest: hashJson(custodyBinding) };
 const credential = randomBytes(32).toString("base64url"), credentialFile = join(state, "service-secrets/admission.credential"); await writeFile(credentialFile, credential, { flag: "wx", mode: 0o600 });
 const producerCredential = randomBytes(32).toString("base64url"), producerCredentialFile = join(state, "service-secrets/producer.credential"); await writeFile(producerCredentialFile, producerCredential, { flag: "wx", mode: 0o600 });
 const helperKey = join(state, "authority/helper.key"), helperCert = join(state, "authority/helper.pem"), key = join(state, "authority/upstream.key"), cert = join(state, "authority/upstream.pem");
 for (const [name, keyFile, certFile] of [["signing.native25.test", helperKey, helperCert], ["upstream.test", key, cert]]) await execute("/usr/bin/openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=" + name, "-addext", "subjectAltName=DNS:" + name, "-keyout", keyFile!, "-out", certFile!], { timeout: 10000 });
 await execute("/usr/bin/chmod", ["600", helperKey, helperCert, key, cert]);
 const inputBodyFile = join(state, "configuration/managed-input-body.json");
 external = await actualExternalServices({ dependencies, chain, state, artifacts, runId, installationId, ...recognition, recognitionKey: await role("recognizer"), moderationKey: await role("moderator"), trust, sign, rpcOrigin, contentOrigin, helperOrigin,
  nativeOrigin: () => origin, caFile: () => join(state, "caddy-data/pki/authorities/local/root.crt"), hostedDb: () => hosted!.db(), policy, custody, hostedContext: hosted.pkg.profile.configuration.schemaContext,
 credential: { keyReference: "managed-credential", generation: 1, sha256: hashText(credential) }, limits: { songs: 3, pinAdds: 15, pinBytes: String(64 * 1024 * 1024), recognitionRequests: 12, postFeeWei: "90000000000000" }, grantSeconds: Math.floor((demoDeadlineMs - Date.now()) / 1000), managedInputBodyFile: inputBodyFile });
 await assertOfflineGuestNetwork();
 const bridgeName = "pwb" + runId.slice(-12);
 const networkId = (await docker(["network", "create", "--driver", "bridge", "--subnet", subnet, "--ipv6=false",
  "--opt", "com.docker.network.bridge.name=" + bridgeName,
  "--opt", "com.docker.network.bridge.gateway_mode_ipv4=nat",
  "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
  "--label", "io.pirate.fixture=" + installationId, "pw2-" + runId])).stdout.trim();
 imageNetwork = networkId;
 const network = JSON.parse((await docker(["network", "inspect", networkId])).stdout);
 requireOfflineFixtureBridge(network, networkId, bridgeName, installationId, subnet);
 await assertOfflineGuestNetwork(bridgeName);
 const handler = (req: IncomingMessage, res: ServerResponse) => { void (async () => {
  const url = new URL(req.url ?? "/", "http://fixture"), chunks: Buffer[] = []; let size = 0;
  for await (const b of req) { size += b.length; assert(size < 2 ** 22); chunks.push(Buffer.from(b)); } const body = Buffer.concat(chunks), method = req.method ?? "GET";
  let response: Response;
  if (url.pathname === "/managed-inputs") {
   assert(method === "POST" && req.headers["x-pirate-installation"] === installationId); const auth = req.headers.authorization ?? "";
   assert(auth.length === producerCredential.length + 7 && timingSafeEqual(Buffer.from(auth), Buffer.from("Bearer " + producerCredential)));
   const nomination = object(JSON.parse(body.toString())); await external!.admit((await import("../../packages/release/managed-publishing-admission.ts")).managedGrantScope(nomination.scope)); response = Response.json({ produced: true });
  } else if (url.pathname === "/configuration-pin") {
   const pin = object(JSON.parse(body.toString())); assert(Array.isArray(pin.bytes) && typeof pin.sha256 === "string" && typeof pin.uri === "string"); const bytes = Uint8Array.from(pin.bytes); const actual = await preparePin(bytes, "application/json");
   assert.equal(actual.sha256, pin.sha256); assert.equal(actual.uri, pin.uri); chain.contents.set(actual.uri.slice(7), bytes); response = Response.json({});
  } else if (url.pathname === "/rpc" || url.pathname === "/fixture/chain/rpc") response = await fetch(chain.deployment.rpcUrl, { method, headers: { "content-type": "application/json" }, body, redirect: "error" });
  else if (url.pathname.startsWith("/ipfs/") || url.pathname.startsWith("/fixture/chain/ipfs/")) { const bytes = chain.contents.get(url.pathname.slice(url.pathname.indexOf("/ipfs/") + 6)); response = bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 }); }
  else {
   const match = /^\/fixture\/(managed|recognition)(\/.*)$/.exec(url.pathname);
   if (match) {
    const logical = match[1] === "managed" ? managedOrigin : recognition.profile.origin, headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== "host") headers.set(k, Array.isArray(v) ? v.join(",") : v);
    response = await external!.fetch(match[1]!, new Request(logical + match[2] + url.search, { method, headers, body: ["GET", "HEAD"].includes(method) ? undefined : body }));
   } else { assert(!machineOnly && ["/prepare", "/redeem", "/status", "/initial-topup"].includes(url.pathname) && !url.search); response = await hosted!.fetch(new Request(hostedOrigin + url.pathname, { method, headers: { "content-type": "application/json" }, body: ["GET", "HEAD"].includes(method) ? undefined : body })); }
  }
  const responseBytes = Buffer.from(await response.arrayBuffer()); noteTransfer(url.pathname, responseBytes.length);
  res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(responseBytes);
 })().catch(() => { if (!res.headersSent) res.writeHead(503).end("owned fixture transport unavailable"); else res.destroy(); }); };
 router = createServer(handler); router.listen(0, "127.0.0.1"); await once(router, "listening"); const routerAddress = router.address(); assert(routerAddress && typeof routerAddress !== "string"); const routerOrigin = "http://127.0.0.1:" + routerAddress.port;
 const socket = join(state, "external-transport/router.sock"); socketRouter = createServer(handler); socketRouter.listen(socket); await once(socketRouter, "listening"); await execute("/usr/bin/chmod", ["600", socket]);
 helperServer = tlsServer({ key: await readFile(helperKey), cert: await readFile(helperCert) }, (req, res) => { void (async () => { assert(req.headers.host === new URL(helperOrigin).host); const response = await external!.fetch("helper", new Request(helperOrigin + req.url, { method: req.method, headers: { host: req.headers.host } })); const helperBytes = Buffer.from(await response.arrayBuffer()); noteTransfer("helper:" + new URL(req.url ?? "/", helperOrigin).pathname.slice(0, 40), helperBytes.length); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(helperBytes); })().catch(() => res.writeHead(503).end()); }); helperServer.listen(ports.helper, "127.0.0.1"); await once(helperServer, "listening");
 const proxyCode = `const h=require('node:http');const s=h.createServer((q,r)=>{const p=h.request({socketPath:${JSON.stringify(socket)},path:q.url,method:q.method,headers:q.headers},a=>{r.writeHead(a.statusCode,a.headers);a.pipe(r)});p.on('error',()=>r.writeHead(503).end());q.pipe(p)});s.listen(8180,'0.0.0.0');process.on('SIGTERM',()=>{s.closeAllConnections();s.close(()=>process.exit(0))})`;
 sidecarId = (await docker(["run", "--detach", "--name", "pw2-" + runId + "-transport", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "1000:1000", "--network", networkId, "--label", "io.pirate.fixture=" + installationId, "--mount", "type=bind,src=" + join(state, "external-transport") + ",dst=" + join(state, "external-transport") + ",readonly", "--entrypoint", release + "/toolchain/node", imageId, "-e", proxyCode])).stdout.trim();
 const sidecar = await container(sidecarId), networks = object(object(sidecar.NetworkSettings).Networks); const ownNetwork = Object.values(networks).map(object).find(n => n.NetworkID === networkId); assert(ownNetwork && typeof ownNetwork.IPAddress === "string"); const fixturePeer = ownNetwork.IPAddress;
 const fixtureRouterOrigin = "http://" + fixturePeer + ":8180"; // Fixture bridge peer with no published port.
 const argv = [release + "/toolchain/node", release + "/full-launch.mjs", join(state, "configuration/web2-launch.json")], probe = "pw2-" + runId + "-probe";
 const probeId = (await docker(["create", "--name", probe, "--hostname", nativeName, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--restart=no", "--user", "1000:1000", "--network", networkId, "--label", "io.pirate.installation=" + installationId, "--label", "io.pirate.resource=application", "--publish", "127.0.0.1:" + ports.upstream + ":8443", "--entrypoint", argv[0]!, imageId, ...argv.slice(1)])).stdout.trim();
 const probeRow = await container(probeId); assert(probeRow.Id === probeId && object(object(probeRow.Config).Labels)["io.pirate.installation"] === installationId && !object(probeRow.State).Running); const configurationDigest = canonicalDigest(probeRow.Config); await docker(["rm", probeId]);
 const stateRoots = {
  database: join(state, "database"), objects: join(state, "objects"), jobs: join(state, "jobs"),
  scheduler: join(state, "scheduler"), readiness: join(state, "readiness"), configuration: join(state, "configuration"),
 }, writable = Object.values(stateRoots);
 const appContainer: InstalledTarget["containers"][number] = {
  key: "application", name: nativeName, imageId, configurationDigest, ingress: true, user: "1000:1000", argv,
  roles: ["application", "database", "objects", "jobs", "scheduler", "assets"], network: networkId,
  mounts: [...writable.map(path => ({ source: path, target: path, readOnly: false })),
   { source: join(state, "authority"), target: join(state, "authority"), readOnly: true },
   { source: join(state, "maintenance"), target: join(state, "maintenance"), readOnly: true },
   { source: scratch, target: scratch, readOnly: false },
   { source: nativeRuntime, target: nativeRuntime, readOnly: false }],
  ports: [{ ip: "127.0.0.1", host: ports.upstream, container: 8443 }],
 };
 const machineId = (await readFile("/etc/machine-id", "utf8")).trim();
 assert(process.env.HOME);
 const target: InstalledTarget = {
  installationId, daemonId, docker: "/usr/bin/docker", dockerSha256: sha256(await readFile("/usr/bin/docker")).slice(2),
  socket: isolation.dockerSocket, dockerConfig, stateRoot: state, maintenanceDirectory: join(state, "maintenance"),
  resourceDirectory: join(state, "resources"), outputDirectory: join(state, "outputs"), cwd: release,
  environment: { HOME: process.env.HOME, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC" },
  containers: [appContainer], hostWriters: [],
  allowedReadOnlyRoots: [join(state, "authority"), join(state, "maintenance")], allowedWritableRoots: [...writable, scratch, nativeRuntime],
 };
 const ingress = publicIngressFrom({
  schema: "pirate.linux-public-ingress/1", origin, upstream: "https://127.0.0.1:" + ports.upstream,
  upstreamServerName: "upstream.test", upstreamCaFile: cert, upstreamCaSha256: sha256(await readFile(cert)).slice(2),
  executable: caddy, executableSha256: caddySha256, configurationFile: join(state, "caddy-config/Caddyfile"),
  dataDirectory: join(state, "caddy-data"), httpPort: ports.http, httpsPort: ports.https, tls: { kind: "local-fixture-ca" },
 });
 await writeFile(join(state, "authority/readback.key"), randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); await privateJSON(join(state, "authority/probes.json"), []);
 const durableScope = randomBytes(32).toString("hex");
 const graph: Web2RuntimeBindingPolicy["graph"] = { installationId, durableScope, releaseRoot: release, schemaPath: release + "/workerd.capnp", stateRoots, socket: scratch + "/control.sock", applicationBindings: [{ name: "APPLICATION_PROFILE_HASH", text: hashText("installed-first-song") }, { name: "MANAGED_PROFILE_HASH", text: hashText("native25 actual packaged managed") }, { name: "RECOGNITION_PROFILE_JSON", text: canonical(recognition.profile) }], actors: [], requiredRoles: appContainer.roles,
 queueConfiguration: { version: 1, scope: durableScope, name: "community", batchSize: 10, maxAttempts: 5, leaseMs: 30000, retryDelaySeconds: 1, defaultDelaySeconds: 0, maxEntries: 100, maxBytes: 1048576 }, maintenanceConfiguration: { version: 1, scope: durableScope, name: "community", intervalSeconds: 60, retryDelaySeconds: 1, leaseMs: 30000 }, allowedOrigins: [rpcOrigin, contentOrigin, managedOrigin, recognition.profile.origin], secretBindings: [{ name: "COMMUNITY_PUBLISHER_PRIVATE_KEY", path: join(state, "authority/publisher.key") }], listenAddress: "0.0.0.0:8443", tls: { keyFile: key, certificateFile: cert }, migrationPlanFile: release + "/migration-plan.json", probePlanFile: join(state, "authority/probes.json"), readbackKeyFile: join(state, "authority/readback.key"), fixtureTransport: { schema: "pirate.linux-local-fixture-transport/1", peer: fixturePeer, routes: [{ origin: rpcOrigin, upstream: fixtureRouterOrigin + "/fixture/chain" }, { origin: contentOrigin, upstream: fixtureRouterOrigin + "/fixture/chain" }, { origin: managedOrigin, upstream: fixtureRouterOrigin + "/fixture/managed" }, { origin: recognition.profile.origin, upstream: fixtureRouterOrigin + "/fixture/recognition" }] } };
 const now = Date.now();
 assert(now < demoDeadlineMs, "rehearsal_window_expired");
 const bindingPolicy = sign<Web2RuntimeBindingPolicy>({
  schema: "pirate.web2-runtime-binding-policy/1", bootstrapArtifactDigest: bootstrapBody.artifactDigest,
  bootstrapSourceDigest: bootstrapBody.sourceDigest, installationId, generation: 1, issuedAt: now,
  expiresAt: demoDeadlineMs, origin, hostFingerprint: canonicalDigest({ machineId, daemonId, installationId, stateRoot: state }),
  graph, target, ingress, currentAdmissionFile: join(state, "authority/web2-host-admission.json"),
  bindingDirectory: join(state, "configuration"), nativeRuntimeDirectory: nativeRuntime,
 });
 const { schema: _schema, name: _name, origin: _origin, planId: _plan, directoryProfile: _directory, ...template } = chain.deployment;
 const deployment = { ...template, rpcUrl: rpcOrigin + "/rpc", ipfsGateways: [contentOrigin], managedOrigin };
 const publisherAuthFile = join(state, "service-secrets/publisher-channel.auth"); await writeFile(publisherAuthFile, randomBytes(32), { flag: "wx", mode: 0o600 }); const custodyFile = join(state, "configuration/publisher-custody.json"); await privateJSON(custodyFile, custodyBinding);
 const selection = signDisposableBackendSelection({
  schema: "pirate.web2-disposable-rehearsal/1", installationId, controlDirectory: join(state, "control"), fixtureIssuerKey: issuerFile, bootstrap, trust, bindingPolicy, rpcTransportUrl: chain.deployment.rpcUrl, contentOrigin: routerOrigin, hostedOrigin: routerOrigin, managedOrigin: routerOrigin, signingOrigin: helperOrigin, producerSocket: socket, producerCredentialFile, managedInputBodyFile: inputBodyFile, installedInputFile: join(state, "configuration/installed-managed-inputs.json"), custodyFile, keyAuthenticationFile: publisherAuthFile,
 keyAgent: { socket: join(state, "key-channel/publisher.sock"), directory: join(state, "key-channel"), installationId, keys: [{ ref: "publisher", generation: 1, path: roles.get("publisher")!.file, bytes: 32 }, { ref: "managed-credential", generation: 1, path: credentialFile, bytes: credential.length }, { ref: "installed-issuer", generation: 1, path: issuerFile, bytes: issuer.privateKey.export({ format: "der", type: "pkcs8" }).length }], signingKeyFile: issuerFile, trust, permittedProfileDigests: [], capturedRoots: writable },
 wizard: { policy: policyDocument(policy), notice, deployment, configuration: { operatorPayments: chain.current().operatorPayments, signingKeyId: chain.current().feed.signingKeyId, policies: { ...chain.current().policies, moderationSigner: roles.get("moderator")!.address, recognition: recognition.profile } } } }, sign);
 const selectionFile = join(state, "service-secrets/backend.json");
 await privateJSON(selectionFile, selection);
 const selected = verifyRecord(await readPrivateJSON<typeof selection>(selectionFile, releaseRecordLimit), trust);
 assert(canonicalDigest(selected) === canonicalDigest(selection.body), "rehearsal_signed_selection_changed");
 const runtimeProfileFile = join(state, "service-runtime.json"); await privateJSON(runtimeProfileFile, { schema: "pirate.linux-web2-runtime/1", installationId, backendConfigurationFile: release + "/source/backend.ts", wizardDirectory: join(state, "wizard"), pairingNonceDirectory: join(state, "nonces"), frontPort: ports.front, innerPort: ports.inner });
 const serviceConfiguration = join(state, "service.json"); await privateJSON(serviceConfiguration, { schema: "pirate.web2-local-installation/1", release: bootstrap, trust, runtimeProfileFile });
 await record("rehearsal-release-image.json", {
  schema: "pirate.web2-disposable-release-image-receipt/2",
  sourceHead: SOURCE, sourceTree: TREE, installationId, backendSha256,
  imageId, localDaemonId: daemonId, isolationSha256, bridgeNetworkId: networkId, bridgeName,
  releaseRoot: release, artifactDigest: validatedRelease.artifactDigest, sourceDigest: validatedRelease.sourceDigest,
  signedBootstrapSha256: canonicalDigest(bootstrap), signedBackendSelectionSha256: canonicalDigest(selection),
  runtimeProfileSha256: sha256(await readFile(runtimeProfileFile)).slice(2),
  serviceConfigurationSha256: sha256(await readFile(serviceConfiguration)).slice(2),
  fixtureIssuerKeyId: trust.keyId, fixtureOnly: true,
 });
 await record("inputs.json", { source: SOURCE, tree: TREE, runId, installationId, state, scratch, artifacts, control, release, imageId, networkId, ports, origins: { origin, helperOrigin, rpcOrigin, contentOrigin, hostedOrigin, managedOrigin }, roles: Object.fromEntries([...roles].map(([k, v]) => [k, v.address])), dependencies: dependencies.provenance, fixtureOnly: true });
 function fresh() {
  // Leave room for Anvil's automatic per-transaction timestamp increments.
  // Every caller shares this queue; no mining call races another refresh.
  const task = miningWork.then(async () => {
   await lease.assertHeld(); const targetTimestamp = Math.floor(Date.now() / 1000) - 30;
   const before = object(await chain.rpc("eth_getBlockByNumber", ["latest", false])); assert(typeof before.timestamp === "string");
   if (targetTimestamp > Number(BigInt(before.timestamp))) await chain.rpc("evm_setNextBlockTimestamp", [targetTimestamp]);
   await chain.rpc("anvil_mine", ["0x20", "0x0"]);
   const safe = object(await chain.rpc("eth_getBlockByNumber", ["safe", false])), wallNowSeconds = Math.floor(Date.now() / 1000);
   assert(typeof safe.timestamp === "string" && typeof safe.number === "string" && typeof safe.hash === "string");
   assert(BigInt(safe.timestamp) <= BigInt(wallNowSeconds), "fixture safe block must not be in the future");
   tickFacts.push({ at: Date.now(), kind: "owned-dev-chain-safe-view-only", targetTimestamp, wallNowSeconds, safeTimestamp: BigInt(safe.timestamp).toString(), safeNumber: safe.number, safeHash: safe.hash });
  });
  miningWork = task; return task;
 }
 async function startupMark(phase: string) {
  await writeFile(join(ROOT, "notes-startup-" + phase + ".json"),
   JSON.stringify({ phase, utc: new Date().toISOString() }) + "\n",
   { flag: "wx", mode: 0o600, flush: true });
 }
 await startupMark("fixture-refresh-enter");
 if (!machineOnly) process.stdout.write("Pirate Notes local startup prepared.\n");
 await fresh();
 await startupMark("fixture-refresh-done");
 tickTimer = setInterval(() => { tickWork = tickWork.then(fresh); void tickWork.catch(error => cancel.abort(error)); }, 10000);
 const serviceExecutable = join(release, built.execution.node);
 const serviceArgv = ["--import", join(release, built.execution.loader), join(release, "source/deploy/linux/web2-service.ts"), serviceConfiguration];
 async function wait(test: () => Promise<boolean>, seconds: number) { const end = Date.now() + seconds * 1000; while (!(await test())) { cancel.signal.throwIfAborted(); assert(Date.now() < end, "bounded_native25_wait_expired"); await new Promise(r => setTimeout(r, 500)); } }
 async function launchService(observeInitialStartup = false, pairWaitSeconds = 120) {
  cancel.signal.throwIfAborted();
  await lease.assertHeld();
  if (observeInitialStartup) await startupMark("bridge-check-enter");
  await assertOfflineGuestNetwork(bridgeName);
  if (observeInitialStartup) await startupMark("bridge-check-done");
  if (observeInitialStartup) await startupMark("service-spawn-enter");
  const child = spawn(serviceExecutable, serviceArgv, {
   cwd: release, env: { ...target.environment, TMPDIR: roots.tmp }, stdio: ["ignore", "pipe", "pipe"],
  });
  service = child;
  if (child.pid !== undefined) roleMark("service", child.pid);
  let stdout = "", code: string | undefined;
  child.stdout!.on("data", b => {
   if (serviceStdout.length + b.length > 4 * 1024 ** 2) { cancel.abort(Error("owned_service_log_bound")); return; }
   serviceStdout += String(b); stdout += String(b);
   appendFileSync(join(ROOT, "logs", "installed-service.stdout.log"), b);
   code ??= /Private pairing code: ([A-Za-z0-9_-]{43})/.exec(stdout)?.[1];
  });
  child.stderr!.on("data", b => {
   if (serviceStderr.length + b.length > 4 * 1024 ** 2) { cancel.abort(Error("owned_service_log_bound")); return; }
   serviceStderr += String(b);
   appendFileSync(join(ROOT, "logs", "installed-service.stderr.log"), b);
  });
  child.on("error", () => cancel.abort(Error("owned_service_launch_error")));
  if (observeInitialStartup && child.pid !== undefined) {
   await startupMark("service-pid-observed");
   await startupMark("pair-code-wait-enter");
  }
  progressMark("service-pair-wait", "enter");
  await wait(async () => {
   assert(child.exitCode === null && child.signalCode === null, "owned installed service exited before pairing");
   return Boolean(code);
  }, pairWaitSeconds);
  progressMark("service-pair-wait", "return");
  assert(child.pid && code);
  if (observeInitialStartup) await startupMark("pair-code-observed");
  const identity = await processIdentity(child.pid);
  assert(identity && identity.pidNamespace === holder!.pidNamespace && identity.uid === holder!.uid, "owned_installation_service_identity_required");
  if (observeInitialStartup) await startupMark("service-identity-verified");
  return { child, code, identity };
 }
 const beforeInitialStartupBroadcasts = fixtureSetupRpc === null ? 0 : verifiedFixtureSetupBroadcast(fixtureSetupRpc);
 let serviceBoot = await launchService(true);
 await startupMark("unpaired-http-enter");
 const observation = await observeUnpairedWizard(wizardOrigin, cancel.signal);
 await startupMark("unpaired-http-verified");
 const paired = (await readdir(join(state, "nonces"))).filter(name => name.startsWith("paired-")).length;
 assert.equal(paired, 0, "native_machine_unexpected_pairing");
 if (machineOnly) await hosted.assertNoRegistrationEffects();
 else await hosted.assertDisposableUnpairedZeroEffects();
 const unpairedBroadcasts = chain.effects.broadcasts - beforeInitialStartupBroadcasts;
 if (machineOnly) assert.equal(chain.effects.broadcasts, 0, "native_unpaired_unexpected_broadcast");
 else {
  assert.equal(unpairedBroadcasts, 0, "native_unpaired_unexpected_broadcast");
  assert(fixtureSetupRpc !== null, "native_fixture_setup_rpc_scope_required");
  verifiedFixtureSetupBroadcast(fixtureSetupRpc);
 }
 await startupMark("unpaired-effects-clear");
 cancel.signal.throwIfAborted();
 const unpaired = {
   ...observation,
   observedAt: new Date().toISOString(), servicePid: serviceBoot.identity.hostPid,
   signedBootstrapSha256: canonicalDigest(bootstrap), signedBindingPolicySha256: canonicalDigest(bindingPolicy),
   fixtureIssuerSpkiSha256: sha256(Buffer.from(trust.spki, "base64")).slice(2),
   publisherCustodyBindingDigest: custody.custodyBindingDigest,
 };
 if (machineOnly) {
  machineObservation = unpaired;
  break fixtureRun;
 }
 await record("notes-initial-unpaired.json", {
  ...unpaired, serviceStartTicks: serviceBoot.identity.hostStartTicks, paired, enrollmentEffects: 0,
  registrationEffects: 0, broadcasts: unpairedBroadcasts, fixtureOnly: true,
  fixtureSetupBroadcasts: beforeInitialStartupBroadcasts,
  fixtureSetupRpcSha256: hashText(fixtureSetupRpc!),
 });
 const pairingCode = serviceBoot.code;
 const { manualApplication, manualWizard } = await import("./manual-browser.ts");
 const browserInput = { executable: browserExecutable!, executableSha256: browserSha256!, artifacts, signal: cancel.signal, onBrowser: (browser: Browser) => { currentBrowser = browser; } };
 // The launcher owns the single readline interface on process.stdin for the whole rehearsal.
 // A second interface closed inside a Wizard session pauses the shared stream under this one,
 // leaving later prompts displayed but never answered; sessions receive this interface instead.
 const terminal = createInterface({ input: process.stdin, output: process.stdout });
 await startupMark("initial-wizard-browser-enter");
 await manualWizard({ ...browserInput, terminal, wizardOrigin, pairingCode, helperOrigin, helperCertificate: await readFile(helperCert), stateRoot: state, origin, invitation: inviteToken,
 async approveRegistration() {
  cancel.signal.throwIfAborted();
  await lease.assertHeld();
  const approval = await hosted!.approveRegistration();
  await record("disposable-registration-approval.json", approval);
 },
 async retireHostedKeys() {
  const saved = await readPrivateJSON<{plan: unknown; deployment: unknown; enrollment: {enrollmentId: Hex}}>(join(state, "wizard/web2-wizard-original.json"));
  const before = await allOperations(hosted!.db(), saved.enrollment.enrollmentId);
  assert.equal(before.length, 3); assert(before.every(op => op.state === "consumed"));
  await hosted!.retireEffectKeys();
  await record("hosted-keys-retired-originals.json", { operations: before.map(op => ({ id: op.id, rawSha256: op.raw ? hashText(op.raw) : null, hash: op.tx_hash, nonce: op.nonce })) });
  // Pirate's already-running service is fixture infrastructure, prepared outside
  // the browser API. The later real grants.prepare still checks this exact scope.
  const config = parsePlan(saved.plan).config, currentDeployment = validateCommunityDeploymentProfile(saved.deployment);
  assert.equal(config.controller, web2Owner.address.toLowerCase());
  const scope = managedGrantScope({schema: "pirate.web2-owner-grant-scope/1", enrollmentId: saved.enrollment.enrollmentId,
   installationId: config.installationId, hostInstallationId: installationId, deploymentDigest: hashJson(currentDeployment),
   communityId: config.communityId, origin: config.app.origin, controller: config.controller, ownerWallet: config.controller,
   policy: config.policies.admission, chainId: 6343, postsContract: config.postsContract, publisher: config.publisher});
  const began = performance.now(), prepared = await external!.admit(scope);
  await record("managed-services-prestarted.json", {seconds: (performance.now() - began) / 1000, scopeSha256: hashJson(scope),
   managedInputSha256: hashJson(prepared), originalOperations: before.map(op => ({id: op.id, hash: op.tx_hash})),
   fixtureInfrastructureOnly: true, browserGrantAndOwnerSignatureStillRequired: true});
 } });
 const app = await container(nativeName);
 assert(typeof app.Id === "string" && app.Image === imageId && object(object(app.Config).Labels)["io.pirate.installation"] === installationId);
 appId = app.Id;
 const original = await readPrivateJSON<Journal>(join(state, "wizard/web2-wizard-original.json"));
 assert.equal(original.phase, "running", "wizard_original_not_running");
 await record("manual-wizard-observed-running.json", {
  source: SOURCE, tree: TREE, appId, imageId, originalStateRetained: true,
  scope: "manual Wizard and actual local installer with disposable providers",
  realMoss: "UNRUN", publicDeployment: "UNRUN",
 });
 const certificateFile = join(state, "caddy-data/certificates/local/localhost/localhost.crt");
 const configurationDirectory = stateRoots.configuration;
 const originalFile = join(configurationDirectory, "web2-original.json");
 const intentFile = join(configurationDirectory, "web2-binding-intent.json");
 const readCurrentAuthority = async () => {
  const current = verifyRecord(await readPrivateJSON<typeof selection>(selectionFile, releaseRecordLimit), trust);
  assert.equal(canonicalDigest(current), canonicalDigest(selected), "rehearsal_signed_selection_changed");
  const policy = verifyRecord(current.bindingPolicy, trust);
  const bound = await readPrivateJSON<{
   schema: string;
   intent: { schema: string; policyDigest: string; publishingAttachment?: Web2PublishingAttachment };
  }>(join(configurationDirectory, "web2-bound-runtime.json"), releaseRecordLimit);
  assert(bound.schema === "pirate.web2-bound-runtime/1" &&
   bound.intent.schema === "pirate.web2-runtime-binding-intent/1" &&
   bound.intent.policyDigest === canonicalDigest(current.bindingPolicy) &&
   bound.intent.publishingAttachment, "rehearsal_original_publishing_authority_changed");
  const plan = verifyRecord(await readPrivateJSON<SignedRecord<Web2InstallPlan>>(
   originalFile,
  ), trust);
  const attachment = publishingAttachment(bound.intent.publishingAttachment);
  const grant = attachment.selection.grant;
  assert(plan.installationId === installationId && plan.publishingAttachmentDigest === attachment.digest &&
   attachment.selection.scope.hostInstallationId === installationId && grant.communityOrigin === origin,
   "rehearsal_original_publishing_authority_changed");
  const expiresAtMs = Math.min(policy.expiresAt, grant.expiresAt * 1000);
  const observedAtMs = Date.now();
  assert(grant.validFrom * 1000 <= observedAtMs && observedAtMs < expiresAtMs,
   "rehearsal_original_publishing_authority_outside_window");
  return {
   signedBindingPolicySha256: bound.intent.policyDigest,
   signedPlanWireSha256: sha256(await readFile(originalFile)).slice(2),
   retainedBindingWireSha256: sha256(await readFile(intentFile)).slice(2),
   attachmentDigest: attachment.digest,
   grantDigest: grant.sha256,
   ownerAuthorizationDigest: hashJson(attachment.authorization),
   expiresAtMs,
  };
 };
 const checkNotesReceipt = async (directory: string, phase: "before" | "after",
  authority: Awaited<ReturnType<typeof readCurrentAuthority>>) => {
  const { identity } = await readPrivateJSON<{ identity: Record<string, unknown> }>(
   join(directory, "w6-native-notes-binding.json"),
  );
  assert(identity.installationId === installationId && identity.origin === origin &&
   identity.grantId === authority.grantDigest && identity.attachmentDigest === authority.attachmentDigest &&
   identity.signedPlanWireSha256 === authority.signedPlanWireSha256 &&
   identity.retainedBindingWireSha256 === authority.retainedBindingWireSha256,
   "rehearsal_notes_browser_binding_changed");
  const { phase: observed, counts, proof, playback } = await readPrivateJSON<{
   phase: string; counts: Record<string, number>;
   proof: { postId: Hex; transactionHash: Hex; blockNumber: string; pinUri: string; masterSha256: Hex };
   playback: { analysis: { ok: boolean }; wire: { range: number } };
  }>(join(directory, "w6-native-notes-" + phase + ".json"));
  assert(observed === (phase === "before" ? "play_before_ordinary_restart" : "public_read_only_replay") &&
   counts.seal === (phase === "before" ? 1 : 0) && counts.blockedWrites === 0 &&
   playback.analysis.ok && playback.wire.range === 206 &&
   /^0x[a-f0-9]{64}$/.test(proof.transactionHash) && proof.pinUri.startsWith("ipfs://"),
   "rehearsal_notes_browser_evidence_incomplete");
  if (phase === "after")
   assert([counts.authChallenge, counts.authVerify, counts.create, counts.audio, counts.stems].every(count => count === 0),
    "rehearsal_notes_replay_created_effects");
  const tx = await chain.client.getTransactionReceipt({ hash: proof.transactionHash });
  const pinned = chain.contents.get(proof.pinUri.slice(7));
  assert(tx.status === "success" && tx.to?.toLowerCase() === chain.current().postsContract &&
   String(tx.blockNumber) === String(proof.blockNumber) && pinned && sha256(pinned) === proof.masterSha256,
   "rehearsal_notes_original_chain_or_pin_changed");
  return { proof, effects: { ...chain.effects } };
 };
 try {
  const beforeApplication = join(artifacts, "application-before");
  await mkdir(beforeApplication, { mode: 0o700 });
  const authority = await readCurrentAuthority();
  const effectsAtNotesEntry = { ...chain.effects };
  let decision: string | undefined;
  progressMark("application-before", "enter");
  await manualApplication({
   ...browserInput, artifacts: beforeApplication, origin, certificateFile, release,
   async control() {
    progressMark("terminal-question-before", "enter");
    decision = await terminal.question("Notes application before restart> ", { signal: cancel.signal });
    progressMark("terminal-question-before", "return");
   },
  });
  progressMark("application-before", "return");
  if (decision === "restart") {
   progressMark("notes-receipt-before", "enter");
   const notesBefore = await checkNotesReceipt(beforeApplication, "before", authority);
   progressMark("notes-receipt-before", "return");
   assert(notesBefore.effects.broadcasts === effectsAtNotesEntry.broadcasts + 1 &&
    notesBefore.effects.pinAdds > effectsAtNotesEntry.pinAdds, "rehearsal_notes_original_effects_changed");
   assert.deepEqual(await readCurrentAuthority(), authority, "rehearsal_original_publishing_authority_changed");
   assert(Math.min(demoDeadlineMs, authority.expiresAtMs) - Date.now() > 180000,
    "insufficient_original_window_for_restart");
   const snapshot = async () => {
    const application = await installedIdentity({ state, scratch, nativeRuntime, release, appId: appId!, imageId,
     installationId, app: await container(appId!), expectedMounts: appContainer.mounts });
    const transport = await container(sidecarId!), transportState = object(transport.State);
    const attached = Object.values(object(object(transport.NetworkSettings).Networks)).map(object);
    assert(transport.Id === sidecarId && transport.Image === imageId &&
     object(object(transport.Config).Labels)["io.pirate.fixture"] === installationId &&
     transportState.Running === true && typeof transportState.StartedAt === "string" &&
     typeof transportState.Pid === "number" && transportState.Pid > 0 &&
     attached.length === 1 && attached[0]!.NetworkID === networkId &&
     attached[0]!.IPAddress === fixturePeer, "rehearsal_original_fixture_peer_changed");
    return { ...application, transport: { id: sidecarId, pid: transportState.Pid, startedAt: transportState.StartedAt,
     networkId, ipv4: fixturePeer } };
   };
   const before = await snapshot();
   assert(sameProcess(serviceBoot.identity, await processIdentity(serviceBoot.identity.hostPid)), "installation_restart_owner_changed");
   await lease.assertHeld();
   await record("rehearsal-restart-original.json", {
    before, authority, notesBefore, effectsAtNotesEntry, process: serviceBoot.identity,
   });
   progressMark("restart-service-stop", "enter");
   await stopChild(serviceBoot.child);
   assert(serviceBoot.child.exitCode === 0 && serviceBoot.child.signalCode === null &&
    !await processIdentity(serviceBoot.identity.hostPid), "installation_restart_service_terminal_uncertain");
   progressMark("restart-service-stop", "return");
   assert.deepEqual(await snapshot(), before, "installation_changed_before_restart");
   progressMark("restart-container-stop", "enter");
   await docker(["container", "stop", "--time", "30", appId]);
   const stopped = await container(appId), stoppedState = object(stopped.State);
   assert(stopped.Id === before.fixed.appId && stopped.Image === before.fixed.imageId &&
    stoppedState.Running === false && stoppedState.ExitCode === 0 && stoppedState.OOMKilled === false,
    "installation_restart_container_terminal_uncertain");
   await record("rehearsal-restart-terminal.json", {
    observedAt: new Date().toISOString(), service: serviceBoot.identity,
    serviceExitCode: serviceBoot.child.exitCode, serviceSignalCode: serviceBoot.child.signalCode,
    serviceProcessAbsent: true, application: { id: appId, imageId, running: stoppedState.Running,
     exitCode: stoppedState.ExitCode, oomKilled: stoppedState.OOMKilled, finishedAt: stoppedState.FinishedAt },
   });
   progressMark("restart-container-stop", "return");
   progressMark("restart-service-launch", "enter");
   serviceBoot = await launchService(false, 300);
   progressMark("restart-service-launch", "return");
   progressMark("restart-snapshot-after", "enter");
   const after = await snapshot();
   progressMark("restart-snapshot-after", "return");
   assert.deepEqual(after.fixed, before.fixed, "installation_restart_changed_original");
   assert.deepEqual(after.transport, before.transport, "installation_restart_changed_fixture_peer");
   progressMark("restart-authority-after", "enter");
   assert.deepEqual(await readCurrentAuthority(), authority, "rehearsal_reopened_publishing_authority_changed");
   progressMark("restart-authority-after", "return");
   progressMark("restart-boot-verify", "enter");
   const freshBoots = after.boots.filter(row => !before.boots.some(previous => previous.bootId === row.bootId));
   assert(after.startedAt !== before.startedAt && freshBoots.length === 1 &&
    before.boots.every(previous => after.boots.some(row => canonical(row) === canonical(previous))) &&
    before.boots.every(row => row.planDigest === freshBoots[0]!.planDigest && row.artifactDigest === freshBoots[0]!.artifactDigest),
    "retained_application_boot_not_proved");
   progressMark("restart-boot-verify", "return");
   await record("rehearsal-restart-new-boot.json", { after, authority, process: serviceBoot.identity });
   const reopenedArtifacts = join(artifacts, "reopened");
   await mkdir(reopenedArtifacts, { mode: 0o700 });
   await manualWizard({
    ...browserInput, terminal, artifacts: reopenedArtifacts, wizardOrigin, pairingCode: serviceBoot.code,
    helperOrigin, helperCertificate: await readFile(helperCert), stateRoot: state, origin,
   });
   const reopened = await readPrivateJSON<Journal>(join(state, "wizard/web2-wizard-original.json"));
   assert(reopened.phase === "running" &&
    canonical(reopened.prepared) === canonical(original.prepared) &&
    canonical(reopened.installPlan) === canonical(original.installPlan),
    "rehearsal_reopened_original_changed");
   await record("rehearsal-reopened-original.json", {
    appId, imageId, planDigest: reopened.installPlan?.planDigest, bootId: freshBoots[0]!.bootId,
   });
   const afterApplication = join(reopenedArtifacts, "application-after");
   await mkdir(afterApplication, { mode: 0o700 });
   progressMark("application-after", "enter");
   await manualApplication({
    ...browserInput, artifacts: afterApplication, origin, certificateFile, release,
    async control() {
     progressMark("terminal-question-after", "enter");
     const final = await terminal.question("Notes application after restart> ", { signal: cancel.signal });
     progressMark("terminal-question-after", "return");
     assert.equal(final, "stop", "unknown_rehearsal_terminal_choice");
    },
   });
   progressMark("application-after", "return");
   progressMark("notes-receipt-after", "enter");
   const notesAfter = await checkNotesReceipt(afterApplication, "after", authority);
   progressMark("notes-receipt-after", "return");
   progressMark("replay-final-checks", "enter");
   assert.deepEqual(await readCurrentAuthority(), authority, "rehearsal_notes_replay_authority_changed");
   assert.deepEqual(await snapshot(), after, "rehearsal_notes_replay_changed_installation");
   assert.deepEqual(notesAfter, notesBefore, "rehearsal_notes_replay_changed_original");
   progressMark("replay-final-checks", "return");
   progressMark("replay-record", "enter");
   await record("rehearsal-notes-replay.json", { observedAt: new Date().toISOString(), authority, notesAfter });
   progressMark("replay-record", "return");
  } else assert(decision === "stop", "unknown_rehearsal_terminal_choice");
 } finally { terminal.close(); }
 await record("manual-demo-ended.json", { at: new Date().toISOString(),
  reason: cancel.signal.reason instanceof Error ? cancel.signal.reason.message : "stopped", stateRetained: true });
 requireSuccessfulRehearsalTerminal(cancel.signal);
} catch (error) {
 try { await record("manual-interruption.json", { at: new Date().toISOString(),
  reason: error instanceof Error ? error.message : "unknown", originalStateRetained: true,
  retry: "HELD_NO_AUTOMATIC_RELAUNCH_OR_NEW_ORIGINAL" }); }
 catch (evidenceError) { throw new AggregateError([error, evidenceError], "manual_interruption_evidence_incomplete"); }
 throw error;
} finally { await close(); }
if (machineObservation) {
 cancel.signal.throwIfAborted();
 assert(Date.now() < demoDeadlineMs, "native_machine_deadline_reached");
 await privateJSON(join(ROOT, "machine-only-result.json"), {
  schema: "pirate.native-unpaired-machine/1", sourceHead: SOURCE, sourceTree: TREE,
  imageId, installationId, isolationSha256, ...machineObservation, paired: 0, browserEgress: "not_run",
  stoppedAt: new Date().toISOString(), deadlineMs: demoDeadlineMs,
  registrationEffects: 0, normalStop: true,
 });
}
