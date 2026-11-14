import assert from "node:assert/strict";
import {unlink,lstat} from "node:fs/promises";
import {join} from "node:path";
import {verifyRecord,readPrivateJSON,type SignedRecord,type TrustAnchor} from "./installed-records.ts";
import {privateFile,hash,syncDirectory,type OperationLease} from "./backend-state.ts";
export interface WholeClearance {
  installationId:string;operationId:string;intentDigest:string;profileDigest:string;generation:number;expiresAt:number;
  observerHostPidNamespace:string;observerNetworkNamespace:string;
  ownedUnionDigest:string;unknowns:unknown[];liveUnintended:unknown[];
  resources:Record<string,string>;domainReadbacksSha256:string;postguardSha256:string;
}
export async function readWholeClearance(input:{
  path:string;trust:TrustAnchor;lease:OperationLease;profileDigest:string;generation:number;
  resources:Record<string,string>;domainReadbacksSha256:string;postguardSha256:string;
}) {
  await input.lease.assertHeld();
  const actual=verifyRecord(await readPrivateJSON<SignedRecord<WholeClearance>>(input.path),input.trust);
  const active=await readPrivateJSON<{intentDigest:string}>(join(input.lease.directory,"active-operation.json"));
  assert(actual.installationId===input.lease.installationId && actual.operationId===input.lease.operationId &&
    actual.intentDigest===active.intentDigest && actual.profileDigest===input.profileDigest && actual.generation===input.generation);
  assert(actual.expiresAt>Date.now() && actual.expiresAt<=Date.now()+30000 &&
    actual.observerHostPidNamespace===input.lease.holder.pidNamespace &&
    actual.observerNetworkNamespace===input.lease.holder.networkNamespace,"independent_native_clearance_expired_or_wrong_frame");
  assert(Array.isArray(actual.unknowns) && actual.unknowns.length===0 && Array.isArray(actual.liveUnintended) &&
    actual.liveUnintended.length===0 && /^[a-f0-9]{64}$/.test(actual.ownedUnionDigest),"independent_host_union_uncertain");
  assert.deepEqual(actual.resources,input.resources);
  assert(actual.domainReadbacksSha256===input.domainReadbacksSha256 && actual.postguardSha256===input.postguardSha256,"independent_domain_or_source_readback_changed");
  return actual;
}
/** No empty callback or automatic stealing. Requires a fresh separately signed
 * independent native/resource/domain observation, not the operation's own result. */
export async function releaseClearedOperation(input:Parameters<typeof readWholeClearance>[0]) {
  const actual=await readWholeClearance(input),path=join(input.lease.directory,"active-operation.json");
  const file=await privateFile(path,65536);
  try{
    const before=await file.stat(),bytes=await file.readFile(),row=JSON.parse(bytes.toString("utf8"));
    assert(row.operationId===actual.operationId && row.installationId===actual.installationId && row.intentDigest===actual.intentDigest);
    await input.lease.assertHeld();const current=await lstat(path);
    assert(current.dev===before.dev && current.ino===before.ino && current.nlink===1,"original_lease_changed_before_release");
    await unlink(path);await syncDirectory(input.lease.directory);
  }finally{await file.close();}
}

