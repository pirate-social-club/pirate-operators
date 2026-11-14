import assert from "node:assert/strict";
import {mkdir,lstat,realpath,readFile} from "node:fs/promises";
import {join,relative} from "node:path";
import {fileURLToPath} from "node:url";
import {createJSON,privateDirectory,privateFile,syncDirectory,hash,type OperationLease} from "./backend-state.ts";
import {verifyInstalledRelease,type FullRelease} from "./installed-release.ts";
import {canonicalDigest,evidenceId,verifyRecord,assertIndependentTrustAnchors,type SignedRecord,type TrustAnchor} from "./installed-records.ts";
import {readWholeClearance} from "./independent-clearance.ts";
import type {LinuxOperationResult,LinuxOperatorAdapter} from "./operator-adapter-contract.ts";
import {boundedIntent,boundedResult,requireNativeEnvelope,CAPACITY_POLICY,INTENT_MAX_BYTES,RESULT_MAX_BYTES} from "./shared-v2-output-bounds.ts";
export type BoundIntent={kind:"deploy";intent:Parameters<LinuxOperatorAdapter["deploy"]>[0]}|
 {kind:"restore";intent:Parameters<LinuxOperatorAdapter["restore"]>[0]};
// Opaque authenticated profile preimage: the actual owning factory/profile
// authority validates the complete versioned codec. Capacity capture retains
// ALL original fields/nonce bytes and never substitutes a Directory codec.
interface Profile {
 schema:"pirate.community-linux-profile/2";
 identity:{resources:Record<string,string>};runtime:{sourceDigest:string;artifactDigest:string};
 settings:{origin:string};infrastructure:{mapping:{linuxInstallationId:string}};namespace:unknown;
}
export interface SharedOperation {
 id:string;kind:string;draftRevision:number;startedAt:number;
 plan:{digest:string;profileDigest:string;profile:Profile;targetFingerprint:string;
 backend:{target:unknown;release:{sourceHead:string;sourceTree:string;selectedProfileDigest:string}}};
}
export interface RecoveryPort {
 readonly policy:typeof CAPACITY_POLICY;readonly sourceDigest:string;
 readonly intentMaxBytes:typeof INTENT_MAX_BYTES;readonly resultMaxBytes:typeof RESULT_MAX_BYTES;
 terminal(input:{operation:unknown;retainedIntent:BoundIntent|null}):Promise<
 {state:"pending";operationId:string}|{state:"result";result:LinuxOperationResult}>;
}
type Envelope=Parameters<typeof requireNativeEnvelope>[0];
type Clearance=Parameters<typeof readWholeClearance>[0];
interface Admission {policy:typeof CAPACITY_POLICY;operationId:string;installationId:string;generation:number;operationHash:string;
 profileHash:string;boundHash:string;sourceDigest:string;artifactDigest:string;mappingHash:string;namespaceHash:string;envelopeHash:string}
const instances=new WeakSet<object>();
export function requireGenuineProducer(value:SharedResultProducer,operator:LinuxOperatorAdapter,sourceDigest:string){
 assert(instances.has(value),"selected_native_producer_required");value.requireAttached(operator,sourceDigest);return value;
}
const sourcePaths=["deploy/linux/shared-v2-output-bounds.ts","deploy/linux/shared-v2-result-producer.ts",
 "deploy/linux/local-target-services.ts","deploy/linux/wizard-backend.ts","deploy/linux/full-profile-authority.ts",
 "deploy/linux/profile-producer.ts","deploy/linux/full-backup-service.ts","deploy/linux/shared-runtime-readback.ts",
 "services/community-deployment-profile.ts","services/community-application.ts","deploy/linux/cohort-archive.ts","deploy/linux/managed-credentials.ts",
 "deploy/linux/backend-command.ts","deploy/linux/local-target-controller.ts","deploy/linux/runtime-secret-files.ts",
 "deploy/linux/restored-fence-release.ts","deploy/linux/maintenance-release.ts",
 "deploy/linux/current-mutation-authority.ts","deploy/linux/final-fence-unlink.ts",
 "deploy/linux/application-readback-authority.ts","deploy/linux/actual-login-probe.ts",
 "deploy/linux/actual-service-readback.ts"] as const;
