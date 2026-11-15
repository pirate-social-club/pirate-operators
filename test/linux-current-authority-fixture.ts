// Prepared protocol regressions, UNRUN. Real signatures/current-policy files,
// actual authenticated key-agent UDS and actual owned command runner are used.
// The child initializer is an explicit local transport/dispatch fixture: no
// Docker/application/provider or genuine positive native acceptance is claimed.
import assert from "node:assert/strict";
import {generateKeyPairSync,createHash} from "node:crypto";
import {mkdir,mkdtemp,writeFile,readFile,readlink,realpath,lstat,readdir} from "node:fs/promises";
import {join} from "node:path";
import {acquireOperation} from "../deploy/linux/backend-state.ts";
import type {OwnedCommandInput} from "../deploy/linux/backend-command.ts";
import {createManagedKeyClient,startManagedKeyAgent} from "../deploy/linux/managed-key-channel.ts";
import {createCurrentMutationAuthority} from "../deploy/linux/current-mutation-authority.ts";
import {createProfileAuthority} from "../deploy/linux/full-profile-authority.ts";
import {signRecord,canonicalDigest,type TrustAnchor} from "../deploy/linux/installed-records.ts";
import {fixtureProfile} from "./linux-shared-native-profile-fixture.ts";
import {sharedAuthorityProtocolReader} from "./linux-shared-authority-protocol-reader.ts";
export type Change="revoke"|"expire"|"cancel";
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
export async function absent(path:string){
 try{await lstat(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return true;throw e;}
}
export async function waitFor(predicate:()=>Promise<boolean>,seconds=3){
 const end=performance.now()+seconds*1000;
 while(!await predicate()){assert(performance.now()<end,"controlled_suspend_point_not_observed");await delay(10);}
}
let tool:Promise<{executable:string;sha256:string}>|undefined;
export interface GuardDeferral {
 phase:"post-admission-lease"|"signed-current";armed:boolean;admitted:boolean;fired:boolean;
 entered:ReturnType<typeof gate>;release:ReturnType<typeof gate>;
}
export async function fixture(options:{defer?:GuardDeferral;namespaceLifetimeMillis?:number}={}){
 const temporary=process.env.TMPDIR;assert(temporary,"Root must supply an owned private TMPDIR");
 const root=await mkdtemp(join(temporary,"shared-current-dispatch-"));
 for(const role of ["configuration","control","raw","agent"])await mkdir(join(root,role),{mode:0o700});
 const profile=fixtureProfile(),installationId=profile.infrastructure.mapping.linuxInstallationId;
 const lease=await acquireOperation(join(root,"control"),"current-dispatch",installationId,
  {kind:"public-current-authority-protocol"},await readlink("/proc/self/ns/pid"));
 const pair=generateKeyPairSync("ed25519"),key=pair.privateKey.export({format:"der",type:"pkcs8"});
 const trust:TrustAnchor={keyId:"public-protocol-current",spki:pair.publicKey.export({format:"der",type:"spki"}).toString("base64")};
 const reader=await sharedAuthorityProtocolReader({root,installationId,trust,privateKey:key,lease});
 const now=Date.now(),body={installationId,requestId:"original-request",generation:1,recordId:"original-record",
  issuedAt:now-1000,expiresAt:now+60000,profile:reader.profile,profileDigest:canonicalDigest(reader.profile),outcome:"authorized-profile" as const};
 const record=signRecord(body,trust,key);
 const policy={installationId,generation:2,issuedAt:now-1000,expiresAt:now+60000,profileDigests:[body.profileDigest],
  revokedRecordIds:[] as string[],hostFingerprint:"public-protocol-host",resourceIdentity:structuredClone(reader.profile.identity)};
 const current=join(root,"configuration","current.json");
 const save=async(value:typeof policy)=>writeFile(current,JSON.stringify(signRecord(value,trust,key))+"\n",{mode:0o600});
 await save(policy);
 const proof={...structuredClone(reader.profile.namespace),expiresAt:now+60000,status:"verified" as const,
  tld:reader.profile.settings.namespace.tld,correction:""};
 const unused=()=>{throw Error("unselected_protocol_namespace_method");};
 const pause=async()=>{const d=options.defer;if(d?.armed && d.admitted && !d.fired){d.fired=true;d.entered.resolve();await d.release.promise;}};
 const authorityLease=options.defer?.phase==="signed-current"?{...lease,async assertHeld(){await lease.assertHeld();await pause();}}:lease;
 const operationLease=options.defer?.phase==="post-admission-lease"?{...lease,async assertHeld(){await lease.assertHeld();await pause();}}:lease;
 const authority=await createProfileAuthority({installationId,trust,currentAdmissionFile:current,minimumGeneration:1,
  hostFingerprint:policy.hostFingerprint,lease:authorityLease,shared:reader.shared,
  namespace:{version:3,assertWritable:unused,begin:unused,complete:unused,recover:unused,inspect:unused,
   async revalidate(){return {...structuredClone(proof),expiresAt:options.namespaceLifetimeMillis===undefined?proof.expiresAt:Date.now()+options.namespaceLifetimeMillis};}}});
 const controller=new AbortController(),signal=controller.signal;
 let lastAdmission:Awaited<ReturnType<typeof authority.admitCurrent>>|undefined;
 const plan={expiresAt:now+60000,profileDigest:body.profileDigest};
 const assertCurrent=createCurrentMutationAuthority({plan,signal,own:operationLease,requireLivePlan:true,authority,
  profileFor:async()=>{
   if(options.defer?.armed)options.defer.admitted=false;
   const actual=await authority.admitCurrent(record,proof);lastAdmission=actual;
   if(options.defer?.armed)options.defer.admitted=true;
   return actual;
  }});
 try{await assertCurrent();}catch(error){
  controller.abort();try{await reader.close();}finally{key.fill(0);}
  throw error; // Preserve original setup failure; do not strand the fixture server.
 } // Valid baseline really passes the signature/current/core path.
 tool??=(async()=>{const executable=await realpath(process.execPath);
  return {executable,sha256:createHash("sha256").update(await readFile(executable)).digest("hex")};})();
 const executable=await tool;
 const input=(name:string,argv:string[]):OwnedCommandInput=>({lease,executable:executable.executable,
  executableSha256:executable.sha256,argv,environment:{HOME:process.env.HOME,PATH:process.env.PATH,TMPDIR:temporary},
  cwd:root,outputDirectory:join(root,"raw"),name,seconds:8,signal});
 async function change(value:Change){
  if(value==="revoke")await save({...policy,revokedRecordIds:[body.recordId]});
  else if(value==="expire")await save({...policy,expiresAt:Date.now()-1});
  else controller.abort(Error("controlled_cancel"));
 }
 const expected=(value:Change)=>value==="revoke"?/profile_revoked_or_unapproved/:value==="expire"?/profile_current_authority_expired/:/native_effect_cancelled/;
 const effectArgs=(path:string)=>["--input-type=commonjs","-e",
  'require("node:fs").writeFileSync(process.argv[1],"effect",{flag:"wx",mode:384})',path];
 async function launchCount(name:string){
  let count=0;
  for(const entry of await readdir(lease.directory)){
   if(!entry.endsWith(".json"))continue;
   const row=JSON.parse(await readFile(join(lease.directory,entry),"utf8"));
   if(row.phase===name+"-launch")count++;
  }
  return count;
 }
 return {root,lease,installationId,key,trust,signal,controller,input,assertCurrent,change,expected,effectArgs,launchCount,
  reader,authority,record,proof,policy,save,plan,admission:()=>lastAdmission,
  async close(){controller.abort();await reader.close();key.fill(0);}};
}
