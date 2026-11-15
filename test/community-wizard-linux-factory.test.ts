// UNRUN. Controlled structural services are negative inputs only.
// Positive actual construction is in linux-shared-native-genuine-scenarios.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {createSharedLinuxDeploymentPort} from "../deploy/linux/wizard-backend.ts";
const unavailable=async()=>{throw Error("a_refused_structural_driver_must_not_execute");};
function declaredServices(){
 const operator={deploy:unavailable,restore:unavailable,reconcile:unavailable};
 return {adapterId:"declaration-only",sourceDigest:"0x"+"1".repeat(64),maxStagedCiphertextBytes:1024,
  journalRecovery:{policy:"pirate.linux-journal-capacity/1",sourceDigest:"0x"+"1".repeat(64),
   intentMaxBytes:262144,resultMaxBytes:524288,terminal:unavailable},
  custody:{assertHeld:unavailable},catalog:{capabilities:unavailable},targets:{inspectTarget:unavailable},
  credentials:{credentialRequirements:unavailable,verifyCredentials:unavailable,reconcileCredentials:unavailable,saveCredentials:unavailable},
  backups:{stageBackup:unavailable,inspectBackup:unavailable},operator,
  lifecycle:{prepare:unavailable,bindOperation:unavailable,bindReconciliation:unavailable},
  intents:{assertBound:unavailable,assertReconciliation:unavailable},authority:{assertCurrent:unavailable,assertCurrentIntent:unavailable},
  postReadback:{observe:unavailable}};
}
test("actual shared factory refuses a structural recovery declaration before any driver call",{timeout:20000},()=>{
 const input=declaredServices();
 assert.throws(()=>createSharedLinuxDeploymentPort(input as never),{message:"selected_native_producer_required"});
});
test("factory construction keeps every real driver required",{timeout:20000},()=>{
 for(const group of ["custody","catalog","targets","credentials","backups","operator","lifecycle","intents","authority","postReadback"]){
  const input=declaredServices() as Record<string,unknown>;delete input[group];
  assert.throws(()=>createSharedLinuxDeploymentPort(input as never),{message:"linux_backend_services_unavailable"});
 }
});
