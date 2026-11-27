// Focused installer readiness authorization. Uses real signatures, filesystem
// verification, chain authentication, TLS probing and process ownership; Docker
// is an inert local command fixture, so this is not image/application acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalDigest, signRecord, type SignedRecord } from "../deploy/linux/installed-records.ts";
import { createWeb2Installation } from "../deploy/linux/web2-local-installation.ts";
import type { FullRelease } from "../deploy/linux/installed-release.ts";
import type { InstalledTarget, InstalledContainer } from "../deploy/linux/local-target-controller.ts";
import { acquireOperation, hash, processIdentity } from "../deploy/linux/backend-state.ts";
import { ingressFixture, installationAuthorityFixture } from "./fixtures/linux-web2-installation.ts";
import { web2ApplicationReleaseBody } from "../packages/community/web2-native-business-binding.ts";
import { web2TargetDigest, type Web2HostAdmission } from "../deploy/linux/web2-profile-authority.ts";
import type { LinuxWeb2PlanSelection } from "../packages/community-setup/linux-web2-profile.ts";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function writableTree(path: string) {
  await chmod(path, 0o700);
  const { readdir } = await import("node:fs/promises");
  for (const row of await readdir(path, { withFileTypes: true })) {
    const child = join(path, row.name);
    if (row.isDirectory()) await writableTree(child); else await chmod(child, 0o600);
  }
}

async function modes(root: string, mode: number) {
  await chmod(root, mode);
  const { readdir } = await import("node:fs/promises");
  for (const row of await readdir(root, { withFileTypes: true }))
    if (row.isDirectory()) await modes(join(root, row.name), mode);
}

async function web2ReleaseFixture(root: string, planDirectory: string, runtimeDirectory: string, deployment: unknown) {
  const files: Record<string, string> = {}, sourceHashes: Record<string, string> = {};
  const put = async (path: string, body: string, mode = 0o444) => {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), body, { flag: "wx", mode });
    files[path] = sha(body);
  };
  for (const path of ["application.mjs","queue.mjs","maintenance.mjs","database.worker.js","bucket.worker.js",
    "object-entry.worker.js","shared.worker.js","zod.worker.js","assets.worker.mjs","asset-index.json","egress-policy.worker.mjs","deny.worker.mjs",
    "full-gateway.worker.mjs","full-startup.worker.mjs","selected-handler-observer.worker.mjs","maintenance.bootstrap.mjs","cold-reconcile.worker.mjs",
    "full-launch.mjs","workerd.capnp","workerd","migration-plan.json","wizard/index.html"])
    await put(path, "INERT READINESS FIXTURE: " + path + "\n");
  for (const path of ["backend.ts","deploy/linux/local-install-main.ts","deploy/linux/local-installation.ts",
    "deploy/linux/web2-local-installation.ts","deploy/linux/web2-launch.ts","deploy/linux/web2-service.ts","deploy/linux/web2-runtime-binding.ts",
    "deploy/linux/local-target-services.ts","deploy/linux/shared-v2-result-producer.ts",
    "packages/community/web2-native-business-binding.ts","services/community-application.ts","services/linux-community.ts"]) {
    const body = "// INERT READINESS AUTHORED FIXTURE: " + path + "\n";
    await put("source/" + path, body);
    sourceHashes[path] = sha(body);
  }
  const sourcePackage = '{"type":"module"}\n';
  await put("source/package.json", sourcePackage);
  sourceHashes["package.json"] = sha(sourcePackage);
  await put("toolchain/node", "INERT NODE FIXTURE\n", 0o555);
  await put("toolchain/node_modules/tsx/package.json", '{"name":"tsx","version":"4.20.6"}\n');
  await put("toolchain/node_modules/tsx/dist/loader.mjs", "// INERT LOADER FIXTURE\n");
  const scope = randomBytes(32).toString("hex"), state = dirname(planDirectory);
  const graph: FullRelease["graph"] = {
    installationId: "readiness-installation", durableScope: scope, releaseRoot: root, schemaPath: join(root, "workerd.capnp"),
    stateRoots: Object.fromEntries(["database","objects","jobs","scheduler","configuration","readiness"].map(k => [k, k === "configuration" ? planDirectory : join(state, k)])),
    socket: join(state, "scratch/control.sock"), applicationBindings: [], actors: [], requiredRoles: ["application"],
    queueConfiguration: { scope }, maintenanceConfiguration: { scope }, directoryRuntimeBinding: JSON.stringify(deployment),
    allowedOrigins: [], secretBindings: [], listenAddress: "127.0.0.1:8443",
    tls: { keyFile: join(state, "authority/tls.key"), certificateFile: join(state, "authority/tls.crt") },
    migrationPlanFile: join(root, "migration-plan.json"), probePlanFile: join(state, "authority/probes.json"), readbackKeyFile: join(state, "authority/readback.key"),
  };
  const release: FullRelease = {
    schema: "pirate.complete-linux-web2-release/1", sourceHead: "1".repeat(40), sourceTree: "2".repeat(40), root, sourceRoot: join(root, "source"),
    files, sourceHashes, requiredRoles: ["application"],
    execution: { node: "toolchain/node", nodeSha256: files["toolchain/node"]!, nodeVersion: "v24.18.1", loader: "toolchain/node_modules/tsx/dist/loader.mjs", tsxVersion: "4.20.6", backend: "source/backend.ts" },
    graph, artifactDigest: "0x" + canonicalDigest(files), sourceDigest: "0x" + canonicalDigest(sourceHashes), imageId: "sha256:" + "3".repeat(64),
  };
  return release;
}

