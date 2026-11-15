import {fullLinuxV2PlanFrom} from "../apps/community-wizard/server/linux-boundaries.ts";
/** UNRUN source for Root's genuine host qualification. Inputs are the REAL
 * independently pinned constructor inputs/leases/channels. No mock backend,
 * seeded result, RPC response or successful fallback is implemented here.
 * Root owns native watchdog/observer, raw logs, resources and cleanup. */
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createLocalTargetImplementation,type LocalTargetInputs} from "../deploy/linux/local-target-services.ts";
import {readProfileTemplate} from "../deploy/linux/profile-producer.ts";
import {canonicalDigest} from "../deploy/linux/installed-records.ts";
import {hash,type OperationLease} from "../deploy/linux/backend-state.ts";
import type {LinuxOperation,LinuxOperationResult} from "../apps/community-wizard/server/linux-contracts.ts";
type Scenario=
 {kind:"construct"}|
 {kind:"create"|"import";requestId:string;operationId:string;draftRevision:number}|
 {kind:"terminal"|"fresh-observe";operation:LinuxOperation}|
 {kind:"restart";operationId:string}|
 {kind:"backup";operationId:string;requestId:string;lease:OperationLease;output:string;controlStaging:string}|
 {kind:"restore";requestId:string;operationId:string;draftRevision:number;archive:string;archiveSha256:string};
