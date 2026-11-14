import {linuxProfileFrom as restorableLinuxProfileFrom} from "../../packages/community-setup/shared-linux-profile.ts";
import assert from "node:assert/strict";
import {join} from "node:path";
import {originalLinuxProfileFrom, type OriginalLinuxProfile} from "../../packages/community-setup/linux-create-profile.ts";
import type {NamespaceAuthorityPort,NamespaceProof} from "../../apps/community-wizard/server/linux-contracts.ts";
import {canonicalDigest,verifyRecord,readPrivateJSON,immutableRecord,type SignedRecord,type TrustAnchor} from "./installed-records.ts";
import {sameNamespaceAuthority} from "../../packages/community-setup/shared-namespace-proof.ts";
import {bindingKey} from "../../packages/community-names/namespace-import.ts";
import type {createSharedRuntimeReader} from "./shared-runtime-readback.ts";
import {type OperationLease} from "./backend-state.ts";
export const ORIGINAL_PROFILE_PATH="configuration/linux-profile.json";
export const ORIGINAL_AUTHORITY_PATH="configuration/profile-authority.json";
export interface ProfileAdmission {
  installationId:string;requestId:string;generation:number;recordId:string;issuedAt:number;expiresAt:number;
  profile:OriginalLinuxProfile;profileDigest:string;outcome:"authorized-profile";
}
export interface CurrentAdmission {
  installationId:string;generation:number;issuedAt:number;expiresAt:number;profileDigests:string[];
  revokedRecordIds:string[];hostFingerprint:string;resourceIdentity:OriginalLinuxProfile["identity"];
}
export function decodeRecoveryKey(value:string) {
  assert(typeof value==="string" && /^pirate-key-v1:[A-Za-z0-9_-]{43}(?![\s\S])/.test(value),"recovery_key_encoding");
  const key=Buffer.from(value.slice(14),"base64url");
  try{assert(key.length===32 && key.toString("base64url")===value.slice(14),"recovery_key_encoding");return key;}
  catch(error){key.fill(0);throw error;}
}
export async function withRecoveryKey<T>(value:string,action:(key:Uint8Array)=>Promise<T>) {
  const key=decodeRecoveryKey(value);try{return await action(key);}finally{key.fill(0);}
}
export function validateOriginal(record:SignedRecord<ProfileAdmission>,trust:TrustAnchor,installationId:string) {
  const original=verifyRecord(record,trust);assert(original.installationId===installationId && original.outcome==="authorized-profile");
  assert(original.requestId && original.recordId && Number.isSafeInteger(original.generation) && original.generation>0);
  const profile=originalLinuxProfileFrom(original.profile);assert.deepEqual(profile,original.profile);
  assert(profile.infrastructure.mapping.linuxInstallationId===installationId,"original_profile_installation_mapping_changed");
  assert.equal(canonicalDigest(profile),original.profileDigest);return original;
}
export async function createProfileAuthority(input:{
  installationId:string;trust:TrustAnchor;currentAdmissionFile:string;minimumGeneration:number;hostFingerprint:string;
  lease:OperationLease; namespace:NamespaceAuthorityPort;shared:Awaited<ReturnType<typeof createSharedRuntimeReader>>;
}) {
  const lease=input.lease,namespace=input.namespace,shared=input.shared;
  assert(namespace.version===3,"current_namespace_owner_v3_required");
  const bound={installationId:input.installationId,trust:structuredClone(input.trust),currentAdmissionFile:input.currentAdmissionFile,
    minimumGeneration:input.minimumGeneration,hostFingerprint:input.hostFingerprint};
  const leaseIdentity=()=>({installationId:lease.installationId,operationId:lease.operationId,directory:lease.directory,holder:lease.holder});
  const originalLeaseIdentity=structuredClone(leaseIdentity());
  function assertBinding() {
    assert(input.lease===lease && input.namespace===namespace && input.shared===shared,"original_authority_owner_changed");
    assert.deepEqual({installationId:input.installationId,trust:input.trust,currentAdmissionFile:input.currentAdmissionFile,
      minimumGeneration:input.minimumGeneration,hostFingerprint:input.hostFingerprint},bound,"original_authority_binding_changed");
    assert.deepEqual(leaseIdentity(),originalLeaseIdentity,"original_authority_lease_identity_changed");
  }
  async function current(original:ProfileAdmission) {
    assertBinding();const requested=structuredClone(original);await lease.assertHeld();
    const actual=verifyRecord(await readPrivateJSON<SignedRecord<CurrentAdmission>>(bound.currentAdmissionFile),bound.trust);
    assertBinding();assert.deepEqual(original,requested,"original_profile_changed_during_current_read");
    const now=Date.now();assert(actual.installationId===bound.installationId && actual.generation>=bound.minimumGeneration &&
      actual.generation>=requested.generation && actual.issuedAt<=now && actual.expiresAt>now,"profile_current_authority_expired");
    assert(actual.profileDigests.includes(requested.profileDigest) && !actual.revokedRecordIds.includes(requested.recordId),"profile_revoked_or_unapproved");
    assert.equal(actual.hostFingerprint,bound.hostFingerprint);assert.deepEqual(actual.resourceIdentity,requested.profile.identity);
    return actual;
  }
  return {
    async admitCurrent(record:SignedRecord<ProfileAdmission>,proof:NamespaceProof) {
      assertBinding();
      const signed=structuredClone(record),provided=structuredClone(proof);
      const original=validateOriginal(signed,bound.trust,bound.installationId);await current(original);
      await shared.binding(original.profile);await current(original);
      // The adapter receives independent copies. A deferred callback cannot
      // rewrite the authenticated original profile/source/resources or proof.
      const delegated={proof:structuredClone(provided),profile:structuredClone(original.profile)};
      const actual=structuredClone(await namespace.revalidate(delegated));
      // Namespace verification is an asynchronous authority boundary: reread
      // the actual signed current policy, never reuse the pre-await decision.
      await current(original);assertBinding();
      assert.deepEqual(delegated,{proof:provided,profile:original.profile},"original_namespace_request_changed");
      assert.deepEqual(record,signed,"original_profile_changed_during_namespace_verification");
      assert.deepEqual(proof,provided,"original_namespace_proof_changed");
      const now=Date.now(),scope=original.profile.namespace;
      // Historical original authorization may expire. CURRENT policy and the
      // fresh actual namespace proof must still hold after every awaited check.
      assert(original.issuedAt<=now && original.expiresAt>original.issuedAt,"profile_original_authorization_invalid");
      assert(actual.status==="verified" && actual.tld===original.profile.settings.namespace.tld && actual.expiresAt>now && sameNamespaceAuthority(actual,scope) &&
        bindingKey(actual.binding)===bindingKey(scope.binding),"namespace_binding_required");
      assert(original.profile.infrastructure.mapping.linuxInstallationId===bound.installationId &&
        bindingKey(actual.binding)===bindingKey(original.profile.infrastructure.binding),"original_shared_mapping_required");
      await shared.read(original.profile,lease,AbortSignal.timeout(45000));
      // Both current signed authorization and namespace lifetime are checked
      // AFTER every asynchronous authority/source/mapping read.
      await current(original);assertBinding();
      assert(actual.expiresAt>Date.now(),"namespace_expired_during_mapping_verification");
      return {original,namespace:actual};
    },
    async admit(record:SignedRecord<ProfileAdmission>,proof:NamespaceProof) {
      return (await this.admitCurrent(record,proof)).original;
    },
    async restore(record:SignedRecord<ProfileAdmission>,profile:unknown,proof:NamespaceProof) {
      // Deferred archive/restore remains V2-only. Reject a V3 profile before
      // any awaited namespace/current-policy lookup or recovery-key owner.
      const restored=restorableLinuxProfileFrom(profile);
      assert.deepEqual(restorableLinuxProfileFrom(record.body.profile),restored);
      const original=await this.admit(record,proof);assert.deepEqual(original.profile,restored);
      return {...original,profile:restored};
    },
    async commitOriginal(directory:string,record:SignedRecord<ProfileAdmission>,proof:NamespaceProof) {
      const original=await this.admit(record,proof);
      // directory is the captured configuration role root; exact filenames and
      // full JSON become the real archive producer, never just a digest.
      const profile=await immutableRecord(directory,"linux-profile",original.profile,input.lease);
      const authority=await immutableRecord(directory,"profile-authority",record,input.lease);
      const directoryEvidence=await shared.retainOriginal(directory,original.profile,input.lease);
      await input.lease.record("original-full-profile-produced",{installationId:input.installationId,
        requestId:original.requestId,generation:original.generation,recordId:original.recordId,
        profileDigest:original.profileDigest,resourceIdentity:original.profile.identity,profile,authority,outcome:original.outcome});
      await this.admit(record,proof);
      return {profile,authority,directoryEvidence};
    },
    current
  };
}


export function assertCompatibleRuntime(profile:OriginalLinuxProfile,installed:{
 sourceDigest:string;artifactDigest:string;migrations:Record<string,string>;
}){
 assert(profile.runtime.sourceDigest===installed.sourceDigest && profile.runtime.artifactDigest===installed.artifactDigest,
   "authenticated_archive_runtime_not_installed");
 assert.deepEqual(profile.runtime.migrations,installed.migrations,"authenticated_archive_migration_set_not_installed");
}
