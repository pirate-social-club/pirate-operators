#!/usr/bin/env node
/** Actual installed native process owner. Invoked only by an admitted image;
 * all paths are explicit; no source build, install, default profile or key lookup. */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {open,lstat,readFile,readdir} from "node:fs/promises";
import {constants} from "node:fs";
import {join,dirname} from "node:path";
import {request} from "node:http";
import {performance} from "node:perf_hooks";
import {createHash,randomBytes} from "node:crypto";
import {verifyInstalledRelease,type FullRelease} from "./installed-release.ts";
import {readPrivateJSON,type SignedRecord,type TrustAnchor} from "./installed-records.ts";
import {processIdentity,sameProcess,privateDirectory,syncDirectory} from "./backend-state.ts";
import {renderFullNativeConfig} from "./full-native-config.ts";
import {createBootDirectory} from "./local-installation.ts";
import {assertStartAllowed} from "./maintenance-guard.ts";
import {validateOriginal, type ProfileAdmission} from "./full-profile-authority.ts";
import {canonicalDigest} from "./installed-records.ts";
import type {NativeOriginal} from "../../packages/community/native-business-binding.ts";
const args=process.argv.slice(2);assert(args.length===1,"full_launch_exact_installed_configuration_required");
const config=await readPrivateJSON<{
  release:SignedRecord<FullRelease>;trust:TrustAnchor;workerd:string;workerdSha256:string;
  maintenanceDirectory:string;privateRuntimeDirectory:string;expectedInstallationId:string;
  mode:"initialize"|"serve"|"cold-reconcile";configurationDirectory:string;coldReceiptPath?:string;
}>(args[0]!);
const release=await verifyInstalledRelease(config.release,config.trust),graph=release.graph;
assert(["initialize","serve","cold-reconcile"].includes(config.mode));
assert(graph.installationId===config.expectedInstallationId);
// This input is a private /run parent, never a persistent journal/data root.
// Old boot evidence stays retained; a restart uses a fresh exclusive leaf.
const runtimeDirectory=await createBootDirectory(config.privateRuntimeDirectory),runtimeSocket=join(runtimeDirectory,"control.sock");
assert.deepEqual(await readdir(runtimeDirectory),[]);
if(config.mode!=="cold-reconcile")await assertStartAllowed(config.maintenanceDirectory);
for(const root of Object.values(graph.stateRoots)){
  await privateDirectory(root);
  try{await lstat(join(root,"restore-fence.json"));if(config.mode!=="cold-reconcile")throw new Error("restore_original_authority_fence_held");}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
}
assert(config.workerd===join(release.root,"workerd") && config.workerdSha256===release.files.workerd,"installed_native_binary_required");
const native=await readFile(config.workerd);assert.equal(createHash("sha256").update(native).digest("hex"),config.workerdSha256);
const target=join(runtimeDirectory,"full-native.capnp");
const bootId=randomBytes(32).toString("hex");
let nativeOriginalFile:string|undefined;
if(config.mode!=="cold-reconcile"){
  assert(config.configurationDirectory===graph.stateRoots.configuration,"original_native_configuration_root");
  const signed=await readPrivateJSON<SignedRecord<ProfileAdmission>>(join(config.configurationDirectory,"profile-authority.json"));
  const original=validateOriginal(signed,config.trust,graph.installationId);
  assert(original.profile.runtime.sourceDigest===release.sourceDigest && original.profile.runtime.artifactDigest===release.artifactDigest,
    "original_native_profile_release_changed");
  assert(original.profile.settings.origin===JSON.parse(graph.directoryRuntimeBinding).origin,"original_native_origin_changed");
  const body:NativeOriginal={schema:"pirate.native-application-original/1",record:signed,release:config.release,trust:config.trust,durableScope:graph.durableScope};
  nativeOriginalFile=join(runtimeDirectory,"native-application-original.json");
  const originalFile=await open(nativeOriginalFile,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await originalFile.writeFile(JSON.stringify(body));await originalFile.sync();}finally{await originalFile.close();}
  const readback=await readPrivateJSON(nativeOriginalFile);
  assert.equal(canonicalDigest(readback),canonicalDigest(body),"original_native_binding_readback_changed");
}
const file=await open(target,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
try{await file.writeFile(renderFullNativeConfig(graph,config.mode,bootId,nativeOriginalFile,runtimeSocket));await file.sync();}finally{await file.close();}
await syncDirectory(runtimeDirectory);
if(config.mode!=="cold-reconcile")await assertStartAllowed(config.maintenanceDirectory);
await privateDirectory(dirname(runtimeSocket));
const before=await processIdentity(process.pid);assert(before);
if(config.mode==="serve") {
  const initialized=await readPrivateJSON<{installationId:string;artifactDigest:string}>(join(config.configurationDirectory,"initialized-native.json"));
  assert(initialized.installationId===graph.installationId && initialized.artifactDigest===release.artifactDigest,"original_initialization_readback_required");
}
const child=spawn(config.workerd,["serve","--experimental",target],{cwd:release.root,env:{PATH:"/usr/bin:/bin",TZ:"UTC"},detached:true,stdio:["ignore","inherit","inherit"]});
const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
  child.once("error",reject);child.once("exit",(code,signal)=>resolve({code,signal}));
});
const spawned=new Promise<void>((resolve,reject)=>{child.once("spawn",resolve);child.once("error",reject);});
await spawned;const owned=await processIdentity(child.pid!);assert(owned && owned.hostGroup===child.pid && owned.hostSession===child.pid);
const witness=await open(join(runtimeDirectory,"native-process.json"),"wx",0o600);
try{await witness.writeFile(JSON.stringify({observer:before,owned,installationId:graph.installationId,scope:"inner-container-frame; host mapping requires independent observer"})+"\n");await witness.sync();}
finally{await witness.close();}
let stopping=false,killTimer:ReturnType<typeof setTimeout>|undefined;
async function stop(){
  if(stopping)return;stopping=true;
  assert(sameProcess(owned!,await processIdentity(owned!.hostPid)),"native_inner_process_uncertain");
  process.kill(owned!.hostPid,"SIGTERM");
  killTimer=setTimeout(()=>{void(async()=>{
    assert(sameProcess(owned!,await processIdentity(owned!.hostPid)));process.kill(owned!.hostPid,"SIGKILL");
  })().catch(()=>{process.exitCode=1;});},10000);
}
for(const signal of ["SIGTERM","SIGINT"] as const)process.once(signal,()=>{void stop().catch(()=>{process.exitCode=1;});});
{
  let failed:unknown;const end=performance.now()+20000;
  try {
    const reply=await new Promise<any>((resolve,reject)=>{
      const attempt=()=>{
        if(performance.now()>=end){reject(new Error("full_initialize_true_timeout"));return;}
        const req=request({socketPath:runtimeSocket,path:config.mode==="cold-reconcile"?"/reconcile":"/initialize",method:"POST",timeout:Math.min(3000,end-performance.now())},res=>{
          let body="";res.on("data",b=>{body+=b;if(body.length>65536)req.destroy(new Error("initialize_response_limit"));});
          res.on("error",reject);res.on("end",()=>{try{assert(performance.now()<end && res.statusCode===200);resolve(JSON.parse(body));}catch(e){reject(e);}});
        });
        req.on("timeout",()=>req.destroy(new Error("initialize_request_timeout")));
        req.on("error",e=>{if((e as NodeJS.ErrnoException).code==="ENOENT" && performance.now()<end)setTimeout(attempt,50);else reject(e);});req.end();
      };attempt();
    });
    assert((config.mode==="cold-reconcile"?reply.outcome==="offline-reconciled":reply.initialized===true) && performance.now()<end);
    if(config.mode==="serve")assert(reply.bootId===bootId,"actual_current_boot_initialization_required");
    await privateDirectory(config.configurationDirectory);
    const receiptPath=config.mode==="cold-reconcile"?config.coldReceiptPath:config.mode==="serve"?
      join(runtimeDirectory,"actual-startup.json"):join(config.configurationDirectory,"initialized-native.json");
    assert(receiptPath,"cold_reconciliation_requires_explicit_receipt_path");
    const receipt=await open(receiptPath,"wx",0o600);
    try{await receipt.writeFile(JSON.stringify({installationId:graph.installationId,artifactDigest:release.artifactDigest,reply})+"\n");await receipt.sync();}
    finally{await receipt.close();}await syncDirectory(dirname(receiptPath));
    assert(performance.now()<end,"native_phase_completion_first_observed_after_deadline");
  } catch(e){failed=e;}
  finally{if(config.mode!=="serve" || failed)await stop();}
  if(config.mode!=="serve" || failed){
    const terminal=await exited;if(killTimer)clearTimeout(killTimer);
    if(failed)throw failed;assert(terminal.code===0 && terminal.signal===null);
  }
}
const result=await exited;if(killTimer)clearTimeout(killTimer);
assert(stopping && result.code===0 && result.signal===null,"native_process_failed_or_unrequested_exit");
for(const unused of [0,1])assert(await processIdentity(owned.hostPid)===null,"native_inner_lifetime_still_present");
// Native output/inner witness are retained. No outer host absence or release is inferred.