type Inputs={directory:string;operationsDirectory:string;installationId:string;minimumGeneration:number;sourceRoot:string;
 releaseRecord:SignedRecord<FullRelease>;trust:TrustAnchor;custodyTrust:TrustAnchor;bootstrapLease:OperationLease;envelope:Envelope};
async function identity(path:string){
 await privateDirectory(path);const s=await lstat(path);return {dev:s.dev,ino:s.ino};
}
async function unchanged(path:string,pin:{dev:number;ino:number}){
 const now=await identity(path);assert.deepEqual(now,pin,"original_result_directory_replaced");
}
async function read(path:string,max:number){
 const fd=await privateFile(path,max);
 try{const a=await fd.stat({bigint:true}),bytes=await fd.readFile(),b=await fd.stat({bigint:true});
  assert(a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs);
  const current=await lstat(path);assert(current.dev===Number(a.dev) && current.ino===Number(a.ino),"original_result_file_replaced");
  return {bytes,value:JSON.parse(bytes.toString("utf8"))};
 }finally{await fd.close();}
}
async function missing(path:string){try{await lstat(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return true;throw e;}}
function operation(value:unknown):SharedOperation{
 assert(value && typeof value==="object");const op=structuredClone(value) as SharedOperation;
 assert(typeof op.id==="string" && op.id.length>0 && op.id.length<=128 && /^[A-Za-z0-9_-]+$/.test(op.id));
 assert(Number.isSafeInteger(op.draftRevision) && op.draftRevision>=0 && Number.isSafeInteger(op.startedAt));
 assert(["create","import","restore"].includes(op.kind));
 assert.equal(op.plan.profile.schema,"pirate.community-linux-profile/2","legacy_profile_policy_refused");
 assert(op.plan.profile.infrastructure?.mapping && op.plan.profile.namespace,"full_shared_profile_binding_required");
 assert.equal(canonicalDigest(op.plan.profile),op.plan.profileDigest,"original_full_profile_digest_changed");return op;
}
/** Actual owning native finish is the only writer. terminal never has a writer,
 * callback, operator/reconcile handle, CLI or service dispatcher. */
export class SharedResultProducer {
 readonly policy=CAPACITY_POLICY;readonly intentMaxBytes=INTENT_MAX_BYTES;readonly resultMaxBytes=RESULT_MAX_BYTES;
 readonly sourceDigest:string;readonly port:RecoveryPort;
 #c:Inputs;#release:FullRelease;#root:{dev:number;ino:number};#operations:{dev:number;ino:number};
 #operator:LinuxOperatorAdapter|undefined;#serial:Promise<unknown>=Promise.resolve();
 #contexts=new WeakMap<OperationLease,{admission:Admission;op:SharedOperation;bound:BoundIntent;directory:string}>();
 private constructor(c:Inputs,release:FullRelease,root:{dev:number;ino:number},operations:{dev:number;ino:number}){
  this.#c=c;this.#release=release;this.#root=root;this.#operations=operations;this.sourceDigest=release.sourceDigest;
  this.port=Object.freeze({policy:this.policy,sourceDigest:this.sourceDigest,intentMaxBytes:this.intentMaxBytes,
   resultMaxBytes:this.resultMaxBytes,terminal:(request:Parameters<RecoveryPort["terminal"]>[0])=>this.terminal(request)});
  instances.add(this);
 }
 static async create(input:Inputs){
  const c=structuredClone({...input,bootstrapLease:undefined}) as unknown as Inputs;c.bootstrapLease=input.bootstrapLease;
  assert(Number.isSafeInteger(c.minimumGeneration) && c.minimumGeneration>=0,"original_generation_required");
  await c.bootstrapLease.assertHeld();assertIndependentTrustAnchors(c.trust,c.custodyTrust);requireNativeEnvelope(c.envelope);
  const release=await verifyInstalledRelease(c.releaseRecord,c.trust);
  assert(c.installationId===release.graph.installationId && c.installationId===c.bootstrapLease.installationId);
  assert.equal(await realpath(c.sourceRoot),c.sourceRoot);
  assert.equal(await realpath(fileURLToPath(import.meta.url)),join(c.sourceRoot,"deploy/linux/shared-v2-result-producer.ts"),
   "executing_bounded_producer_source_changed");
  for(const path of sourcePaths){assert(/^[a-f0-9]{64}$/.test(release.sourceHashes[path]??""),"bounded_native_source_not_in_release");
   const full=join(c.sourceRoot,path);assert.equal(await realpath(full),full);const s=await lstat(full);assert(s.isFile()&&!s.isSymbolicLink());
   assert.equal(hash(await readFile(full)),release.sourceHashes[path],"selected_bounded_native_source_changed");}
  const root=await identity(c.directory),ops=await identity(c.operationsDirectory);
  assert(c.directory!==c.operationsDirectory && !c.directory.startsWith(c.operationsDirectory+"/") &&
   !c.operationsDirectory.startsWith(c.directory+"/"),"separate_original_result_store_required");
  return new SharedResultProducer(c,release,root,ops);
 }
 attachNative(operator:LinuxOperatorAdapter){
  assert(!this.#operator,"selected_native_operator_already_attached");this.#operator=Object.freeze(operator);
 }
 requireAttached(operator:LinuxOperatorAdapter,sourceDigest:string){
  assert(this.#operator===operator && sourceDigest===this.sourceDigest,"selected_native_operator_or_source_mismatch");
 }
 async #guard(){
  await this.#c.bootstrapLease.assertHeld();await unchanged(this.#c.directory,this.#root);
  await unchanged(this.#c.operationsDirectory,this.#operations);
  const release=await verifyInstalledRelease(this.#c.releaseRecord,this.#c.trust);
  assert.equal(release.sourceDigest,this.sourceDigest);assert.equal(release.artifactDigest,this.#release.artifactDigest);
  for(const path of sourcePaths)assert.equal(hash(await readFile(join(this.#c.sourceRoot,path))),release.sourceHashes[path]);
 }
 #admission(value:unknown,boundValue:BoundIntent){
  const op=operation(value),bound=boundedIntent(boundValue),profile=op.plan.profile;
  assert.equal(bound.intent.operationId,op.id);assert.equal(bound.intent.journalRevision,op.draftRevision);
  assert.equal(bound.kind==="restore",op.kind==="restore");
  const mapping=profile.infrastructure.mapping;
  assert.equal(mapping.linuxInstallationId,this.#c.installationId,"explicit_original_installation_mapping_required");
  assert.equal(profile.runtime.sourceDigest,this.sourceDigest);assert.equal(profile.runtime.artifactDigest,this.#release.artifactDigest);
  assert.equal(op.plan.backend.release.sourceHead,this.#release.sourceHead);assert.equal(op.plan.backend.release.sourceTree,this.#release.sourceTree);
  assert.equal(op.plan.backend.release.selectedProfileDigest,op.plan.profileDigest);
  assert.deepEqual(Object.values(profile.identity.resources).sort(),[...this.#c.envelope.resourceKeys].sort());
  const originalTarget=bound.kind==="deploy"?bound.intent.target:bound.intent.freshTarget;
  assert.deepEqual(originalTarget,op.plan.backend.target);assert.equal(originalTarget.endpointIdentityDigest,op.plan.targetFingerprint);
  if(bound.kind==="deploy"){
   assert.deepEqual([...bound.intent.resourceKeys].sort(),[...this.#c.envelope.resourceKeys].sort());
   assert.equal(bound.intent.planDigest,op.plan.digest);assert.equal(bound.intent.draftRevision,op.draftRevision);
   assert.equal(bound.intent.appOrigin,profile.settings.origin);assert.deepEqual(bound.intent.release,op.plan.backend.release);
  }else assert.deepEqual(bound.intent.compatibleRelease,op.plan.backend.release);
  const selectedRelease=bound.kind==="deploy"?bound.intent.release:bound.intent.compatibleRelease;
  assert.deepEqual(selectedRelease.requiredServices,this.#c.envelope.requiredServices);
  const admission:Admission={policy:this.policy,operationId:op.id,installationId:this.#c.installationId,generation:this.#c.minimumGeneration,
   operationHash:hash(JSON.stringify(op)),profileHash:canonicalDigest(profile),boundHash:hash(JSON.stringify(bound)),
   sourceDigest:this.sourceDigest,artifactDigest:this.#release.artifactDigest,mappingHash:canonicalDigest(mapping),
   namespaceHash:canonicalDigest(profile.namespace),envelopeHash:canonicalDigest(this.#c.envelope)};
  return {op,bound,admission,directory:join(this.#c.directory,evidenceId(op.id))};
 }
 async admit(value:unknown,bound:BoundIntent){
  return this.#exclusive(async()=>{await this.#guard();const actual=this.#admission(value,bound);
   try{await mkdir(actual.directory,{mode:0o700});await syncDirectory(this.#c.directory);await createJSON(actual.directory,"admission",actual.admission);}
   catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
    assert.deepEqual((await read(join(actual.directory,"admission.json"),8192)).value,actual.admission,"original_admission_changed");}
   await this.#guard();return boundedIntent(actual.bound);
  });
 }
 async beginNative(value:unknown,bound:BoundIntent,lease:OperationLease,envelope:Envelope,generation:number){
  return this.#exclusive(async()=>{await this.#guard();requireNativeEnvelope(envelope);
   assert.deepEqual(envelope,this.#c.envelope,"actual_native_configuration_outside_admitted_envelope");
   assert.equal(generation,this.#c.minimumGeneration,"actual_native_generation_changed");
   const actual=this.#admission(value,bound);await lease.assertHeld();
   assert.equal(lease.directory,join(this.#c.operationsDirectory,evidenceId(actual.op.id)));
   assert.equal(lease.operationId,actual.op.id);assert.equal(lease.installationId,this.#c.installationId);
   assert.deepEqual((await read(join(actual.directory,"admission.json"),8192)).value,actual.admission);
   const original=await read(join(lease.directory,lease.intentRef.relativePath),2**20);
   assert.equal(hash(original.bytes),lease.intentRef.sha256);assert.deepEqual(original.value.intent,{operation:actual.op,bound:actual.bound});
   assert.equal(original.value.intentDigest,hash(JSON.stringify(original.value.intent)));
   // O_EXCL is a durable once-only dispatch fence. Crash/restart does not steal
   // it or replay the effect. All capacity/config checks precede this marker.
   await createJSON(actual.directory,"dispatch",{admissionHash:canonicalDigest(actual.admission),nativeIntent:lease.intentRef,holder:lease.holder});
   await lease.record("bounded-native-dispatch",{admissionHash:canonicalDigest(actual.admission),policy:this.policy});
   this.#contexts.set(lease,actual);await this.#guard();
  });
 }
 async closeNative(lease:OperationLease,value:LinuxOperationResult,clearance:Clearance|null){
  return this.#exclusive(async()=>{await this.#guard();await lease.assertHeld();
   const ctx=this.#contexts.get(lease);assert(ctx,"actual_native_dispatch_not_observed");
   let result:LinuxOperationResult;
   try{result=boundedResult(value);}
   catch(error){await lease.record("bounded-native-output-uncertain",{policy:this.policy,originalNativeEvidenceRetained:true});
    throw error; // Never serialize/truncate the invalid body or publish terminal.
   }
   assert.equal(result.operationId,ctx.op.id);const keys=new Set(Object.values(ctx.op.plan.profile.identity.resources));
   assert(result.resources.every(r=>keys.has(r.resourceKey)&&r.intentId===ctx.op.id&&r.targetIdentityDigest===ctx.op.plan.targetFingerprint));
   let clearanceRef:{relativePath:string;sha256:string}|null=null;
   if(result.outcome==="completed"){
    assert(clearance && clearance.lease===lease);assert.equal(clearance.generation,ctx.admission.generation);assert.equal(clearance.profileDigest,ctx.admission.profileHash);
    assert.deepEqual(clearance.resources,ctx.op.plan.profile.identity.resources);assert.equal(clearance.postguardSha256,result.postguard.sha256);
    assert.deepEqual(clearance.trust,this.#c.custodyTrust);
    const proof=await read(clearance.path,65536);const cleared=await readWholeClearance(clearance);
    const verifiedAt=Date.now();assert(cleared.expiresAt>verifiedAt,"clearance_expired_during_original_close");
    assert.deepEqual(proof.value,(await read(clearance.path,65536)).value,"original_clearance_changed_during_close");
    clearanceRef=await lease.record("bounded-original-clearance",{record:proof.value,verifiedAt,
     domainReadbacksSha256:clearance.domainReadbacksSha256});
   }
   const evidence=[result.rawReceipt,result.postguard,result.cleanup];
   for(const ref of evidence){assert(!ref.relativePath.includes("/") && /^[A-Za-z0-9_.-]+$/.test(ref.relativePath));
    assert.equal(hash((await read(join(lease.directory,ref.relativePath),2**20)).bytes),ref.sha256,"original_native_evidence_changed");}
   const resultHash=hash(JSON.stringify(result)+"\n"),admissionHash=canonicalDigest(ctx.admission);
   const close=await lease.record("bounded-original-result-closed",{admissionHash,resultHash,nativeIntent:lease.intentRef,
    sourceDigest:this.sourceDigest,profileDigest:ctx.admission.profileHash,clearanceRef});
   // Full result before commit marker. A torn/interrupted close remains pending.
   const saved=await createJSON(ctx.directory,"original-result",{admissionHash,resultHash,result,close});
   await createJSON(ctx.directory,"closed",{saved,admissionHash,resultHash});
   await this.#guard();return structuredClone(result);
  });
 }
 async terminal(request:Parameters<RecoveryPort["terminal"]>[0]):ReturnType<RecoveryPort["terminal"]>{
  await this.#guard();const op=operation(request.operation),directory=join(this.#c.directory,evidenceId(op.id));
  // No admission means no known dispatch. Nothing is fabricated or dispatched.
  if(await missing(directory)){await this.#guard();return {state:"pending",operationId:op.id};}
  const dir=await identity(directory),admission=(await read(join(directory,"admission.json"),8192)).value as Admission;
  assert.equal(admission.operationHash,hash(JSON.stringify(op)));assert.equal(admission.sourceDigest,this.sourceDigest);
  assert.equal(admission.installationId,this.#c.installationId);assert.equal(admission.policy,this.policy);
  if(request.retainedIntent)assert.deepEqual(this.#admission(op,request.retainedIntent).admission,admission);
  if(await missing(join(directory,"closed.json"))){await unchanged(directory,dir);await this.#guard();return {state:"pending",operationId:op.id};}
  const closed=(await read(join(directory,"closed.json"),8192)).value;
  assert.equal(closed.admissionHash,canonicalDigest(admission));assert.equal(closed.saved.relativePath,"original-result.json");
  const saved=await read(join(directory,"original-result.json"),RESULT_MAX_BYTES+16384);
  assert.equal(hash(saved.bytes),closed.saved.sha256);assert.equal(saved.value.admissionHash,closed.admissionHash);
  const result=boundedResult(saved.value.result) as LinuxOperationResult;
  assert(result.resources.every(r=>Object.values(op.plan.profile.identity.resources).includes(r.resourceKey) &&
   r.intentId===op.id && r.targetIdentityDigest===op.plan.targetFingerprint));
  assert.equal(result.operationId,op.id);assert.equal(hash(JSON.stringify(result)+"\n"),closed.resultHash);
  assert.equal(saved.value.resultHash,closed.resultHash);
  const native=join(this.#c.operationsDirectory,evidenceId(op.id)),dispatch=(await read(join(directory,"dispatch.json"),8192)).value;
  assert(/^[A-Za-z0-9_.-]+$/.test(saved.value.close.relativePath));
  assert(/^[A-Za-z0-9_.-]+$/.test(dispatch.nativeIntent.relativePath));
  const close=await read(join(native,saved.value.close.relativePath),16384);assert.equal(hash(close.bytes),saved.value.close.sha256);
  assert.equal(close.value.phase,"bounded-original-result-closed");assert.equal(close.value.operationId,op.id);
  assert.equal(close.value.installationId,this.#c.installationId);
  assert.equal(close.value.facts.resultHash,closed.resultHash);assert.equal(close.value.facts.admissionHash,closed.admissionHash);
  assert.equal(close.value.facts.sourceDigest,this.sourceDigest);assert.equal(close.value.facts.profileDigest,admission.profileHash);
  assert.deepEqual(close.value.facts.nativeIntent,dispatch.nativeIntent);
  const original=await read(join(native,dispatch.nativeIntent.relativePath),2**20);
  assert.equal(hash(original.bytes),dispatch.nativeIntent.sha256);assert.deepEqual(original.value.intent.operation,op);
  assert(original.value.operationId===op.id && original.value.installationId===this.#c.installationId &&
   original.value.intentDigest===hash(JSON.stringify(original.value.intent)));
  assert.equal(hash(JSON.stringify(original.value.intent.bound)),admission.boundHash);
  assert.equal(dispatch.admissionHash,closed.admissionHash);
  if(result.outcome==="completed"){
   const ref=close.value.facts.clearanceRef;assert(ref && /^[A-Za-z0-9_.-]+$/.test(ref.relativePath));
   const proof=await read(join(native,ref.relativePath),65536);assert.equal(hash(proof.bytes),ref.sha256);
   assert.equal(proof.value.phase,"bounded-original-clearance");assert.equal(proof.value.operationId,op.id);
   const facts=proof.value.facts;
   const body=verifyRecord(facts.record as SignedRecord<import("./independent-clearance.ts").WholeClearance>,this.#c.custodyTrust);
   assert(body.operationId===op.id && body.installationId===admission.installationId &&
    body.intentDigest===original.value.intentDigest && body.profileDigest===admission.profileHash && body.generation===admission.generation);
   assert(body.expiresAt>facts.verifiedAt && body.expiresAt<=facts.verifiedAt+30000);
   assert(body.observerHostPidNamespace===dispatch.holder.pidNamespace && body.observerNetworkNamespace===dispatch.holder.networkNamespace);
   assert.deepEqual(body.resources,op.plan.profile.identity.resources);
   assert(body.unknowns.length===0 && body.liveUnintended.length===0 && /^[a-f0-9]{64}$/.test(body.ownedUnionDigest));
   assert(body.postguardSha256===result.postguard.sha256 && body.domainReadbacksSha256===facts.domainReadbacksSha256);
   // Historical signed close is evidence only; it never renews current authority,
   // health, resource clearance or a release lease after restart.
  }
  for(const ref of [result.rawReceipt,result.postguard,result.cleanup]){
   assert(!relative(native,join(native,ref.relativePath)).startsWith("..") && !ref.relativePath.includes("/"));
   assert.equal(hash((await read(join(native,ref.relativePath),2**20)).bytes),ref.sha256);
  }
  await unchanged(directory,dir);await this.#guard();return {state:"result",result};
 }
 #exclusive<T>(run:()=>Promise<T>):Promise<T>{const next=this.#serial.then(run);this.#serial=next.catch(()=>{});return next;}
}
