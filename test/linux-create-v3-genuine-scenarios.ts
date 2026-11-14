/** UNRUN genuine-input create/restart qualification. Root supplies the actual
 * installed source, signed V3 template/current approval, local resource/host
 * lease, namespace owner, key agent and independent custody/domain observers.
 * No seeded completion, native DB row, mock capability or replacement ID.
 * Register/run ONLY under a fresh actual native resource grant. */
import assert from "node:assert/strict";
import {readFile,readdir,lstat} from "node:fs/promises";
import {join} from "node:path";
import {bootstrapLocalTarget,type LocalTargetCreateBootstrapInputs} from "../deploy/linux/bootstrap-local-target.ts";
import {readCreateProfileTemplate} from "../deploy/linux/profile-producer.ts";
import {hash} from "../deploy/linux/backend-state.ts";
import {evidenceId} from "../deploy/linux/installed-records.ts";
import type {OriginalLinuxOperation as LinuxOperation} from "../apps/community-wizard/server/linux-contracts.ts";
async function retainedFiles(root:string){
  const result:Record<string,string>={};
  for(const name of (await readdir(root)).sort()){
    const path=join(root,name),s=await lstat(path);assert(s.isFile() && !s.isSymbolicLink() && s.nlink===1);
    result[name]=hash(await readFile(path));
  }
  return result;
}
export async function runGenuineLinuxCreateV3(input:LocalTargetCreateBootstrapInputs,
  original:{requestId:string;operationId:string;draftRevision:number;signal:AbortSignal}){
  assert.equal(input.backend.runtimeProfile,"create-v3");
  // SAME production bootstrap/server. No alternative listener or factory.
  const runtime=await bootstrapLocalTarget(input),actual=runtime.implementation,port=actual.complete;
  // On any refusal/uncertainty, keep the runtime/lease with Root for actual
  // reconciliation. Do not release from a finally block or create a child.
  const caps=await port.capabilities();
  assert.deepEqual(caps.targets,["local-linux"]);assert.deepEqual(caps.operations,["create"]);
  assert.deepEqual(caps.backup,{formats:[],maxBytes:0,sessionPolicies:[]});assert.deepEqual(caps.backupProfiles,[]);
  let streamed=0,keyReads=0;
  await assert.rejects(port.stageBackup({requestId:"deferred-negative",byteLength:1,
    bytes:{async *[Symbol.asyncIterator](){streamed++;throw Error("deferred_stream_was_consumed");}}}),/create_backup_deferred/);
  await assert.rejects(port.inspectBackup({backupId:"deferred-negative",get recoveryKey(){keyReads++;throw Error("deferred_key_was_read");}}),/create_restore_deferred/);
  assert.equal(streamed,0);assert.equal(keyReads,0);
  const t=await readCreateProfileTemplate(input.backend.profileTemplateFile,input.backend.trust,input.backend.installationId);
  const target=await port.inspectTarget({requestId:original.requestId,target:t.settings.target});
  assert(target.supported && target.prepared);assert.deepEqual(target.prepared.settings,t.settings);
  const namespace=await input.backend.namespace.inspect({requestId:original.requestId,tld:t.settings.namespace.tld,
    hostingOrigin:t.settings.origin,identity:target.prepared.identity});
  assert(namespace.status==="verified","genuine_namespace_unavailable");
  const requirements=await port.verifyCredentials({requestId:original.requestId,draft:t.settings,target});
  assert(requirements.every(r=>r.state==="verified") && requirements.every(r=>r.role!=="backup"),"genuine_selected_credentials_unavailable");
  const plan=await port.prepare({requestId:original.requestId,draft:t.settings,target,namespace,
    retainedIdentity:target.prepared.identity,previousOperation:null,imported:null,restore:null});
  assert.equal(plan.profile.schema,"pirate.community-linux-profile/3");assert.equal(plan.action,"create");
  for(const key of ["restoreInspectionId","restoreManifestDigest","restoreCiphertextDigest","predecessorOperationId","sessionPolicy"] as const)
    assert.equal(plan[key],null);
  const operation:LinuxOperation={id:original.operationId,kind:"create",draftRevision:original.draftRevision,startedAt:Date.now(),plan};
  const bound=await port.bindOperation(operation);assert.equal(bound.kind,"deploy");assert(bound.kind==="deploy");
  const result=await port.operator.deploy(bound.intent,original.signal);
  assert.equal(result.outcome,"completed","original_create_not_closed");
  const terminal=await port.journalRecovery.terminal({operation,retainedIntent:bound});
  assert(terminal.state==="result");assert.deepEqual(terminal.result,result);
  const current=await port.observeResult({operation,result});assert(current.state==="succeeded" && current.custody==="cleared");
  assert.equal(current.recovery,null);assert(current.health.application && current.health.login && current.health.media);
  const retained=await retainedFiles(join(input.backend.resultsDirectory,evidenceId(operation.id)));
  const restarted=await actual.restart(operation.id,original.signal);assert.deepEqual(restarted,result);
  assert.deepEqual(await retainedFiles(join(input.backend.resultsDirectory,evidenceId(operation.id))),retained);
  const after=await port.journalRecovery.terminal({operation,retainedIntent:bound});assert.deepEqual(after,terminal);
  return {runtime,operation,bound,result,observation:current,originalResultSha256:hash(JSON.stringify(result)+"\n"),retained};
  // Root separately proves real browser/auth/media/ordinary restart and no
  // duplicate provider/resource/transaction effects with its native observer.
  // This source does not claim those facts from a file hash or health boolean.
}
