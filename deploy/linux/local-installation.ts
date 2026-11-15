import assert from "node:assert/strict";
import {mkdtemp,chmod,lstat,realpath} from "node:fs/promises";
import {join,relative,isAbsolute} from "node:path";
import {pathToFileURL} from "node:url";
import {randomBytes} from "node:crypto";
import {privateDirectory,syncDirectory} from "./backend-state.ts";
import {canonicalDigest,readPrivateJSON,type SignedRecord,type TrustAnchor} from "./installed-records.ts";
import {verifyInstalledRelease,installedExecutionPaths,type FullRelease} from "./installed-release.ts";
import {linuxCreateRuntimeProfileFrom,type LinuxCreateRuntimeProfile} from "./create-runtime-profile.ts";
import type {LocalTargetCreateBootstrapInputs} from "./bootstrap-local-target.ts";
import type {InstalledLinuxCreateInputs} from "../../apps/community-wizard/server/linux-launch.ts";

export interface LocalInstallationConfiguration {
  schema:"pirate.local-installation/1";
  release:SignedRecord<FullRelease>;trust:TrustAnchor;runtimeProfileFile:string;
}
/** Scratch is private and fresh on EVERY boot. Persistent roots, installation
 * IDs, leases, pending operations and journals are never created/replaced here. */
export async function createBootDirectory(parent:string) {
  assert(parent.startsWith("/run/") && !parent.split("/").includes(".."),"private_run_parent_required");
  await privateDirectory(parent);
  const path=await mkdtemp(join(parent,"boot-"));await chmod(path,0o700);
  await privateDirectory(path);await syncDirectory(parent);return path;
}
export function assertCreateRuntimeSelection(release:FullRelease,runtime:LinuxCreateRuntimeProfile) {
  const execution=installedExecutionPaths(release);
  assert(runtime.installationId===release.graph.installationId,"create_runtime_installation_changed");
  assert(runtime.backendConfigurationFile===execution.backend,"create_runtime_backend_changed");
  for(const path of [runtime.wizardDirectory,runtime.pairingNonceDirectory]){
    const rel=relative(release.root,path);
    assert(rel===".." || rel.startsWith("../") || isAbsolute(rel),"mutable_operator_state_outside_release_required");
  }
  assert(runtime.wizardDirectory!==runtime.pairingNonceDirectory,"separate_private_operator_paths_required");
  return execution;
}
/** Execute the exact installed backend.ts with the existing bootstrap factory
 * contract. Unsigned path selection never constructs a signed profile, issuer,
 * namespace proof, readiness row, credential, installation ID or retry child. */
export async function launchLocalInstallation(config:LocalInstallationConfiguration) {
  assert(config.schema==="pirate.local-installation/1","local_installation_configuration_required");
  assert.deepEqual(Object.keys(config).sort(),["release","runtimeProfileFile","schema","trust"]);
  const release=await verifyInstalledRelease(config.release,config.trust);
  const selected=linuxCreateRuntimeProfileFrom(await readPrivateJSON(config.runtimeProfileFile));
  const execution=assertCreateRuntimeSelection(release,selected);
  assert(process.version===release.execution.nodeVersion,"installed_node_version_changed");
  assert.equal(await realpath(process.execPath),execution.node,"installed_node_required");
  assert.deepEqual(process.execArgv,["--import",execution.loader],"exact_installed_loader_required");
  assert(!process.env.NODE_PATH && !process.env.NODE_OPTIONS,"ambient_node_loader_refused");
  for(const path of [selected.wizardDirectory,selected.pairingNonceDirectory])await privateDirectory(path);
  const backend=await lstat(execution.backend);
  assert(backend.uid===process.getuid!() && backend.nlink===1 && !(backend.mode&0o077),"private_installed_backend_required");
  const loaded:{createLinuxBootstrapInputs():Promise<InstalledLinuxCreateInputs>}=await import(pathToFileURL(execution.backend).href);
  assert(typeof loaded.createLinuxBootstrapInputs==="function","genuine_installed_bootstrap_inputs_required");
  const inputs=await loaded.createLinuxBootstrapInputs();
  assert(inputs.backend.runtimeProfile==="create-v3","explicit_create_backend_required");
  assert(!Object.hasOwn(inputs,"pairingSecret") && !Object.hasOwn(inputs,"wizardDist"),"closed_installed_bootstrap_inputs_required");
  assert(inputs.backend.installationId===selected.installationId && inputs.backend.sourceRoot===release.sourceRoot,
    "installed_backend_source_or_identity_changed");
  assert.equal(canonicalDigest(inputs.backend.releaseRecord),canonicalDigest(config.release),"installed_backend_release_changed");
  assert.deepEqual(inputs.backend.trust,config.trust,"installed_backend_issuer_changed");
  assert(inputs.wizardDirectory===selected.wizardDirectory && inputs.pairingNonceDirectory===selected.pairingNonceDirectory &&
    inputs.frontPort===selected.frontPort && inputs.innerPort===selected.innerPort,"unsigned_runtime_selection_changed");
  // Awaited issuer/key input construction must not change selected bytes. The
  // actual constructor still authenticates all original/current authorities.
  assert.deepEqual(linuxCreateRuntimeProfileFrom(await readPrivateJSON(config.runtimeProfileFile)),selected);
  await verifyInstalledRelease(config.release,config.trust);
  const {bootstrapLocalTarget}=await import("./bootstrap-local-target.ts");
  const pairingSecret=randomBytes(32);
  try {
    const input:LocalTargetCreateBootstrapInputs={...inputs,wizardDist:execution.wizardDist,pairingSecret};
    const runtime=await bootstrapLocalTarget(input);
    const pairingCode=pairingSecret.toString("base64url");pairingSecret.fill(0);
    return {runtime,origin:runtime.origin+"/?setup=linux",pairingCode};
  }catch(error){pairingSecret.fill(0);throw error;}
}
