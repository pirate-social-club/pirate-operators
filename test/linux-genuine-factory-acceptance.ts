/** UNRUN genuine-input acceptance, separate from the 167 local protocols.
 * Root supplies actual ORIGINAL server state, current installed release and
 * closed first native attempt. The actual controller/native producer creates
 * the successor review; no supplied synthetic successor or unit host fact.
 * Physical inputs/current authority remain required; no native dispatch occurs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {lstat,readFile,readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {join,dirname} from "node:path";
import {createLinuxSetup} from "../apps/community-wizard/server/linux-setup.ts";
import {operationBytes} from "../apps/community-wizard/server/linux-operations.ts";
import {createLocalTargetImplementation,type LocalTargetInputs} from "../deploy/linux/local-target-services.ts";
import {planFrom} from "../apps/community-wizard/server/linux-boundaries.ts";
import {digestJson} from "../apps/community-wizard/server/linux-journal.ts";
import type {LinuxOperation} from "../apps/community-wizard/server/linux-contracts.ts";
import {hash} from "../deploy/linux/backend-state.ts";
const title="actual factory accepts selector-resolved canonical plans and retained reviewed upgrades without rewriting old intent";
interface GenuineFactoryInputs{
 native:LocalTargetInputs;
 first:LinuxOperation;successorOperationId:string;
 journal:{path:string;sha256:string};
 // Actual selected release is authenticated by the same native constructor.
 // No externally supplied successor plan substitutes for controller.review().

}
async function forest(root:string){
 const rows:Record<string,{sha256:string;bytes:number;dev:number;ino:number;mode:number}>={};
 async function walk(path:string,relative:string){
  const s=await lstat(path);assert(!s.isSymbolicLink(),"genuine_native_evidence_symlink");
  if(s.isDirectory()){for(const name of (await readdir(path)).sort())await walk(join(path,name),relative?relative+"/"+name:name);return;}
  assert(s.isFile() && s.nlink===1);assert(Object.keys(rows).length<10000,"genuine_evidence_inventory_bound");
  const digest=createHash("sha256");for await(const bytes of createReadStream(path))digest.update(bytes);
  const after=await lstat(path);
  assert(s.dev===after.dev && s.ino===after.ino && s.size===after.size &&
    s.mtimeMs===after.mtimeMs && s.ctimeMs===after.ctimeMs,"genuine_native_evidence_changed");
  rows[relative]={sha256:digest.digest("hex"),bytes:s.size,dev:s.dev,ino:s.ino,mode:s.mode&0o777};
 }
 await walk(root,"");return rows;
}
export function registerGenuineFactoryAcceptance(g:GenuineFactoryInputs){
 // Registration itself never provisions keys, seeds results or starts services.
 // Root's one-use controller supplies the same finite independent host custody.
 test(title,{timeout:180000},async()=>{
  const beforeJournal=await readFile(g.journal.path);assert.equal(hash(beforeJournal),g.journal.sha256);
  const retained=JSON.parse(beforeJournal.toString("utf8"));
  assert.deepEqual(operationBytes(retained),g.first,"genuine_original_journal_operation_required");
  assert.equal(g.first.plan.action,"create");
  const actual=await createLocalTargetImplementation(g.native),port=actual.complete;
  const before=await forest(g.native.operationsDirectory);
  // One ACTUAL completed native attempt must already exist; never seed a row.
  const dispatches=Object.entries(before).filter(([path])=>path.endsWith("active-operation.json"));
  assert.equal(dispatches.length,1,"one_genuine_original_native_intent_required");
  const firstBound=await port.bindOperation(g.first);assert.equal(firstBound.kind,"deploy");
  const original=await port.journalRecovery.terminal({operation:g.first,retainedIntent:firstBound});
  assert(original.state==="result" && original.result.outcome==="completed","genuine_original_completion_required");
  const originalResult=structuredClone(original);
  const controller=await createLinuxSetup(dirname(g.journal.path),port,g.native.namespace);
  assert.deepEqual(controller.snapshot().operation,retained.operation);
  await controller.review(); // Actual W6 -> SAME actual native prepare producer.
  const snapshot=controller.snapshot(),plan=snapshot.plan!;
  const successor:LinuxOperation={id:g.successorOperationId,kind:snapshot.draft!.mode,
    draftRevision:snapshot.revision,startedAt:Date.now(),plan};
  assert.equal(successor.plan.action,"upgrade");
  assert.equal(successor.plan.predecessorOperationId,g.first.id);
  assert.notEqual(g.first.id,successor.id);
  assert.deepEqual(snapshot.operation,retained.operation,"review preserves the original full operation/intent/result history");
  for(const operation of [g.first,successor]){
   assert.deepEqual(planFrom(operation.plan),operation.plan);
   // These facts come from the actual constructor's authenticated installed
   // release, never a selection row synthesized from the candidate plan.
   assert.equal(operation.plan.backend.release.sourceHead,g.native.releaseRecord.body.sourceHead);
   assert.equal(operation.plan.backend.release.sourceTree,g.native.releaseRecord.body.sourceTree);
   assert.equal(operation.plan.profile.runtime.sourceDigest,g.native.releaseRecord.body.sourceDigest);
   assert.equal(operation.plan.profile.runtime.artifactDigest,g.native.releaseRecord.body.artifactDigest);
   assert.equal(operation.plan.targetFingerprint,g.native.hostFingerprint);
  }
  const beforeBinding=await readFile(g.journal.path);
  const next=await port.bindOperation(successor);assert.equal(next.kind,"deploy");
  assert.deepEqual(await readFile(g.journal.path),beforeBinding,
    "binding the successor must not replace original attempt");
  assert.deepEqual(JSON.parse((await readFile(g.journal.path)).toString("utf8")).operation,retained.operation);
  assert.deepEqual(await port.journalRecovery.terminal({operation:g.first,retainedIntent:firstBound}),originalResult);
  const changed=structuredClone(successor);
  changed.plan.profile.identity.communityId="0x"+"ee".repeat(32);
  await assert.rejects(port.bindOperation(changed),/plan|profile|digest/i);
  const missingPredecessor=structuredClone(successor);
  missingPredecessor.plan.predecessorOperationId=null;
  const {digest:oldDigest,...preimage}=missingPredecessor.plan;
  missingPredecessor.plan.digest=digestJson(preimage);
  await assert.rejects(port.bindOperation(missingPredecessor),/upgrade_predecessor_required/);
  assert.deepEqual(await forest(g.native.operationsDirectory),before,
    "binding never dispatches an extra native transaction");
  assert.deepEqual(await readFile(g.journal.path),beforeBinding);
  // No dispose/release/foreign cleanup is inferred. Root must reconcile every
  // genuine constructor/lease/resource/domain identity under its controller.
 });
}
