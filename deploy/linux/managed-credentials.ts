import assert from "node:assert/strict";
import {createCipheriv,createDecipheriv,randomBytes} from "node:crypto";
import {join} from "node:path";
import {readdir} from "node:fs/promises";
import {readPrivateJSON,immutableRecord,canonicalDigest,evidenceId} from "./installed-records.ts";
import {privateDirectory,type OperationLease} from "./backend-state.ts";
import {actualHTTPS,pointer} from "./actual-service-readback.ts";
import {createObjectStorage} from "../../packages/storage/files.ts";
import type {createManagedKeyClient} from "./managed-key-channel.ts";
import type {CredentialRequirement} from "../../apps/community-wizard/server/linux-contracts.ts";
import type {LinuxDraftV2} from "../../packages/community-setup/shared-linux-profile.ts";
export interface CredentialSelection {
  id:string;label:string;role:CredentialRequirement["role"];scope:string;profileId:string;
  generation:number;keyRef:string;keyGeneration:number;header:string;prefix:string;
  probe:{url:string;method:"GET"|"HEAD";expectedStatus:number;identityPointer?:string;expectedIdentity?:unknown};
}
interface CipherRecord {requestId:string;id:string;generation:number;iv:string;tag:string;ciphertext:string}
export async function createManagedCredentials(input:{
  directory:string;lease:OperationLease;channel:Awaited<ReturnType<typeof createManagedKeyClient>>;
  selections:CredentialSelection[];capturedRoots:string[];
}) {
  await privateDirectory(input.directory);let disposed=false;
  assert(input.capturedRoots.every(r=>input.directory!==r && !input.directory.startsWith(r+"/") && !r.startsWith(input.directory+"/")),"credential_store_inside_cohort");
  const selected=(draft:LinuxDraftV2)=>input.selections.filter(x=>x.role==="speech"?draft.features.learning&&x.profileId===draft.services.learningProfile:
    x.role==="publication"?x.profileId===draft.services.publicationProfile:
    x.role==="backup"?x.profileId===canonicalDigest(draft.storage.backup):
    x.role==="public-media"?x.profileId===canonicalDigest(draft.storage.publicMedia):
    draft.target.kind==="ssh-linux"&&x.profileId===draft.target.connectionRef);
  const filename=(s:CredentialSelection)=>join(input.directory,evidenceId(s.id)+"-"+s.generation+".json");
  async function load(s:CredentialSelection) {
    const c=await readPrivateJSON<CipherRecord>(filename(s));
    assert(c.id===s.id && c.generation===s.generation);return c;
  }
  async function use<T>(s:CredentialSelection,action:(value:Buffer)=>Promise<T>) {
    assert(!disposed);await input.lease.assertHeld();const c=await load(s);
    return input.channel.withKey(s.keyRef,s.keyGeneration,async key=>{
      const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(c.iv,"base64url"));
      decipher.setAAD(Buffer.from(canonicalDigest({id:s.id,generation:s.generation,installationId:input.lease.installationId})));
      decipher.setAuthTag(Buffer.from(c.tag,"base64url"));
      const value=Buffer.concat([decipher.update(Buffer.from(c.ciphertext,"base64url")),decipher.final()]);
      try {return await action(value);} finally {value.fill(0);}
    });
  }
  async function requirements(draft:LinuxDraftV2):Promise<CredentialRequirement[]> {
    const result=[];
    for(const s of selected(draft)) {
      let state:CredentialRequirement["state"]="missing";
      try {await load(s);state="saved";
        const names=(await readdir(input.directory)).filter(n=>n.startsWith(evidenceId(s.id)+"-"+s.generation+"-verified-"));
        assert(names.length<=1000,"verification_history_limit");
        for(const name of names){const proof=await readPrivateJSON<{generation:number;specDigest:string;verifiedAt:number}>(join(input.directory,name));
          if(proof.generation===s.generation && proof.specDigest===canonicalDigest(s) && Date.now()>=proof.verifiedAt && Date.now()-proof.verifiedAt<60000)state="verified";}
      } catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      result.push({id:s.id,label:s.label,role:s.role,scope:s.scope,state,correction:state==="verified"?"":"Save and verify the selected managed service credential."});
    } return result;
  }
  return {
    use,
    async profileVerified(profileId:string){
      const specs=input.selections.filter(x=>x.profileId===profileId);if(!specs.length)return false;
      for(const s of specs){const names=(await readdir(input.directory)).filter(n=>n.startsWith(evidenceId(s.id)+"-"+s.generation+"-verified-"));let valid=false;
        for(const name of names){const proof=await readPrivateJSON<any>(join(input.directory,name));
          if(proof.generation===s.generation && proof.specDigest===canonicalDigest(s) && Date.now()>=proof.verifiedAt && Date.now()-proof.verifiedAt<60000)valid=true;}
        if(!valid)return false;
      }return true;
    },
    credentialRequirements:async({draft}:{draft:LinuxDraftV2})=>requirements(draft),
    async saveCredentials({requestId,draft,values}:{requestId:string;draft:LinuxDraftV2;values:Record<string,string>}) {
      assert(!disposed);const specs=selected(draft);
      assert(Object.keys(values).length>0 && Object.keys(values).every(id=>specs.some(s=>s.id===id)),"unselected_credential");
      for(const [id,text] of Object.entries(values)){
        const s=specs.find(x=>x.id===id)!;assert(text.length>0 && text.length<=8192 && !/[\r\n\x00]/.test(text));
        const value=Buffer.from(text),iv=randomBytes(12);
        try {await input.channel.withKey(s.keyRef,s.keyGeneration,async key=>{
          const cipher=createCipheriv("aes-256-gcm",key,iv);
          cipher.setAAD(Buffer.from(canonicalDigest({id:s.id,generation:s.generation,installationId:input.lease.installationId})));
          const ciphertext=Buffer.concat([cipher.update(value),cipher.final()]);
          const record:CipherRecord={requestId,id,generation:s.generation,iv:iv.toString("base64url"),
            tag:cipher.getAuthTag().toString("base64url"),ciphertext:ciphertext.toString("base64url")};
          await immutableRecord(input.directory,evidenceId(id)+"-"+s.generation,record,input.lease);
        });}finally{value.fill(0);delete values[id];}
      }
    },
    async verifyCredentials({requestId,draft}:{requestId:string;draft:LinuxDraftV2}) {
      for(const s of selected(draft))await use(s,async bytes=>{
        if(s.role==="backup"){
          const storage=createObjectStorage(draft.storage.backup,JSON.parse(bytes.toString("utf8")));
          try{
            const actual=await storage.client.list({prefix:"backups/",limit:1,signal:AbortSignal.timeout(10000)});
            assert(actual.items.length<=1);
            await immutableRecord(input.directory,evidenceId(s.id)+"-"+s.generation+"-verified-"+evidenceId(requestId),
              {generation:s.generation,specDigest:canonicalDigest(s),verifiedAt:Date.now(),scope:"authenticated-object-list-read-only",privacy:"UNPROVED"},input.lease);
          }finally{storage.close();}return;
        }
        const u=new URL(s.probe.url);assert(u.protocol==="https:" && !/\/(health|healthz|status|metrics)\/?$/.test(u.pathname),"credential_probe_not_owner_readback");
        assert(/^[A-Za-z0-9-]+$/.test(s.header));
        const response=await actualHTTPS({url:s.probe.url,method:s.probe.method,
          headers:{[s.header]:s.prefix+bytes.toString("utf8")},seconds:10,signal:AbortSignal.timeout(10000)});
        try {
          assert(response.status===s.probe.expectedStatus,"credential_service_verification_failed");
          if(s.probe.identityPointer)assert.deepEqual(pointer(JSON.parse(response.bytes.toString("utf8")),s.probe.identityPointer),s.probe.expectedIdentity);
          else assert(false,"credential_identity_readback_required");
          await immutableRecord(input.directory,evidenceId(s.id)+"-"+s.generation+"-verified-"+evidenceId(requestId),
            {generation:s.generation,specDigest:canonicalDigest(s),verifiedAt:Date.now(),certificateFingerprint:response.certificateFingerprint},input.lease);
        } finally {response.bytes.fill(0);}
      }); return requirements(draft);
    },
    async reconcileCredentials({requestId,draft}:{requestId:string;draft:LinuxDraftV2}) {
      const requirementsValue=await requirements(draft);const records=await Promise.all(selected(draft).map(async s=>{
        try{return await load(s);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
      }));
      return {state:records.some(r=>r?.requestId===requestId)?"saved" as const:"not-saved" as const,requirements:requirementsValue};
    },
    dispose(){disposed=true;}
  };
}

