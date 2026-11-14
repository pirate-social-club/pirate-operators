import assert from "node:assert/strict";
import {join} from "node:path";
import type {OperationLease} from "./backend-state.ts";
import {pinOriginalFence} from "./final-fence-unlink.ts";
import {readWholeClearance} from "./independent-clearance.ts";
import {verifyRecord,type SignedRecord} from "./installed-records.ts";
/** Retain every original fence on uncertainty. No asynchronous preparation
 * may follow the final genuine current guard before the synchronous identity
 * check and actual unlink issuance for each separately admitted role. */
export async function releaseRestoredFences(input:{
 target:string;roles:string[];archiveSha256:string;manifestSha256:string;lease:OperationLease;
 clearance:Parameters<typeof readWholeClearance>[0];signal:AbortSignal;assertCurrent:()=>Promise<void>;
}) {
 await input.lease.assertHeld();await readWholeClearance(input.clearance);
 const rows:Array<{role:string;pin:Awaited<ReturnType<typeof pinOriginalFence>>;row:unknown}>=[];
 try{
  for(const role of input.roles){
   assert(/^[a-z][a-z0-9-]*$/.test(role));
   const pin=await pinOriginalFence(join(input.target,role,"restore-fence.json"),1048576);
   // Keep handles in the cleanup set even if the original record refuses.
   rows.push({role,pin,row:null});
   const row=JSON.parse(pin.bytes.toString("utf8"));rows[rows.length-1]!.row=row;
   assert(row.schema==="pirate.restore-fence/1" && row.archiveSha256===input.archiveSha256 &&
     row.manifestSha256===input.manifestSha256);
  }
  await input.lease.record("original-restore-fences-authorized",{rows:rows.map(r=>({
    path:join(input.target,r.role,"restore-fence.json"),dev:r.pin.identity.dev,ino:r.pin.identity.ino,original:r.row}))});
  for(const row of rows){
   await input.lease.assertHeld();
   const clearance=await readWholeClearance(input.clearance);
   const proof=await pinOriginalFence(input.clearance.path,1048576);
   try{
    assert.deepEqual(verifyRecord(JSON.parse(proof.bytes.toString("utf8")) as SignedRecord<typeof clearance>,input.clearance.trust),clearance);
    await input.assertCurrent();
    assert(clearance.expiresAt>Date.now(),"independent_native_clearance_expired_or_wrong_frame");
    proof.assertUnchangedSync();
    await row.pin.issueUnlink(input.signal);
    await row.pin.syncParent();
   }finally{await proof.close();}
  }
  return input.lease.record("original-restore-fences-released",{archiveSha256:input.archiveSha256,manifestSha256:input.manifestSha256,roles:input.roles});
 }finally{
  const closed=await Promise.allSettled(rows.map(row=>row.pin.close()));
  for(const item of closed)if(item.status==="rejected")throw item.reason;
 }
}