function fakeDockerScript(stateFile: string) {
  return `#!/usr/bin/python3
import json,sys,time,os,secrets
state_file=${JSON.stringify(stateFile)}
def load():
 with open(state_file) as f:return json.load(f)
def save(s):
 with open(state_file,'w') as f:json.dump(s,f)
def row(s,c):
 return {'Id':c['id'],'Name':'/'+c['name'],'Image':c['imageId'],'Config':c['config'],'HostConfig':c['hostConfig'],'State':c['state'],'Mounts':c['mounts']}
def main():
 args=sys.argv[1:]
 while args and args[0] in ('--host','--config'):
  args=args[2:]
 s=load()
 if args[:2]==['info','--format']:
  print(json.dumps(s['daemon']));return 0
 if args[:4]==['container','ls','--all','--quiet']:
  if args[4:5]==['--no-trunc']:args=args[5:]
  for c in s['containers'].values():print(c['id'])
  return 0
 if args[:2]==['network','inspect']:
  print(json.dumps([{'Id':args[2],'Driver':'bridge','Scope':'local'}]));return 0
 if args[:2]==['container','create']:
  name=args[args.index('--name')+1]
  labels={}
  mounts=[]
  i=0
  while i<len(args):
   if args[i]=='--label':
    k,v=args[i+1].split('=',1);labels[k]=v;i+=2;continue
   if args[i]=='--mount':
    parts=args[i+1].split(',');src=parts[1][4:];dst=parts[2][4:];ro=any(x=='readonly' for x in parts[3:])
    mounts.append({'Source':src,'Destination':dst,'RW':not ro});i+=2;continue
   i+=1
  config=dict(s['configTemplate']);config['Labels']=labels
  cid=secrets.token_hex(32)
  s['containers'][cid]={'id':cid,'name':name,'imageId':args[args.index('--entrypoint')+2],'config':config,'hostConfig':s['hostConfig'],
   'state':{'Running':False,'Paused':False,'Restarting':False,'Dead':False,'Pid':0,'ExitCode':0,'OOMKilled':False},'mounts':mounts}
  save(s);print(cid);return 0
 if args[:2]==['container','start']:
  c=s['containers'][args[2]];c['state']['Running']=True;c['state']['Pid']=4321;save(s);print(args[2]);return 0
 if args[:2]==['container','stop']:
  c=s['containers'][args[3]];c['state']['Running']=False;c['state']['Pid']=0;save(s);print(args[3]);return 0
 if args[:2]==['inspect','--type'] and args[2]=='container':
  ids=[x for x in args[3:] if len(x)==64]
  rows=[row(s,s['containers'][x]) for x in ids]
  if '--format' in args:
   for r in rows:print(json.dumps(r))
  else:print(json.dumps(rows))
  return 0
 print('unsupported '+repr(args),file=sys.stderr);return 2
rc=main();time.sleep(.04);sys.exit(rc)
`;
}


function observationEvents(t: test.TestContext) {
 const events: Array<Record<string, unknown>> = [];
 t.mock.method(console, "error", (value: unknown) => {
  if (typeof value !== "string") return;
  try {
   const row = JSON.parse(value) as Record<string, unknown>;
   if (typeof row.event === "string") events.push(row);
  } catch {}
 });
 function verificationsAfterEnter(operation: string) {
  const enter = events.find(row => row.event === "web2-install-apply-observation" && row.operation === operation && row.phase === "enter");
  assert(enter && typeof enter.at === "number", operation + " was not entered");
  return events.filter(row => row.event === "installed-artifact-verification" && row.phase === "start" && typeof row.at === "number" && row.at >= (enter.at as number));
 }
 return { events, verificationsAfterEnter };
}