export async function runGenuineSharedNativeScenario(input:LocalTargetInputs,scenario:Scenario,separateSecrets:{recoveryKey:string}){
 const actual=await createLocalTargetImplementation(input),port=actual.complete,signal=AbortSignal.timeout(900000);
 assert.equal(port.version,2);
 const names=["capabilities","inspectTarget","credentialRequirements","verifyCredentials","reconcileCredentials",
 "saveCredentials","stageBackup","inspectBackup","prepare","bindOperation","bindReconciliation","observeResult"] as const;
 assert(names.every(name=>typeof port[name]==="function"));
 assert(["deploy","restore","reconcile"].every(name=>typeof port.operator[name as keyof typeof port.operator]==="function"));
 const caps=await port.capabilities();assert.equal(caps.version,2);assert.equal(caps.sourceDigest,input.releaseRecord.body.sourceDigest);
 if(scenario.kind==="construct")return {kind:scenario.kind,sourceDigest:caps.sourceDigest,methods:12,operators:3};
 if(scenario.kind==="terminal"||scenario.kind==="fresh-observe"){
  const original=await port.journalRecovery.terminal({operation:scenario.operation,retainedIntent:null});
  const again=await port.journalRecovery.terminal({operation:scenario.operation,retainedIntent:null});
  assert.deepEqual(again,original);
  if(original.state==="pending")return {kind:scenario.kind,state:"pending"};
  const resultSha256=hash(JSON.stringify(original.result)+"\n");
  if(scenario.kind==="terminal")return {kind:scenario.kind,state:"result",resultSha256};
  const current=await port.observeResult({operation:scenario.operation,result:original.result});
  // No predetermined succeeded outcome: pending independent native/domain
  // authority is reported separately, never substituted with a capability.
  return {kind:scenario.kind,resultSha256,currentState:current.state,currentCustody:current.custody};
 }
 if(scenario.kind==="restart"){
  const original=await actual.restart(scenario.operationId,signal);
  return {kind:scenario.kind,originalResultSha256:hash(JSON.stringify(original)+"\n")};
 }
 if(scenario.kind==="backup"){
  const receipt=await actual.createBackup({operationId:scenario.operationId,requestId:scenario.requestId,operationLease:scenario.lease,
   output:scenario.output,controlStaging:scenario.controlStaging,recoveryKey:separateSecrets.recoveryKey,signal});
  assert(["operations","results","observations","plans","profiles","inspections","bootstrap"].every(role=>receipt.roles.includes(role)));
  return {kind:scenario.kind,archiveSha256:receipt.archiveSha256,manifestSha256:receipt.manifestSha256,encryptedBytes:receipt.encryptedBytes};
 }
 assert(scenario.kind==="create" || scenario.kind==="import" || scenario.kind==="restore","genuine_effect_scenario_required");
 const template=await readProfileTemplate(input.profileTemplateFile,input.trust,input.installationId);
 const target=await port.inspectTarget({requestId:scenario.requestId,target:{kind:"local-linux"}});
 assert(target.supported && target.prepared,"genuine_target_preparation_unavailable");
 const draft={...template.settings,mode:scenario.kind};
 const namespace=await input.namespace.inspect({requestId:scenario.requestId,tld:draft.namespace.tld,hostingOrigin:draft.origin,identity:target.prepared.identity});
 assert(namespace.status==="verified","genuine_current_namespace_unavailable");
 let restore:null|Awaited<ReturnType<typeof port.inspectBackup>>=null;
 if(scenario.kind==="restore"){
  const bytes=await readFile(scenario.archive);assert.equal(hash(bytes),scenario.archiveSha256);
  async function* source(){yield bytes;}
  const staged=await port.stageBackup({requestId:scenario.requestId,bytes:source(),byteLength:bytes.length});
  restore=await port.inspectBackup({backupId:staged.backupId,recoveryKey:separateSecrets.recoveryKey});
 }
 const plan=fullLinuxV2PlanFrom(await port.prepare({requestId:scenario.requestId,draft,target,namespace,restore,
  imported:scenario.kind==="import"?target.existing[0]??null:null,retainedIdentity:scenario.kind==="import"?target.existing[0]?.identity??null:null,previousOperation:null}));
 const operation:LinuxOperation={id:scenario.operationId,kind:scenario.kind,draftRevision:scenario.draftRevision,startedAt:Date.now(),plan};
 const bound=await port.bindOperation(operation);
 const result=bound.kind==="deploy"?await port.operator.deploy(bound.intent,signal):await port.operator.restore(bound.intent,signal);
 const original=await port.journalRecovery.terminal({operation,retainedIntent:bound});assert(original.state==="result");
 assert.deepEqual(original.result,result);
 const observation=await port.observeResult({operation,result});
 return {kind:scenario.kind,profileSha256:plan.profileDigest,planSha256:plan.digest,resultSha256:hash(JSON.stringify(result)+"\n"),
  outcome:result.outcome,observationState:observation.state,custody:observation.custody,
  configurationSha256:observation.state==="succeeded"?canonicalDigest(observation.sharedConfiguration):null};
 // No key/secret/body is returned or logged. Owning leases are deliberately
 // retained for independent Root native/resource/domain reconciliation.
}

export async function runGenuineSharedNativeRefusal(input:LocalTargetInputs,
 action:{kind:"construct"}|{kind:"bind";operation:LinuxOperation}|{kind:"observe";operation:LinuxOperation;result:LinuxOperationResult},
 expectedCode:string){
 // Root prepares an isolated genuine cohort and a precise single public/signature
 // mutation. Failure of an unrelated socket, type import or host setup cannot pass.
 assert(/^[a-z][a-z0-9_]+$/.test(expectedCode));
 let observed:Error|undefined;
 try{
  const actual=await createLocalTargetImplementation(input);
  if(action.kind==="bind")await actual.complete.bindOperation(action.operation);
  else if(action.kind==="observe")await actual.complete.observeResult({operation:action.operation,result:action.result as never});
 }catch(error){assert(error instanceof Error);observed=error;}
 assert(observed,"expected_refusal_did_not_occur");
 const code=(observed as Error&{code?:unknown}).code;
 assert(code===expectedCode || observed.message===expectedCode || observed.message.startsWith(expectedCode+"\n"),
  "unrelated_failure_cannot_satisfy_refusal");
 return {expectedCode,errorSha256:hash(observed.message),requiresIndependentZeroEffectProof:true};
}
