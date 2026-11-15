import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { request } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import {
  linuxWeb2DraftFrom, type LinuxWeb2Draft, type LinuxWeb2Installation,
  type LinuxWeb2Observation, type LinuxWeb2PlanSelection, type LinuxWeb2PlanSummary,
} from "../../packages/community-setup/linux-web2-profile.ts";
import { verifyInstalledRelease, installedExecutionPaths, type FullRelease } from "./installed-release.ts";
import { canonicalDigest, readPrivateJSON, verifyRecord, type SignedRecord, type TrustAnchor } from "./installed-records.ts";
import { privateDirectory, privateFile, processIdentity, sameProcess, syncDirectory, type OperationLease } from "./backend-state.ts";
import { createLocalController, type InstalledTarget } from "./local-target-controller.ts";
import { authenticateWeb2Enrollment, ownWeb2ChainAuthority, readWeb2HostAdmission,
  type Web2ChainAuthority, type Web2InstallPlan } from "./web2-profile-authority.ts";
import { publicIngressFrom, retainPublicIngress, startPublicIngress, type PublicIngress } from "./public-ingress.ts";
import { startPairedOperator, type PairedOperatorRuntime, type PairedOperatorInputs } from "./bootstrap-local-target.ts";
import { linuxCreateRuntimeProfileFrom } from "./create-runtime-profile.ts";
import { assertCreateRuntimeSelection } from "./local-installation.ts";

/** Installed host-only inputs. No request can replace these with browser fields. */
export interface Web2InstallationHostInputs {
  release: SignedRecord<FullRelease>;
  trust: TrustAnchor;
  lease: OperationLease;
  target: InstalledTarget;
  ingress: PublicIngress;
  chain: Web2ChainAuthority;
  currentAdmissionFile: string;
  minimumGeneration: number;
  planDirectory: string;
  hostFingerprint: string;
  nativeRuntimeDirectory: string;
  now: () => number;
  signProfile(body: Web2InstallPlan, generation: number): Promise<SignedRecord<Web2InstallPlan>>;
}
export interface Web2LocalInstallationConfiguration {
  schema:"pirate.web2-local-installation/1";
  release:SignedRecord<FullRelease>;
  trust:TrustAnchor;
  runtimeProfileFile:string;
}
/** W1 supplies the Wizard implementation; this module owns the paired transport. */
export interface Web2BootstrapInputs {
  installation:Web2InstallationHostInputs;
  createWizard(input:{directory:string;dist:string;installation:LinuxWeb2Installation;
    authorization:Parameters<PairedOperatorInputs["createRuntime"]>[0]}):Promise<PairedOperatorRuntime>;
}
export async function launchWeb2LocalInstallation(config:Web2LocalInstallationConfiguration, signal?:AbortSignal){
  assert(config.schema==="pirate.web2-local-installation/1");
  assert.deepEqual(Object.keys(config).sort(),["release","runtimeProfileFile","schema","trust"]);
  const release=await verifyInstalledRelease(config.release,config.trust);
  assert(release.schema==="pirate.complete-linux-web2-release/1","explicit_web2_release_required");
  const selected=await readPrivateJSON<Record<string,unknown>>(config.runtimeProfileFile);
  assert(selected.schema==="pirate.linux-web2-runtime/1","explicit_web2_launch_selection_required");
  // Reuse only the unsigned path/port validator. This does not convert a
  // community profile, Directory identity, authority proof or old journal.
  const runtime=linuxCreateRuntimeProfileFrom({...selected,schema:"pirate.linux-create-runtime/1"});
  const execution=installedExecutionPaths(release);assertCreateRuntimeSelection(release,runtime);
  assert(process.version===release.execution.nodeVersion && await realpath(process.execPath)===execution.node,"installed_web2_node_required");
  assert.deepEqual(process.execArgv,["--import",execution.loader],"installed_web2_loader_required");
  assert(!process.env.NODE_PATH && !process.env.NODE_OPTIONS,"ambient_node_loader_refused");
  for(const path of [runtime.wizardDirectory,runtime.pairingNonceDirectory])await privateDirectory(path);
  const loaded:{createWeb2BootstrapInputs():Promise<Web2BootstrapInputs>}=await import(pathToFileURL(execution.backend).href);
  assert(typeof loaded.createWeb2BootstrapInputs==="function","genuine_web2_installed_backend_required");
  const inputs=await loaded.createWeb2BootstrapInputs();
  assert(canonicalDigest(inputs.installation.release)===canonicalDigest(config.release) &&
    canonicalDigest(inputs.installation.trust)===canonicalDigest(config.trust) &&
    inputs.installation.lease.installationId===runtime.installationId,"installed_web2_backend_changed");
  assert.deepEqual(await readPrivateJSON(config.runtimeProfileFile),selected,"web2_launch_selection_changed");
  await verifyInstalledRelease(config.release,config.trust);
  const installation=await createWeb2Installation(inputs.installation,signal),secret=randomBytes(32);
  try{
    await installation.resumeOriginal();
    const paired=await startPairedOperator({installationId:runtime.installationId,frontPort:runtime.frontPort,innerPort:runtime.innerPort,
      setup:"linux-web2",
      pairingSecret:secret,pairingNonceDirectory:runtime.pairingNonceDirectory,assertHeld:()=>inputs.installation.lease.assertHeld(),
      createRuntime:authorization=>inputs.createWizard({directory:runtime.wizardDirectory,dist:execution.wizardDist,installation,authorization}),
    });
    const pairingCode=secret.toString("base64url");secret.fill(0);
    let setupClose:Promise<void>|undefined,serviceStop:Promise<void>|undefined;
    const closeSetup=()=>setupClose??=paired.close(()=>installation.close());
    return {origin:paired.origin+"/?setup=linux-web2",pairingCode,runtime:{close:closeSetup},
      shutdownService:()=>serviceStop??=(async()=>{
        // Stop explicit service ingress first; closing only setup never does so.
        await installation.shutdownService(); await closeSetup();
      })()};
  }catch(error){secret.fill(0);await installation.shutdownService();throw error;}
}

