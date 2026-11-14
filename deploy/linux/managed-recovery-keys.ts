import assert from "node:assert/strict";
import {createCipheriv,createDecipheriv,randomBytes,timingSafeEqual} from "node:crypto";
import {join} from "node:path";
import {privateDirectory,type OperationLease} from "./backend-state.ts";
import {readPrivateJSON,immutableRecord,canonicalDigest} from "./installed-records.ts";
import type {createManagedKeyClient} from "./managed-key-channel.ts";
export async function createManagedRecoveryKeys(input:{
  directory:string;capturedRoots:string[];storeId:string;masterKeyRef:string;masterGeneration:number;lease:OperationLease;
  channel:Awaited<ReturnType<typeof createManagedKeyClient>>;
}) {
  await privateDirectory(input.directory);
  assert(input.capturedRoots.every(r=>input.directory!==r && !input.directory.startsWith(r+"/") && !r.startsWith(input.directory+"/")),"recovery_key_store_inside_cohort");
  const generation=input.masterGeneration;
  async function use<T>(keyId:string,action:(key:Uint8Array)=>Promise<T>){
    assert(/^[a-f0-9]{64}$/.test(keyId));await input.lease.assertHeld();
    const row=await readPrivateJSON<any>(join(input.directory,keyId+".json"));
    assert(row.storeId===input.storeId && row.keyId===keyId && row.generation===generation);
    return input.channel.withKey(input.masterKeyRef,generation,async master=>{
      const decipher=createDecipheriv("aes-256-gcm",master,Buffer.from(row.iv,"base64url"));
      decipher.setAAD(Buffer.from(canonicalDigest({installationId:input.lease.installationId,keyId,generation})));
      decipher.setAuthTag(Buffer.from(row.tag,"base64url"));
      const key=Buffer.concat([decipher.update(Buffer.from(row.ciphertext,"base64url")),decipher.final()]);
      try{assert(key.length===32);return await action(key);}finally{key.fill(0);}
    });
  }
  return {
    async save(backupId:string,key:Uint8Array){
      assert(key.length===32);const keyId=canonicalDigest({installationId:input.lease.installationId,backupId});
      try{await use(keyId,async original=>{assert(timingSafeEqual(original,key),"backup_original_key_conflict");});}
      catch(e){
        if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;
        await input.channel.withKey(input.masterKeyRef,generation,async master=>{
          const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",master,iv);
          cipher.setAAD(Buffer.from(canonicalDigest({installationId:input.lease.installationId,keyId,generation})));
          const ciphertext=Buffer.concat([cipher.update(key),cipher.final()]);
          await immutableRecord(input.directory,keyId,{storeId:input.storeId,keyId,generation,
            iv:iv.toString("base64url"),tag:cipher.getAuthTag().toString("base64url"),ciphertext:ciphertext.toString("base64url")},input.lease);
        });
      }
      return {storeId:input.storeId,keyId,generation};
    },
    async withRef<T>(ref:{storeId:string;keyId:string;generation:number},action:(key:Uint8Array)=>Promise<T>){
      assert(ref.storeId===input.storeId && ref.generation===generation);return use(ref.keyId,action);
    }
  };
}

