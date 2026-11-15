import assert from "node:assert/strict";
import {join} from "node:path";
import {open} from "node:fs/promises";
import {constants} from "node:fs";
import {createBackupStaging,MAX_CIPHERTEXT_BYTES} from "./backup-staging.ts";
import {inspectAuthenticatedFullProfile,restoreCurrentAuthorizedSnapshot,sealSnapshot} from "./cohort-archive.ts";
import {captureSnapshot,type CohortIdentity} from "./cohort-manifest.ts";
import {withRecoveryKey,createProfileAuthority,assertCompatibleRuntime,type ProfileAdmission} from "./full-profile-authority.ts";
import {readPrivateJSON,immutableRecord,canonicalDigest,type SignedRecord} from "./installed-records.ts";
import {type NamespaceProof} from "../../apps/community-wizard/server/linux-contracts.ts";
import {type OperationLease} from "./backend-state.ts";
import {syncDirectory} from "./backend-state.ts";
import type {createManagedRecoveryKeys} from "./managed-recovery-keys.ts";
export async function createFullBackupService(input:{
  stagingDirectory:string;plaintextStagingDirectory:string;inspectionDirectory:string;proofFile:string;lease:OperationLease;
  authority:Awaited<ReturnType<typeof createProfileAuthority>>;
  keyStore:Awaited<ReturnType<typeof createManagedRecoveryKeys>>;
  compatibleRuntime:Parameters<typeof assertCompatibleRuntime>[1];expectedBackendSha256:string;
}) {
  const staging=await createBackupStaging(input.stagingDirectory,input.lease);
  return {
    stageBackup:staging.stageBackup,
    async inspectBackup(request:{backupId:string;recoveryKey:string}) {
      const saved=await staging.reconcileStaged(request.backupId);
      return withRecoveryKey(request.recoveryKey,async key=>{
        const actual=await inspectAuthenticatedFullProfile({archive:join(input.stagingDirectory,request.backupId+".ciphertext"),
          archiveSha256:saved.ciphertextDigest.slice(2),key,stagingDirectory:input.plaintextStagingDirectory});
        const proof=await readPrivateJSON<NamespaceProof>(input.proofFile);
        const admitted=await input.authority.restore(actual.authority as SignedRecord<ProfileAdmission>,actual.profile,proof);
        assert(actual.manifest.identity.deploymentId===admitted.profile.identity.deploymentId &&
          actual.manifest.identity.communityId===admitted.profile.identity.communityId &&
          actual.manifest.identity.origin===admitted.profile.settings.origin,"restored_original_identity_changed");
        assertCompatibleRuntime(admitted.profile,input.compatibleRuntime);
        assert(actual.manifest.identity.profileSha256===admitted.profileDigest &&
          actual.manifest.identity.releaseSha256===admitted.profile.runtime.artifactDigest.slice(2) &&
          actual.manifest.identity.backendSha256===input.expectedBackendSha256,"authenticated_archive_source_or_backend_changed");
        assert(["operations","results","observations","plans","profiles","inspections","bootstrap"].every(role=>actual.manifest.roles.includes(role)),
          "full_original_control_cohort_required");
        const id="inspection-"+canonicalDigest({backupId:request.backupId,profileDigest:admitted.profileDigest,manifest:actual.manifestSha256});
        const value={id,backupId:request.backupId,ciphertextDigest:saved.ciphertextDigest,manifestDigest:"0x"+actual.manifestSha256,
          format:"pirate.cold-cohort/1",authenticated:true,compatible:true,profile:admitted.profile,
          sessionPolicies:["revoke-existing"] as ["revoke-existing"],corrections:[] as string[]};
        const keyRef=await input.keyStore.save(request.backupId,key);
        const manifestPath=id+".manifest.json",manifestFile=await open(join(input.inspectionDirectory,manifestPath),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try{await manifestFile.writeFile(actual.manifestBytes);await manifestFile.sync();}finally{await manifestFile.close();}
        await syncDirectory(input.inspectionDirectory);
        await immutableRecord(input.inspectionDirectory,id,{inspection:value,originalAuthority:actual.authority,keyRef,
          identity:actual.manifest.identity,roles:actual.manifest.roles,namespaceProof:proof,
          manifestEvidence:{relativePath:manifestPath,sha256:actual.manifestSha256}},input.lease);
        return value;
      });
    },
    async capture(request:{output:string;recoveryKey:string;identity:CohortIdentity;roots:Record<string,string>;
      operationLease:OperationLease;barrier:{receipt:{sha256:string};assertCold():Promise<unknown>}}) {
      await request.operationLease.assertHeld();assert(request.operationLease.installationId===input.lease.installationId);
      assert(request.identity.writerFenceSha256===request.barrier.receipt.sha256);
      await request.barrier.assertCold();
      return withRecoveryKey(request.recoveryKey,async key=>{
        const snapshot=await captureSnapshot(request.identity,request.roots);
        const result=await sealSnapshot({snapshot,key,output:request.output});
        await request.barrier.assertCold();await request.operationLease.record("full-cohort-ciphertext-created",result);return result;
      });
    },
    async restoreBytes(request:{inspectionId:string;freshTarget:string;signal:AbortSignal;assertCurrent:()=>Promise<void>}) {
      assert(typeof request.assertCurrent==="function","actual_current_effect_authority_required");
      const record=await readPrivateJSON<any>(join(input.inspectionDirectory,request.inspectionId+".json"));
      const proof=await readPrivateJSON<NamespaceProof>(input.proofFile);
      const original=await input.authority.restore(record.originalAuthority,record.inspection.profile,proof);
      assertCompatibleRuntime(original.profile,input.compatibleRuntime);
      assert(record.identity.profileSha256===original.profileDigest &&
        record.identity.backendSha256===input.expectedBackendSha256,"retained_restore_identity_changed");
      return input.keyStore.withRef(record.keyRef,async key=>{
        await request.assertCurrent();assert(!request.signal.aborted,"native_effect_cancelled");
        return restoreCurrentAuthorizedSnapshot({
        archive:join(input.stagingDirectory,record.inspection.backupId+".ciphertext"),
        archiveSha256:record.inspection.ciphertextDigest.slice(2),expectedIdentity:record.identity,expectedRoles:record.roles,
        key,stagingDirectory:input.plaintextStagingDirectory,target:request.freshTarget,signal:request.signal,assertCurrent:request.assertCurrent
      });});
    }
  };
}