async function readinessFixture(t: test.TestContext) {
 assert(process.env.TMPDIR);
 const temporary = await realpath(process.env.TMPDIR);
 const root = await mkdtemp(join(temporary, "web2-readiness-"));
 t.after(async () => { await writableTree(root).catch(() => {}); await rm(root, { recursive: true, force: true }); });
 for (const dir of ["state/configuration","state/database","state/objects","state/jobs","state/scheduler","state/readiness","state/scratch","state/native-runtime","state/authority","state/maintenance","state/control","state/resources","state/outputs","state/docker-config","release"])
   await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
 const authority = await installationAuthorityFixture();
 t.after(authority.close);
 const ingress = await ingressFixture();
 t.after(ingress.close);
 const release = await web2ReleaseFixture(join(root, "release"), join(root, "state/configuration"), join(root, "state/native-runtime"), authority.draft.deployment);
 const keys = generateKeyPairSync("ed25519"), trust = { keyId: "readiness-test-issuer", spki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
 const privateKey = keys.privateKey.export({ format: "der", type: "pkcs8" });
 const sign = <T,>(body: T): SignedRecord<T> => signRecord(body, trust, privateKey);
 const stateFile = join(root, "fake-docker-state.json"), docker = join(root, "fake-docker");
 const daemonId = "4".repeat(64), imageId = release.imageId;
 const configTemplate = { Image: imageId, Labels: {}, Env: [], Cmd: null, Entrypoint: [join(root, "release/toolchain/node")] };
 const hostConfig = { Privileged: false, ReadonlyRootfs: true, PidMode: "", RestartPolicy: { Name: "no" }, CapDrop: ["ALL"] };
 await writeFile(stateFile, JSON.stringify({ daemon: { ID: daemonId, Name: hostname(), OSType: "linux", Architecture: "x86_64", ServerVersion: "fixture", KernelVersion: "fixture", Driver: "fixture", CgroupVersion: "2" }, containers: {}, configTemplate, hostConfig, imageId }), { mode: 0o600 });
 await writeFile(docker, fakeDockerScript(stateFile), { mode: 0o500 });
 const socketServer = createServer();
 const socketPath = join(root, "state/docker.sock");
 socketServer.listen(socketPath);
 await once(socketServer, "listening");
 t.after(async () => { socketServer.close(); });
 const machineId = (await readFile("/etc/machine-id", "utf8")).trim();
 const installationId = "readiness-installation", hostFingerprint = canonicalDigest({ machineId, daemonId, installationId, stateRoot: join(root, "state") });
 const nativeLaunchFile = join(root, "state/configuration/web2-launch.json");
 const writable = ["database","objects","jobs","scheduler","configuration","readiness","scratch"].map(k => join(root, "state", k));
 const configForDigest = { ...configTemplate, Labels: { "io.pirate.installation": installationId, "io.pirate.resource": "application" } };
 const container: InstalledContainer = {
  key: "application", name: "readiness-application", imageId, configurationDigest: canonicalDigest(configForDigest), ingress: false,
  user: "1000:1000", argv: [join(root, "release/toolchain/node"), join(root, "release/full-launch.mjs"), nativeLaunchFile], roles: ["application"], network: "5".repeat(64),
  mounts: [
   ...writable.map(p => ({ source: p, target: p, readOnly: false })),
   { source: join(root, "state/native-runtime"), target: join(root, "state/native-runtime"), readOnly: false },
   { source: join(root, "state/authority"), target: join(root, "state/authority"), readOnly: true },
   { source: join(root, "state/maintenance"), target: join(root, "state/maintenance"), readOnly: true },
  ],
  ports: [{ ip: "127.0.0.1", host: Number(new URL(ingress.ingress.upstream).port), container: 8443 }],
 };
 const target: InstalledTarget = {
  installationId, daemonId, docker, dockerSha256: sha(await readFile(docker)), socket: socketPath, dockerConfig: join(root, "state/docker-config"),
  stateRoot: join(root, "state"), maintenanceDirectory: join(root, "state/maintenance"), resourceDirectory: join(root, "state/resources"), outputDirectory: join(root, "state/outputs"), cwd: join(root, "release"),
  environment: { HOME: process.env.HOME!, PATH: process.env.PATH!, LANG: "C.UTF-8", TZ: "UTC" }, containers: [container], hostWriters: [],
  allowedReadOnlyRoots: [join(root, "state/authority"), join(root, "state/maintenance")], allowedWritableRoots: [...writable, join(root, "state/native-runtime")],
 };
 const actualIngress = { ...ingress.ingress, origin: authority.draft.origin };
 const admission: Web2HostAdmission = {
  schema: "pirate.linux-web2-host-admission/1", installationId, directoryInstallationId: authority.draft.enrollment.installationId,
  communityId: authority.draft.enrollment.communityId, generation: 1, issuedAt: Date.now(), expiresAt: Date.now() + 3600000,
  hostFingerprint, releaseArtifactDigest: release.artifactDigest, targetDigest: web2TargetDigest(target, actualIngress, join(root, "state/native-runtime")),
  draftDigest: canonicalDigest(authority.draft), revokedPlanIds: [],
 };
 await writeFile(join(root, "state/authority/web2-host-admission.json"), JSON.stringify(sign(admission)) + "\n", { mode: 0o600 });
 const processIdentityNow = await processIdentity(process.pid); assert(processIdentityNow);
 const lease = await acquireOperation(join(root, "state/control"), "readiness-test", installationId, { purpose: "focused readiness authorization" }, processIdentityNow.pidNamespace);
 await modes(join(root, "release"), 0o555);
 const releaseRecord = sign(release);
 const applicationRelease = sign(web2ApplicationReleaseBody(release));
 const host = {
  release: releaseRecord, applicationRelease, trust, lease, target, ingress: actualIngress, chain: authority.authority,
  currentAdmissionFile: join(root, "state/authority/web2-host-admission.json"), minimumGeneration: 1,
  planDirectory: join(root, "state/configuration"), hostFingerprint, nativeRuntimeDirectory: join(root, "state/native-runtime"), now: () => Date.now(),
  signProfile: async (body: never) => sign(body),
 };
 const installation = await createWeb2Installation(host);
 t.after(async () => { await installation.shutdownService().catch(() => {}); });
 async function prepareAndApply(upstream: () => void) {
  upstream();
  const summary = await installation.prepare(authority.draft);
  const selection: LinuxWeb2PlanSelection = { planId: summary.planId, planDigest: summary.planDigest };
  return await installation.apply(selection);
 }
 return { root, authority, ingress, installation, prepareAndApply, releaseRoot: join(root, "release"), communityId: authority.draft.enrollment.communityId };
}

test("installer readiness detects authority change between probes without full VM boot", { timeout: 120000 }, async (t) => {
 const f = await readinessFixture(t), observations = observationEvents(t);
 f.ingress.setCommunityResponse(503);
 const snapshot = await f.authority.chain.rpc("evm_snapshot");
 const work = (async () => {
  const summary = await f.installation.prepare(f.authority.draft);
  return await f.installation.apply({ planId: summary.planId, planDigest: summary.planDigest });
 })();
 const revise = (async () => {
  while (f.ingress.requests() < 1) await delay(10);
  await f.authority.chain.nextRevision();
 })();
 await assert.rejects(work, /install_current_authority_changed/);
 await revise;
 assert.equal(await f.authority.chain.rpc("evm_revert", [snapshot]), true);
 const scans = observations.verificationsAfterEnter("ingress-wait");
 assert.equal(scans.length, 0, "readiness polling repeated full release verification");
 await mkdir(".local/linux-web2-installation", { recursive: true });
 await writeFile(join(".local/linux-web2-installation", "readiness-authority-change.json"), JSON.stringify({ refused: "install_current_authority_changed", revisionChangedAfterFirstProbe: true, fullReleaseVerificationsDuringIngressWait: scans.length, scope: "focused installer callback, inert Docker fixture" }) + "\n", { mode: 0o600 });
});


test("installer readiness refuses changed release bytes at the final verification boundary", { timeout: 120000 }, async (t) => {
 const f = await readinessFixture(t), observations = observationEvents(t);
 f.ingress.setCommunityResponse(503);
 const work = (async () => {
  const summary = await f.installation.prepare(f.authority.draft);
  return await f.installation.apply({ planId: summary.planId, planDigest: summary.planDigest });
 })();
 void (async () => {
  while (f.ingress.requests() < 1) await delay(10);
  const file = join(f.releaseRoot, "application.mjs");
  await chmod(f.releaseRoot, 0o700);
  await chmod(file, 0o600);
  await writeFile(file, "CHANGED BYTE\n");
  await chmod(file, 0o444);
  await chmod(f.releaseRoot, 0o555);
  f.ingress.setCommunityResponse(200, f.communityId);
 })();
 await assert.rejects(work, /complete_release_bytes_changed/);
 const scans = observations.verificationsAfterEnter("ingress-wait");
 assert.equal(scans.length, 1, "the valid response did not lead to exactly one final full verification");
 const terminal = observations.events.find(row => row.event === "installed-artifact-verification" && row.phase === "end" && typeof row.at === "number" && row.at >= (scans[0]!.at as number));
 assert.equal(terminal?.outcome, "refused");
 await mkdir(".local/linux-web2-installation", { recursive: true });
 await writeFile(join(".local/linux-web2-installation", "readiness-release-bytes.json"), JSON.stringify({ refused: "complete_release_bytes_changed", boundary: "full verification after a valid community response and before ingress start", fullReleaseVerificationsDuringIngressWait: scans.length, finalVerificationOutcome: terminal?.outcome, scope: "focused installer callback, inert Docker fixture" }) + "\n", { mode: 0o600 });
});
