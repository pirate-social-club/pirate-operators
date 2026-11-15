import assert from "node:assert/strict";
import {performance} from "node:perf_hooks";
import {createLocalTargetImplementation,type LocalTargetInputs} from "../../deploy/linux/local-target-services.ts";
import type {LinuxOperation,LinuxOperationResult} from "../../apps/community-wizard/server/linux-contracts.ts";
/** Additional genuine owning qualification. Root supplies real accepted input
 * bytes and its prearmed native observer/claim/grant. All cases are UNRUN. */
export async function qualifyActualLocalTarget(input:{
 backend:LocalTargetInputs;operation:LinuxOperation;signal:AbortSignal;seconds:number;
 emit:(phase:string,status:"RUNNING"|"PASS"|"FAIL"|"UNRUN",facts?:unknown)=>Promise<void>;
}) {
 assert(input.seconds>0 && input.seconds<=1200);const end=performance.now()+input.seconds*1000;
 const check=()=>{if(input.signal.aborted || performance.now()>=end)throw new Error("actual_full_target_true_timeout");};
 const actual=await createLocalTargetImplementation(input.backend);
 const phases=["actual-target-and-profile","original-intent-binding","real-deployment-and-independent-custody","same-resource-restart-and-independent-custody"];
 let done=0,failed=false;
 async function terminal(result:LinuxOperationResult,bound:Awaited<ReturnType<typeof actual.complete.bindOperation>>){
  const original=await actual.complete.journalRecovery.terminal({operation:input.operation,retainedIntent:bound});
  check();assert(original.state==="result","original_native_result_pending");assert.deepEqual(original.result,result);
  // No retry/reconcile loop can turn native uncertainty into a requested PASS.
  assert(result.outcome==="completed" && result.unrunPhases.length===0);
  const observed=await actual.complete.observeResult({operation:input.operation,result});
  assert(observed.state==="succeeded" && observed.custody==="cleared");return result;
 }
 try{
  check();await input.emit(phases[done]!,"RUNNING");
  const inspection=await actual.complete.inspectTarget({requestId:input.operation.plan.id,target:input.operation.plan.profile.settings.target});
  assert(inspection.fingerprint===input.operation.plan.targetFingerprint && inspection.supported);check();
  await input.emit(phases[done++]!,"PASS",{fingerprint:inspection.fingerprint});
  await input.emit(phases[done]!,"RUNNING");const bound=await actual.complete.bindOperation(input.operation);check();
  await input.emit(phases[done++]!,"PASS",{operationId:bound.intent.operationId});
  await input.emit(phases[done]!,"RUNNING");
  const initial=bound.kind==="deploy"?await actual.complete.operator.deploy(bound.intent,input.signal):await actual.complete.operator.restore(bound.intent,input.signal);
  const result=await terminal(initial,bound);check();
  await input.emit(phases[done++]!,"PASS",{operationId:input.operation.id,receipt:result.rawReceipt});
  await input.emit(phases[done]!,"RUNNING");
  const restarted=await terminal(await actual.restart(input.operation.id,input.signal),bound);check();
  await input.emit(phases[done++]!,"PASS",{receipt:restarted.rawReceipt});
 }catch(error){
  failed=true;await input.emit(phases[done]??"qualification","FAIL",{type:error instanceof Error?error.name:"unknown"});throw error;
 }finally{
  for(const phase of phases.slice(done+(failed?1:0)))await input.emit(phase,"UNRUN");
  try{if(!failed)await actual.stop(input.operation.id,input.signal);await actual.close();}catch(error){await input.emit("mandatory-cleanup","FAIL",{type:error instanceof Error?error.name:"unknown",custody:"RETAINED"});throw error;}
 }
}
