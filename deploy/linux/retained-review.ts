// Production caller first reads these values from its private original plan
// store and verified native result ledger. This model check is not authority.
import assert from "node:assert/strict";
import type {LinuxOperation,LinuxOperationResult,BoundLinuxIntent} from "../../apps/community-wizard/server/linux-contracts.ts";
import type {DeploymentIdentity} from "../../packages/community-setup/shared-linux-profile.ts";
export function retainedReview(input:{
 requested:LinuxOperation;stored:{operation:LinuxOperation;bound:BoundLinuxIntent};
 result:LinuxOperationResult;retainedIdentity:DeploymentIdentity|null;
 sourceDigest:string;artifactDigest:string;fingerprint:string;
}){
 const original=structuredClone(input.stored.operation),result=structuredClone(input.result);
 assert.deepEqual(input.requested,original,"original_server_predecessor_required");
 assert.deepEqual(input.retainedIdentity,original.plan.profile.identity,"original_resource_identity_required");
 assert(input.stored.bound.intent.operationId===original.id && result.operationId===original.id,"original_predecessor_binding_required");
 assert(original.plan.profile.runtime.sourceDigest===input.sourceDigest &&
  original.plan.profile.runtime.artifactDigest===input.artifactDigest &&
  original.plan.targetFingerprint===input.fingerprint,"original_predecessor_release_or_host_changed");
 assert(result.outcome==="completed","original_predecessor_effects_pending");
 const keys=Object.values(original.plan.profile.identity.resources);
 assert(keys.every(key=>result.resources.some(r=>r.resourceKey===key &&
  (r.disposition==="owned-present"||r.disposition==="confirmed-absent")))&&
  result.resources.every(r=>keys.includes(r.resourceKey)&&r.disposition!=="unknown"&&r.disposition!=="conflict"),
  "original_predecessor_resources_pending");
 return original;
}
