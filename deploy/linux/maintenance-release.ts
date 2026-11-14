import assert from "node:assert/strict";
import {join} from "node:path";
import type {OperationLease} from "./backend-state.ts";
import {pinOriginalFence} from "./final-fence-unlink.ts";
import {readWholeClearance} from "./independent-clearance.ts";
import {verifyRecord,type SignedRecord} from "./installed-records.ts";
export async function releaseOwnedMaintenance(input:{
 directory:string;lease:OperationLease;clearance:Parameters<typeof readWholeClearance>[0];signal:AbortSignal;assertCurrent:()=>Promise<void>;
}) {
 await input.lease.assertHeld();await readWholeClearance(input.clearance);
 const fence=await pinOriginalFence(join(input.directory,"maintenance-guard.json"),65536);
 let proof:Awaited<ReturnType<typeof pinOriginalFence>>|undefined;
 try{
  const row=JSON.parse(fence.bytes.toString("utf8"));
  assert(row.installationId===input.lease.installationId && row.operationId===input.lease.operationId &&
    row.intent.sha256===input.lease.intentRef.sha256 && JSON.stringify(row.holder)===JSON.stringify(input.lease.holder),
    "original_maintenance_owner_required");
  await input.lease.record("maintenance-original-before-release",{original:row});
  // Every deferred clearance/path/parent preparation finishes BEFORE the final
  // actual current profile+namespace guard. Retain that exact signed proof.
  const clearance=await readWholeClearance(input.clearance);
  proof=await pinOriginalFence(input.clearance.path,1048576);
  assert.deepEqual(verifyRecord(JSON.parse(proof.bytes.toString("utf8")) as SignedRecord<typeof clearance>,input.clearance.trust),clearance);
  await input.assertCurrent();
  assert(clearance.expiresAt>Date.now(),"independent_native_clearance_expired_or_wrong_frame");
  proof.assertUnchangedSync();
  await fence.issueUnlink(input.signal); // Sync final identity then issue, no await gap.
  await fence.syncParent();
 }finally{try{await proof?.close();}finally{await fence.close();}}
}