/** Journal continuation must prove exact bytes and resync both durable levels.
 * EEXIST alone is never durable success. No overwrite/delete is used. */
async function retain(directory: string, name: string, value: unknown) {
  await privateDirectory(directory);
  assert(/^[a-z0-9-]{1,120}(?![\s\S])/.test(name));
  const path = join(directory, name + ".json"), bytes = Buffer.from(JSON.stringify(value) + "\n");
  let output;
  try { output = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const file = await privateFile(path, 1024 ** 2);
    try { assert((await file.readFile()).equals(bytes), "original_install_record_changed"); await file.sync(); }
    finally { await file.close(); }
    await syncDirectory(directory); return;
  }
  try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
  await syncDirectory(directory);
}
async function optionalRecord<T>(path: string): Promise<T | null> {
  try { return await readPrivateJSON<T>(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** A real application response over verified upstream TLS, not a readiness flag. */
async function inspectApplication(ingress: PublicIngress, expected: LinuxWeb2Draft, throughIngress = false) {
  const bytes = throughIngress ? ingress.tls.kind === "local-fixture-ca" ?
    await readFile(join(ingress.dataDirectory,"pki","authorities","local","root.crt")) : undefined :
    await readFile(ingress.upstreamCaFile);
  const url = new URL(ingress.upstream);
  return await new Promise<void>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: throughIngress ? ingress.httpsPort : Number(url.port),
      servername: throughIngress ? new URL(ingress.origin).hostname : ingress.upstreamServerName,
      ca: bytes, method: "GET", path: "/api/public/community", headers: { Host: new URL(expected.origin).host }, timeout: 5000 }, res => {
      let body = "";
      res.on("data", chunk => { body += String(chunk); if (body.length > 65536) req.destroy(new Error("application_readback_limit")); });
      res.once("error", reject);
      res.once("end", () => {
        try {
          assert(res.statusCode === 200, "application_readback_unavailable");
          const actual: unknown = JSON.parse(body);
          assert(actual && typeof actual === "object" && "communityId" in actual && actual.communityId === expected.enrollment.communityId,
            "actual_application_community_changed");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    req.once("error", reject); req.once("timeout", () => req.destroy(new Error("application_readback_timeout"))); req.end();
  });
}

export interface Web2InstalledService extends LinuxWeb2Installation {
  resumeOriginal():Promise<LinuxWeb2Observation|null>;
  shutdownService():Promise<void>;
}
export async function createWeb2Installation(input: Web2InstallationHostInputs, signal?:AbortSignal): Promise<Web2InstalledService> {
  const { lease, signProfile, now } = input;
  const selected = structuredClone({ release: input.release, trust: input.trust, target: input.target,
    currentAdmissionFile: input.currentAdmissionFile, minimumGeneration: input.minimumGeneration,
    planDirectory: input.planDirectory, hostFingerprint: input.hostFingerprint, nativeRuntimeDirectory: input.nativeRuntimeDirectory });
  const chain = ownWeb2ChainAuthority(input.chain), ingress = publicIngressFrom(input.ingress);
  const release = await verifyInstalledRelease(selected.release, selected.trust);
  assert(release.schema === "pirate.complete-linux-web2-release/1", "explicit_web2_release_required");
  assert(lease.installationId === release.graph.installationId && selected.target.installationId === lease.installationId);
  assert(Number.isSafeInteger(selected.minimumGeneration) && selected.minimumGeneration > 0 && typeof now === "function");
  assert(selected.planDirectory === release.graph.stateRoots.configuration, "owned_install_configuration_root_required");
  assert(selected.target.containers.every(c => c.ports.every(p => p.ip === "127.0.0.1")), "private_application_ports_required");
  assert(selected.target.containers.some(c => c.imageId === release.imageId && c.ports.some(p => p.host === Number(new URL(ingress.upstream).port))),
    "actual_private_application_upstream_required");
  await privateDirectory(selected.nativeRuntimeDirectory);
  assert(selected.target.allowedWritableRoots.some(root=>selected.nativeRuntimeDirectory===root || selected.nativeRuntimeDirectory.startsWith(root+"/")),
    "owned_native_runtime_directory_required");
  const nativeLaunchFile=join(selected.planDirectory,"web2-launch.json"),execution=installedExecutionPaths(release);
  assert(selected.target.containers.some(c=>c.imageId===release.imageId &&
    canonicalDigest(c.argv)===canonicalDigest([execution.node,join(release.root,"full-launch.mjs"),nativeLaunchFile])),
    "exact_web2_native_launch_required");
  const targetDigest = canonicalDigest({ target:selected.target, ingress, nativeRuntimeDirectory:selected.nativeRuntimeDirectory }),
    originalPath = join(selected.planDirectory, "web2-original.json");
  const controller = await createLocalController(selected.target, lease);
  let closed = false, busy = false, edge: Awaited<ReturnType<typeof startPublicIngress>> | undefined;
  let idle=Promise.resolve(),finish:()=>void=()=>{};
  const open = async () => { assert(!closed && !signal?.aborted, "web2_installer_closed_or_cancelled"); await lease.assertHeld(); };
  const exclusive = async <T>(action: () => Promise<T>) => {
    assert(!busy, "web2_installation_operation_in_progress"); busy = true;
    idle=new Promise<void>(resolve=>{finish=resolve;});
    try { return await action(); } finally { busy = false; finish(); }
  };
  async function authorize(draft: LinuxWeb2Draft, planId?: string, retainedGeneration = selected.minimumGeneration) {
    await open();
    assert(draft.origin === ingress.origin && canonicalDigest(draft.deployment) === canonicalDigest(JSON.parse(release.graph.directoryRuntimeBinding)),
      "installed_web2_deployment_changed");
    await verifyInstalledRelease(selected.release, selected.trust);
    const host = () => readWeb2HostAdmission({ path: selected.currentAdmissionFile, trust: selected.trust, now,
      installationId: lease.installationId, draft, releaseArtifactDigest: release.artifactDigest,
      targetDigest, hostFingerprint: selected.hostFingerprint,
      minimumGeneration: Math.max(selected.minimumGeneration, retainedGeneration), ...(planId ? { planId } : {}) });
    await host();
    const evidence = await authenticateWeb2Enrollment(chain, draft);
    const admission = await host();
    const actual = await controller.inspectHost(AbortSignal.timeout(45000));
    assert(actual.supported && actual.fingerprint === selected.hostFingerprint, "web2_installed_host_changed");
    await host(); await open();
    return { evidence, admission };
  }
  async function load(selection: LinuxWeb2PlanSelection) {
    await open();
    assert(Object.keys(selection).sort().join(",") === "planDigest,planId");
    const record = await readPrivateJSON<SignedRecord<Web2InstallPlan>>(originalPath), body = verifyRecord(record, selected.trust);
    assert(body.schema === "pirate.linux-web2-install-plan/1" && body.planId === selection.planId &&
      canonicalDigest(body) === selection.planDigest && body.installationId === lease.installationId &&
      body.durableScope === release.graph.durableScope && body.releaseArtifactDigest === release.artifactDigest &&
      body.releaseSourceDigest === release.sourceDigest && body.targetDigest === targetDigest &&
      body.hostFingerprint === selected.hostFingerprint, "original_web2_installation_changed");
    assert(Number.isSafeInteger(body.generation) && body.generation >= selected.minimumGeneration,
      "original_web2_generation_invalid");
    assert(canonicalDigest(linuxWeb2DraftFrom(body.draft)) === canonicalDigest(body.draft));
    return { record, body };
  }
  const selectionFor = (p: Web2InstallPlan) => ({ planId: p.planId, planDigest: canonicalDigest(p) });
  function summary(p: Web2InstallPlan): LinuxWeb2PlanSummary {
    return { ...selectionFor(p), installationId: p.installationId, summary: { name: p.draft.name, origin: p.draft.origin,
      communityId: p.draft.enrollment.communityId, controller: p.draft.configuration.controller, publisher: p.draft.configuration.publisher,
      registrationTransaction: p.enrollment.transactionHash, verifiedListing: false, namesEnabled: false, learningEnabled: false, danceEnabled: false } };
  }
  async function observation(selection: LinuxWeb2PlanSelection): Promise<LinuxWeb2Observation> {
    const { body } = await load(structuredClone(selection));
    const base = { ...selectionFor(body), installationId: body.installationId };
    try {
      await authorize(body.draft, body.planId, body.generation);
      const state = await controller.inspect(AbortSignal.timeout(45000));
      const intent = await optionalRecord(join(selected.planDirectory, "web2-start-intent.json"));
      if (!intent) {
        assert(state.resources.every(r => r.actual === null), "unrecorded_installation_effect");
        return { ...base, state: "prepared" };
      }
      if (!state.resources.every(r => r.actual?.State.Running)) return { ...base, state: "unavailable", reason: "original_resources_not_running" };
      assert(edge && sameProcess(edge.identity, await processIdentity(edge.identity.hostPid)), "original_ingress_not_running");
      await inspectApplication(ingress, body.draft, true);
      await authorize(body.draft, body.planId, body.generation);
      assert(sameProcess(edge.identity, await processIdentity(edge.identity.hostPid)), "original_ingress_not_running");
      return { ...base, state: "running" };
    } catch {
      return { ...base, state: "unavailable", reason: "installation_authority_or_readback_unavailable" };
    }
  }
  const service:Web2InstalledService = {
    prepare: value => exclusive(async () => {
      const draft = linuxWeb2DraftFrom(value), planId = "web2-" + draft.enrollment.enrollmentId.slice(2);
      const current = await authorize(draft, planId);
      const old = await optionalRecord<SignedRecord<Web2InstallPlan>>(originalPath);
      if (old) {
        const prior = verifyRecord(old, selected.trust);
        assert(canonicalDigest(prior.draft) === canonicalDigest(draft), "original_web2_draft_changed");
        await load(selectionFor(prior)); await authorize(draft, prior.planId, prior.generation);
        await retain(selected.planDirectory, "web2-original", old);
        return summary(prior);
      }
      const plan: Web2InstallPlan = { schema: "pirate.linux-web2-install-plan/1", planId, installationId: lease.installationId,
        durableScope: release.graph.durableScope, generation: current.admission.generation, draft,
        releaseArtifactDigest: release.artifactDigest, releaseSourceDigest: release.sourceDigest,
        targetDigest, hostFingerprint: selected.hostFingerprint, enrollment: current.evidence,
        registrationAuthority: { registrar: chain.registrar, registrarRevision: String(chain.registrarRevision),
          maxSafeBlockAgeSeconds: String(chain.maxSafeBlockAgeSeconds) } };
      const signed = await signProfile(structuredClone(plan), plan.generation);
      assert(canonicalDigest(verifyRecord(signed, selected.trust)) === canonicalDigest(plan), "web2_profile_signer_changed_body");
      await authorize(draft, planId, plan.generation); await retain(selected.planDirectory, "web2-original", signed);
      await lease.record("web2-original-profile-retained", summary(plan));
      return summary(plan);
    }),
    apply: selection => exclusive(async () => {
      const owned = structuredClone(selection), { body } = await load(owned);
      const current = async () => { await authorize(body.draft, body.planId, body.generation); };
      await current();
      const intent = { ...selectionFor(body), targetDigest, installationId: body.installationId };
      const prior = await optionalRecord(join(selected.planDirectory, "web2-start-intent.json"));
      await retain(selected.planDirectory,"web2-launch",{
        schema:"pirate.linux-web2-launch/1",release:selected.release,trust:selected.trust,
        currentAdmissionFile:selected.currentAdmissionFile,minimumGeneration:body.generation,
        privateRuntimeDirectory:selected.nativeRuntimeDirectory,maintenanceDirectory:selected.target.maintenanceDirectory,
      });
      if (prior) {
        assert(canonicalDigest(prior) === canonicalDigest(intent), "original_start_intent_changed");
        // A lost create reply does not authorize creating/adopting missing resources.
        const state = await controller.inspect(AbortSignal.timeout(45000));
        assert(state.resources.every(r => r.actual !== null), "original_start_effect_uncertain");
      } else {
        await retain(selected.planDirectory, "web2-start-intent", intent); await current();
        await controller.create(AbortSignal.timeout(180000), current);
      }
      await retainPublicIngress(ingress, lease); await current();
      await controller.start(AbortSignal.timeout(120000), current);
      await inspectApplication(ingress, body.draft); await current();
      if (edge) {
        const actual = await processIdentity(edge.identity.hostPid);
        if (actual === null) edge = undefined;
        else assert(sameProcess(edge.identity, actual), "original_ingress_identity_unavailable");
      }
      if (!edge) edge = await startPublicIngress(ingress, lease, current);
      return observation(owned);
    }),
    status: selection => observation(structuredClone(selection)),
    async resumeOriginal() {
      await open();
      const retained=await optionalRecord<SignedRecord<Web2InstallPlan>>(originalPath);
      if(!retained)return null;
      const original=verifyRecord(retained,selected.trust),selection=selectionFor(original);
      await load(selection);
      // Retaining a prepared plan alone is not approval to start installation.
      if(!await optionalRecord(join(selected.planDirectory,"web2-start-intent.json")))return observation(selection);
      return service.apply(selection);
    },
    async close() {
      assert(!busy, "installation_operation_not_quiescent"); closed = true;
      // Setup lifetime ends; the explicit installed host service still owns
      // Caddy and keeps the community running. No resource or lease is released.
    },
    async shutdownService() {
      closed=true;
      await Promise.race([idle,delay(200000,undefined,{ref:false}).then(()=>{throw Error("web2_service_operation_not_quiescent");})]);
      await edge?.stop(); edge = undefined;
      await controller.dispose();
    },
  };
  return service;
}
