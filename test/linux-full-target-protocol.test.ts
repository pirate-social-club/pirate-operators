import assert from "node:assert/strict";
import test from "node:test";
import {generateKeyPairSync,randomBytes} from "node:crypto";
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {sharedAuthorityProtocolReader} from "./linux-shared-authority-protocol-reader.ts";
import {acquireOperation,processIdentity,hash} from "../deploy/linux/backend-state.ts";
import {canonicalDigest,signRecord,verifyRecord} from "../deploy/linux/installed-records.ts";
import {decodeRecoveryKey,withRecoveryKey,validateOriginal} from "../deploy/linux/full-profile-authority.ts";
import {captureSnapshot} from "../deploy/linux/cohort-manifest.ts";
import {sealSnapshot,inspectAuthenticatedFullProfile} from "../deploy/linux/cohort-archive.ts";
import {startManagedKeyAgent,createManagedKeyClient} from "../deploy/linux/managed-key-channel.ts";
import {createManagedCredentials} from "../deploy/linux/managed-credentials.ts";
import {createManagedRecoveryKeys} from "../deploy/linux/managed-recovery-keys.ts";
import {copyControlCohort} from "../deploy/linux/control-cohort-copy.ts";
import {validateReadback} from "../deploy/linux/actual-service-readback.ts";
import {renderFullNativeConfig,type NativeGraph} from "../deploy/linux/full-native-config.ts";
import {fixtureDraft,fixtureProfile} from "./linux-shared-native-profile-fixture.ts";
// Protocol/crypto/filesystem cases only. No fake backend or native/service acceptance.
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"pirate-full-target-source-"));
 for(const name of ["operation","keys","agent","vault","cohort","staging","configuration","control"])await mkdir(join(root,name),{mode:0o700});
 const frame=await processIdentity(process.pid);assert(frame);
 const installationId="fixture-explicit-linux-installation";
 const lease=await acquireOperation(join(root,"operation"),"source-protocol",installationId,{purpose:"unit-boundary"},frame.pidNamespace);
 const pair=generateKeyPairSync("ed25519");
 const trust={keyId:"local-protocol-issuer",spki:pair.publicKey.export({format:"der",type:"spki"}).toString("base64")};
 const privateKey=pair.privateKey.export({format:"der",type:"pkcs8"});
 await writeFile(join(root,"keys","issuer.der"),privateKey,{mode:0o600});
 const master=randomBytes(32);await writeFile(join(root,"keys","master"),master,{mode:0o600});
 return {root,lease,installationId,trust,privateKey,master,async close(){master.fill(0);privateKey.fill(0);await rm(root,{recursive:true,force:true});}};
}
test("opaque installation identity survives the real persisted lease without hashing",{timeout:20000},async()=>{
 const f=await fixture();try{const actual=JSON.parse(await readFile(join(f.root,"operation","active-operation.json"),"utf8"));assert.equal(actual.installationId,f.installationId);}
 finally{await f.close();}
});
test("real Ed25519 original-record signature rejects changed body and issuer",{timeout:20000},async()=>{
 const f=await fixture();try{
  const signed=signRecord({resource:"original",generation:2},f.trust,f.privateKey);assert.deepEqual(verifyRecord(signed,f.trust),signed.body);
  assert.throws(()=>verifyRecord({...signed,body:{resource:"other",generation:2}},f.trust));
  assert.throws(()=>verifyRecord(signed,{...f.trust,keyId:"other"}));
 }finally{await f.close();}
});
test("recovery-key decoding is canonical and the raw buffer is disposed after error",{timeout:20000},async()=>{
 const encoded="pirate-key-v1:"+Buffer.alloc(32,17).toString("base64url");let retained:Uint8Array|undefined;
 await assert.rejects(withRecoveryKey(encoded,async key=>{retained=key;throw new Error("expected-unit-failure");}));
 assert(retained && retained.every(x=>x===0));
 for(const bad of ["","password",encoded+"=",encoded.slice(0,-1),"pirate-key-v1:"+"A".repeat(44)])assert.throws(()=>decodeRecoveryKey(bad));
});
test("a signed hash-only candidate cannot become an original full profile",{timeout:20000},async()=>{
 const f=await fixture();try{
  const body:any={installationId:f.installationId,requestId:"original",generation:1,recordId:"original-record",profileDigest:"a".repeat(64),profile:{profileSha256:"a".repeat(64)},outcome:"authorized-profile"};
  assert.throws(()=>validateOriginal(signRecord(body,f.trust,f.privateKey),f.trust,f.installationId));
 }finally{await f.close();}
});
async function encrypted(f:Awaited<ReturnType<typeof fixture>>){
 const profile=fixtureProfile(),body={installationId:f.installationId,requestId:"original-request",recordId:"original-record",generation:1,
  issuedAt:Date.now()-1000,expiresAt:Date.now()+10000,profile,profileDigest:canonicalDigest(profile),outcome:"authorized-profile" as const};
 const ledger=Buffer.from(JSON.stringify(signRecord({originalNonce:"0001-raw-Case"},f.trust,f.privateKey))+"\n");
 profile.infrastructure.mapping.evidence={relativePath:"mapping.json",sha256:hash(ledger)};
 body.profileDigest=canonicalDigest(profile);
 const authority=signRecord(body,f.trust,f.privateKey);
 await writeFile(join(f.root,"configuration","mapping.json"),ledger,{mode:0o600,flag:"wx"});
 await writeFile(join(f.root,"configuration","linux-profile.json"),JSON.stringify(profile),{mode:0o600});
 await writeFile(join(f.root,"configuration","profile-authority.json"),JSON.stringify(authority),{mode:0o600});
 const identity={deploymentId:profile.identity.deploymentId,releaseSha256:"1".repeat(64),backendSha256:"2".repeat(64),
  profileSha256:canonicalDigest(profile),origin:profile.settings.origin,communityId:profile.identity.communityId,writerFenceSha256:"3".repeat(64)};
 const snapshot=await captureSnapshot(identity,{configuration:join(f.root,"configuration")}),output=join(f.root,"archive.pc1"),key=Buffer.alloc(32,33);
 const sealed=await sealSnapshot({snapshot,key,output});return {profile,authority,key,sealed};
}
test("actual encrypted archive yields full original profile and authentic signed producer bytes",{timeout:20000},async()=>{
 const f=await fixture();try{const value=await encrypted(f);
  const actual=await inspectAuthenticatedFullProfile({archive:value.sealed.output,archiveSha256:value.sealed.archiveSha256,key:value.key,stagingDirectory:join(f.root,"staging")});
  assert.deepEqual(actual.profile,value.profile);assert.deepEqual(actual.authority,value.authority);
  assert.deepEqual(validateOriginal(actual.authority,f.trust,f.installationId).profile,value.profile);
  assert.equal(actual.producerAuthorityVerified,false);assert.deepEqual(await readdir(join(f.root,"staging")),[]);
 }finally{await f.close();}
});
test("wrong key and corrupted ciphertext never return a profile and remove only owned plaintext",{timeout:20000},async()=>{
 const f=await fixture();try{const value=await encrypted(f);
  await assert.rejects(inspectAuthenticatedFullProfile({archive:value.sealed.output,archiveSha256:value.sealed.archiveSha256,key:Buffer.alloc(32,34),stagingDirectory:join(f.root,"staging")}));
  const bytes=await readFile(value.sealed.output);bytes[bytes.length-1]=bytes[bytes.length-1]!^1;await writeFile(value.sealed.output,bytes);
  await assert.rejects(inspectAuthenticatedFullProfile({archive:value.sealed.output,archiveSha256:hash(bytes),key:value.key,stagingDirectory:join(f.root,"staging")}));
  assert.deepEqual(await readdir(join(f.root,"staging")),[]);
 }finally{await f.close();}
});
async function agentFixture(f:Awaited<ReturnType<typeof fixture>>){
 const authenticationKey=randomBytes(32),socket=join(f.root,"agent","key.sock");
 const agent=await startManagedKeyAgent({socket,directory:join(f.root,"agent"),installationId:f.installationId,authenticationKey,lease:f.lease,
  keys:[{ref:"vault",generation:1,path:join(f.root,"keys","master"),bytes:32}],signingKeyFile:join(f.root,"keys","issuer.der"),trust:f.trust,
  permittedProfileDigests:new Set(),capturedRoots:[join(f.root,"cohort")]});
 const client=await createManagedKeyClient({socket,installationId:f.installationId,authenticationKey,lease:f.lease});
 return {agent,client};
}
test("real authenticated Unix key exchange disposes delivered bytes and journals nonce",{timeout:20000},async()=>{
 const f=await fixture();let a:Awaited<ReturnType<typeof agentFixture>>|undefined;try{
  a=await agentFixture(f);let delivered:Uint8Array|undefined;
  await a.client.withKey("vault",1,async key=>{assert.deepEqual(Buffer.from(key),f.master);delivered=key;});
  assert(delivered?.every(x=>x===0));assert((await readdir(join(f.root,"agent"))).some(x=>x.startsWith("used-")));
 }finally{a?.client.dispose();await a?.agent.close();await f.close();}
});
test("wrong generation and disposed management channel fail closed",{timeout:20000},async()=>{
 const f=await fixture();let a:Awaited<ReturnType<typeof agentFixture>>|undefined;try{
  a=await agentFixture(f);await assert.rejects(a.client.withKey("vault",2,async()=>{}));
  a.client.dispose();await assert.rejects(a.client.withKey("vault",1,async()=>{}));
 }finally{a?.client.dispose();await a?.agent.close();await f.close();}
});
test("credential save uses real encrypted storage and same-request reconciliation",{timeout:20000},async()=>{
 const f=await fixture();let a:Awaited<ReturnType<typeof agentFixture>>|undefined;try{
  a=await agentFixture(f);const selection={id:"publication-token",label:"Publication",role:"publication" as const,scope:f.installationId,
   profileId:"publication:verified",generation:1,keyRef:"vault",keyGeneration:1,header:"Authorization",prefix:"Bearer ",
   probe:{url:"https://provider.example/account",method:"GET" as const,expectedStatus:200,identityPointer:"/id",expectedIdentity:"owned"}};
  const credentials=await createManagedCredentials({directory:join(f.root,"vault"),capturedRoots:[join(f.root,"cohort")],lease:f.lease,channel:a.client,selections:[selection]});
  await credentials.saveCredentials({requestId:"save-original",draft:fixtureDraft(),values:{[selection.id]:"public-protocol-fixture-token"}});
  const files=await readdir(join(f.root,"vault"));assert.equal(files.length,1);
  assert(!(await readFile(join(f.root,"vault",files[0]!),"utf8")).includes("public-protocol-fixture-token"));
  const actual=await credentials.reconcileCredentials({requestId:"save-original",draft:fixtureDraft()});assert.equal(actual.state,"saved");
  await credentials.use(selection,async bytes=>{assert.equal(bytes.toString("utf8"),"public-protocol-fixture-token");});credentials.dispose();
 }finally{a?.client.dispose();await a?.agent.close();await f.close();}
});
test("managed credentials and recovery keys refuse a directory inside the captured cohort",{timeout:20000},async()=>{
 const f=await fixture();let a:Awaited<ReturnType<typeof agentFixture>>|undefined;try{
  a=await agentFixture(f);
  await assert.rejects(createManagedCredentials({directory:join(f.root,"cohort"),capturedRoots:[join(f.root,"cohort")],lease:f.lease,channel:a.client,selections:[]}));
  await assert.rejects(createManagedRecoveryKeys({directory:join(f.root,"cohort"),capturedRoots:[join(f.root,"cohort")],lease:f.lease,channel:a.client,storeId:"recovery",masterKeyRef:"vault",masterGeneration:1}));
 }finally{a?.client.dispose();await a?.agent.close();await f.close();}
});
test("recovery key persistence is encrypted, reuses its identity and rejects a changed key",{timeout:20000},async()=>{
 const f=await fixture();let a:Awaited<ReturnType<typeof agentFixture>>|undefined;try{
  a=await agentFixture(f);const store=await createManagedRecoveryKeys({directory:join(f.root,"vault"),capturedRoots:[join(f.root,"cohort")],lease:f.lease,channel:a.client,storeId:"recovery",masterKeyRef:"vault",masterGeneration:1});
  const key=Buffer.alloc(32,7),ref=await store.save("original-backup",key);
  assert.deepEqual(await store.save("original-backup",key),ref);
  await store.withRef(ref,async actual=>{assert.deepEqual(Buffer.from(actual),key);});
  await assert.rejects(store.save("original-backup",Buffer.alloc(32,8)));
 }finally{a?.client.dispose();await a?.agent.close();await f.close();}
});
test("control-cohort freeze copies original lease/history bytes without editing them",{timeout:20000},async()=>{
 const f=await fixture();try{
  await writeFile(join(f.root,"control","original.json"),'{"intent":"original"}\n',{mode:0o600});
  const before=await readFile(join(f.root,"control","original.json"));
  const actual=await copyControlCohort({source:join(f.root,"control"),target:join(f.root,"frozen-control"),lease:f.lease});
  assert.equal(actual.files.length,1);assert.deepEqual(await readFile(join(f.root,"control","original.json")),before);
  assert.deepEqual(await readFile(join(f.root,"frozen-control","original.json")),before);
 }finally{await f.close();}
});
test("handler readback rejects another installation/resource/request/generation/outcome/profile",{timeout:20000},()=>{
 const expected={installationId:"original",resourceId:"resource",requestId:"request",generation:2,outcome:"persisted",profileDigest:"a".repeat(64)};
 const selectors=Object.fromEntries(Object.keys(expected).map(k=>[k,"/"+k]));
 const spec:any={selectors,expected};
 for(const key of Object.keys(expected)){const bad:any={...expected,[key]:key==="generation"?1:"other"};assert.throws(()=>validateReadback(spec,bad));}
});
test("readback hashes without the actual persistent fields cannot pass",{timeout:20000},()=>{
 assert.throws(()=>validateReadback({selectors:{installationId:"/installationId"},expected:{generation:1}} as any,{bodySHA256:"matching"}));
});
function graph():NativeGraph{
 const scope="a".repeat(64);
 return {installationId:"opaque-installation",durableScope:scope,releaseRoot:"/fixture/release",schemaPath:"/fixture/release/workerd.capnp",stateRoots:{database:"/fixture/db",objects:"/fixture/objects",jobs:"/fixture/jobs",scheduler:"/fixture/scheduler",readiness:"/fixture/readback",reconciliation:"/fixture/reconcile"},
  socket:"/fixture/control.sock",applicationBindings:[],secretBindings:[],actors:[],requiredRoles:["application","database","objects","jobs","scheduler","assets"],
  queueConfiguration:{scope},maintenanceConfiguration:{scope},directoryRuntimeBinding:"explicit-protocol-binding-not-live",
  allowedOrigins:[],listenAddress:"127.0.0.1:8443",tls:{keyFile:"/fixture/secrets/tls",certificateFile:"/fixture/secrets/cert"},
  migrationPlanFile:"/fixture/plan.json",coldPlanFile:"/fixture/cold.json",probePlanFile:"/fixture/probes.json",
  readbackKeyFile:"/fixture/secrets/readback"};
}
test("cold native renderer excludes application/queue/scheduler namespaces and public sockets",{timeout:20000},()=>{
 const rendered=renderFullNativeConfig(graph(),"cold-reconcile");
 for(const name of ["queue","scheduler","application","gateway","readiness"])assert(!rendered.includes('(name="'+name+'",worker='));
 assert(!rendered.includes('https=('));assert(rendered.includes('className="RestoreAudit"'));
});
test("complete native renderer refuses missing selected roles, scope and Directory binding",{timeout:20000},()=>{
 for(const mutate of [(g:NativeGraph)=>g.requiredRoles.push("learning"),(g:NativeGraph)=>{g.directoryRuntimeBinding="";},
  (g:NativeGraph)=>{g.durableScope="b".repeat(64);}]){const g=graph();mutate(g);assert.throws(()=>renderFullNativeConfig(g,"serve","1".repeat(64)));}
});
test("public release bindings cannot contain plaintext private-key fields",{timeout:20000},()=>{
 const g=graph();g.applicationBindings.push({name:"COMMUNITY_PUBLISHER_PRIVATE_KEY",text:"public-unit-placeholder"});
 assert.throws(()=>renderFullNativeConfig(g,"serve","1".repeat(64)));
});


test("normalized encoded and dot-segment health paths cannot become business readbacks",{timeout:20000},async()=>{
 const {actualBusinessPath}=await import("../deploy/linux/readback-path.ts");
 for(const path of ["/health","/%68ealth","/api//health","/x/../health","//other.example/jobs"])
  assert.throws(()=>actualBusinessPath(path,"https://community.example"));
});
test("actor bindings use actual DurableObject namespaces instead of a Fetcher substitute",{timeout:20000},()=>{
 const g=graph();g.stateRoots.learning="/fixture/learning";g.requiredRoles.push("learning");
 g.actors.push({service:"learning",module:"learning.mjs",role:"learning",
  namespaces:[{className:"ServiceState",key:"explicit-original-state"}],
  bindings:[{name:"STATE",durable:{service:"learning",className:"ServiceState"}}]});
 const config=renderFullNativeConfig(g,"serve","1".repeat(64));
 assert(config.includes('(name="STATE",durableObjectNamespace=(serviceName="learning",className="ServiceState"))'));
});
test("missing owning cold-domain predicates refuses before any plan file is created",{timeout:20000},async()=>{
 const f=await fixture();try{
  const {writeColdPlan}=await import("../deploy/linux/cold-plan.ts");
  await assert.rejects(writeColdPlan({path:join(f.root,"cold-plan.json"),capturedRoots:[join(f.root,"cohort")],lease:f.lease,generation:1,
   profileDigest:"a".repeat(64),resourceId:"original-db",communityId:"0x"+"b".repeat(64),origin:"https://community.example",
   owningSourceSHA256:"c".repeat(64),queries:[]}),/complete_original_domain_predicates/);
  assert(!(await readdir(f.root)).includes("cold-plan.json"));
 }finally{await f.close();}
});

test("an application response missing or changing persisted identity cannot be labeled from its probe plan",{timeout:20000},async()=>{
 const {actualHandlerIdentity}=await import("../deploy/linux/actual-handler-identity.ts");
 const expected={installationId:"original-installation",requestId:"actual-request",generation:3,profileDigest:"a".repeat(64),outcome:"persisted"};
 const pointers=Object.fromEntries(Object.keys(expected).map(k=>[k,"/business/"+k])) as Record<keyof typeof expected,string>;
 assert.throws(()=>actualHandlerIdentity({business:{resourceId:"original"}},expected,pointers));
 for(const key of Object.keys(expected))assert.throws(()=>actualHandlerIdentity({business:{...expected,[key]:key==="generation"?2:"different"}},expected,pointers));
 assert.deepEqual(actualHandlerIdentity({business:{...expected}},expected,pointers),expected);
});
test("a native serve configuration requires a fresh actual boot identity and gates ingress on its startup service",{timeout:20000},()=>{
 const g=graph();assert.throws(()=>renderFullNativeConfig(g,"serve"));
 const config=renderFullNativeConfig(g,"serve","2".repeat(64));
 assert(config.includes('(name="STARTUP",service="startup")'));
 assert(config.includes('(name="BOOT_ID",text="'+"2".repeat(64)+'")'));
 assert(config.includes('name="private-startup"'));
 assert(!renderFullNativeConfig(g,"cold-reconcile").includes('name="private-startup"'));
});

test("an authenticated original profile with a different runtime or migration set is never called compatible",{timeout:20000},async()=>{
 const {assertCompatibleRuntime}=await import("../deploy/linux/full-profile-authority.ts"),profile=fixtureProfile();
 const installed={sourceDigest:profile.runtime.sourceDigest,artifactDigest:profile.runtime.artifactDigest,migrations:profile.runtime.migrations};
 assert.doesNotThrow(()=>assertCompatibleRuntime(profile,installed));
 assert.throws(()=>assertCompatibleRuntime(profile,{...installed,artifactDigest:"0x"+"f".repeat(64)}));
 assert.throws(()=>assertCompatibleRuntime(profile,{...installed,migrations:{}}));
});

/* V2 review regressions: protocol-only fixtures, not application/native
 * acceptance. All original23 cases and assertions remain; shared-V2 fixture/encrypted evidence inputs are explicit. */
function deferred<T>() {
 let resolve!:(value:T)=>void;return {promise:new Promise<T>(r=>{resolve=r;}),resolve:(value:T)=>resolve(value)};
}
async function authorityBoundaryFixture(){
 const f=await fixture(),reader=await sharedAuthorityProtocolReader(f),profile=reader.profile,now=Date.now();
 const close=async()=>{await reader.close();await f.close();};
 const record={installationId:f.installationId,requestId:"original-profile-request",recordId:"original-profile-record",
  generation:1,issuedAt:now-1000,expiresAt:now+60000,profile,profileDigest:canonicalDigest(profile),outcome:"authorized-profile" as const};
 const signed=signRecord(record,f.trust,f.privateKey);
 const policy={installationId:f.installationId,generation:2,issuedAt:now-1000,expiresAt:now+60000,
  profileDigests:[record.profileDigest],revokedRecordIds:[] as string[],hostFingerprint:"original-host",resourceIdentity:structuredClone(profile.identity)};
 const policyFile=join(f.root,"configuration","current.json");
 const save=async(body:typeof policy)=>writeFile(policyFile,JSON.stringify(signRecord(body,f.trust,f.privateKey)),{mode:0o600});
 await save(policy);
 const proof={...structuredClone(profile.namespace),id:profile.namespace.id,expiresAt:now+60000,status:"verified" as const,tld:profile.settings.namespace.tld,correction:""};
 const entered=deferred<{profile:typeof profile;proof:typeof proof}>(),finish=deferred<typeof proof>();
 const input={installationId:f.installationId,trust:f.trust,currentAdmissionFile:policyFile,minimumGeneration:1,
  hostFingerprint:"original-host",lease:f.lease,shared:reader.shared,namespace:{
   version:3 as const,assertWritable(){throw Error("unselected_protocol_fixture_method");},
   async begin(){throw Error("unselected_protocol_fixture_method");},
   async complete(){throw Error("unselected_protocol_fixture_method");},
   async recover(){throw Error("unselected_protocol_fixture_method");},
   async inspect(){throw new Error("unselected_protocol_fixture_method");},
   async revalidate(value:{profile:typeof profile;proof:typeof proof}){entered.resolve(value);return finish.promise;}
  }};
 const {createProfileAuthority}=await import("../deploy/linux/full-profile-authority.ts");
 const authority=await createProfileAuthority(input);
 return {...f,close,profile,record,signed,policy,policyFile,save,proof,entered,finish,input,authority};
}
test("v2 rereads expiry of the same signed current policy after deferred namespace verification",{timeout:20000},async t=>{
 const now=1_800_000_000_000;t.mock.timers.enable({apis:["Date"],now});
 const f=await authorityBoundaryFixture();try{
  await f.save({...f.policy,expiresAt:now+1000});
  const pending=f.authority.admit(f.signed,f.proof);await f.entered.promise;
  t.mock.timers.setTime(now+2000);f.finish.resolve(structuredClone(f.proof));
  await assert.rejects(pending,/profile_current_authority_expired/);
 }finally{await f.close();t.mock.timers.reset();}
});
test("v2 rereads actual signed current revocation after deferred namespace verification",{timeout:20000},async()=>{
 const f=await authorityBoundaryFixture();try{
  const pending=f.authority.admit(f.signed,f.proof);await f.entered.promise;
  const before=await readFile(f.policyFile);await f.save({...f.policy,expiresAt:Date.now()+60000,revokedRecordIds:[f.record.recordId]});
  assert.notDeepEqual(await readFile(f.policyFile),before);f.finish.resolve(structuredClone(f.proof));
  await assert.rejects(pending,/profile_revoked_or_unapproved/);
 }finally{await f.close();}
});
test("v2 pins original full profile/source/resource identity across the awaited verifier",{timeout:20000},async()=>{
 for(const change of ["source","resources","namespace"]){
  const f=await authorityBoundaryFixture();try{
   const pending=f.authority.admit(f.signed,f.proof);await f.entered.promise;
   if(change==="source")f.signed.body.profile.runtime.sourceDigest="0x"+"d".repeat(64);
   else if(change==="resources")f.signed.body.profile.identity.resources.database="changed-database";
   else f.signed.body.profile.namespace.externalAuthorityId=("0x"+"d".repeat(64)) as `0x${string}`;
   f.finish.resolve(structuredClone(f.proof));await assert.rejects(pending,/original_profile_changed_during_namespace_verification/);
  }finally{await f.close();}
 }
});
test("v2 rejects mutation of the original or delegated namespace request instead of relabeling it",{timeout:20000},async()=>{
 for(const change of ["input-proof","delegated-source","delegated-proof"]){
  const f=await authorityBoundaryFixture();try{
   const pending=f.authority.admit(f.signed,f.proof),delegated=await f.entered.promise;
   if(change==="input-proof")f.proof.id=("0x"+"a".repeat(64)) as `0x${string}`;
   else if(change==="delegated-source")delegated.profile.runtime.sourceDigest="0x"+"d".repeat(64);
   else delegated.proof.onChainScopeRevision="999";
   const expected=change==="input-proof"?/original_namespace_proof_changed/:/original_namespace_request_changed/;
   f.finish.resolve({...structuredClone(f.proof),id:f.profile.namespace.id});await assert.rejects(pending,expected);
  }finally{await f.close();}
 }
});
test("v2 rejects authority host binding changes and an actually lost original lease after deferral",{timeout:20000},async()=>{
 for(const change of ["host","lease"]){
  const f=await authorityBoundaryFixture();try{
   const pending=f.authority.admit(f.signed,f.proof);await f.entered.promise;
   if(change==="host")f.input.hostFingerprint="replacement-host";
   else await rm(join(f.lease.directory,"active-operation.json"));
   f.finish.resolve(structuredClone(f.proof));
   if(change==="host")await assert.rejects(pending,/original_authority_binding_changed/);
   else await assert.rejects(pending,/ENOENT/);
  }finally{await f.close();}
 }
});
test("v2 fresh current policy cannot conceal namespace expiry or a different namespace scope",{timeout:20000},async t=>{
 const now=1_800_000_000_000;t.mock.timers.enable({apis:["Date"],now});
 for(const change of ["expiry","scope"]){
  const f=await authorityBoundaryFixture();try{
   const pending=f.authority.admit(f.signed,f.proof);await f.entered.promise;
   const actual=structuredClone(f.proof);
   if(change==="expiry")actual.expiresAt=Date.now();else actual.onChainScopeRevision="999";
   f.finish.resolve(actual);await assert.rejects(pending,/namespace_binding_required/);
  }finally{await f.close();}
 }
 t.mock.timers.reset();
});
test("v2 unchanged exact deferred authority returns the authenticated original full profile",{timeout:20000},async()=>{
 const f=await authorityBoundaryFixture();try{
  await f.save({...f.policy,expiresAt:Date.now()+60000});
  const pending=f.authority.admit(f.signed,f.proof);await f.entered.promise;f.finish.resolve(structuredClone(f.proof));
  const actual=await pending;assert.deepEqual(actual,f.record);assert.notEqual(actual,f.signed.body);
  assert.equal(canonicalDigest(actual.profile),f.record.profileDigest);
 }finally{await f.close();}
});
test("v2 canonical public-key separation rejects equivalent encoding and issuer-ID aliases",{timeout:20000},async()=>{
 const f=await fixture();try{
  const {canonicalPublicKeyIdentity,assertIndependentTrustAnchors}=await import("../deploy/linux/installed-records.ts");
  const alias={keyId:"different-custody-label",spki:Buffer.from(f.trust.spki,"base64").toString("base64url").replace(/(.{12})/g,"$1\n")};
  assert.notEqual(alias.spki,f.trust.spki);assert.notEqual(alias.keyId,f.trust.keyId);
  assert.equal(canonicalPublicKeyIdentity(alias),canonicalPublicKeyIdentity(f.trust));
  // Same signing material can cryptographically sign under the other label;
  // the independence guard must reject it before accepting custody.
  verifyRecord(signRecord({operationId:"protocol-original"},alias,f.privateKey),alias);
  assert.throws(()=>assertIndependentTrustAnchors(f.trust,alias),/separate_independent_custody_key_required/);
  const other=generateKeyPairSync("ed25519"),distinct={keyId:"genuine-independent-custody",spki:other.publicKey.export({format:"der",type:"spki"}).toString("base64")};
  assert.doesNotThrow(()=>assertIndependentTrustAnchors(f.trust,distinct));
 }finally{await f.close();}
});
test("v2 actual full-target factory refuses an equivalent issuer key before any target effect",{timeout:20000},async()=>{
 const f=await fixture();try{
  const {createLocalTargetImplementation}=await import("../deploy/linux/local-target-services.ts");
  const custodyTrust={keyId:"aliased-custody",spki:f.trust.spki+"\n"};
  await assert.rejects(createLocalTargetImplementation({installationId:f.installationId,bootstrapLease:f.lease,trust:f.trust,custodyTrust} as any),
   /separate_independent_custody_key_required/);
 }finally{await f.close();}
});
// Source-derived EXACT producer forms: accounts.ts:167 and:188. The ordinary
// statement/chain/times match:170-181; V4 uses the actual protocol builder.
// These are not fake D1/HTTP handlers and do not qualify application acceptance.
async function loginBoundaryFixture(){
 const {createSiweMessage}=await import("viem/siwe"),{privateKeyToAccount}=await import("viem/accounts");
 const {signInMessageV4}=await import("../packages/protocol/learning-results-v4.ts");
 const {validateLoginChallenge,captureLoginBinding}=await import("../deploy/linux/actual-login-probe.ts");
 // Existing public local fixture key from learning-sign-in.test.ts. Never fund.
 const key=Buffer.from("21".repeat(32),"hex"),account=privateKeyToAccount(("0x"+key.toString("hex")) as `0x${string}`);
 const scope={origin:"https://community.example",communityId:"0x"+"a".repeat(64),chainId:6343 as 6343|31337,
  contract:"0x00000000000000000000000000000000000000c4",publicationPolicy:"0x"+"c".repeat(64)};
 const now=Date.now(),ordinaryFields={address:account.address,chainId:6343,domain:"community.example",uri:scope.origin,version:"1" as const,
  nonce:"b".repeat(64),issuedAt:new Date(now),expirationTime:new Date(now+300000),
  statement:"Sign in to this community. This does not join, create a creator wallet or authorize spending."};
 const ordinary=(fields:Partial<typeof ordinaryFields>={})=>({id:"a".repeat(64),message:createSiweMessage({...ordinaryFields,...fields})});
 const v4=(patch:Partial<typeof scope>={})=>{const c={...scope,...patch};return {id:"d".repeat(64),kind:"sign-in-v4" as const,
  message:signInMessageV4({...c,contract:c.contract as `0x${string}`,communityId:c.communityId as `0x${string}`,publicationPolicy:c.publicationPolicy as `0x${string}`},
   {learner:account.address,nonce:("0x"+"b".repeat(64)) as `0x${string}`,issuedAt:BigInt(Math.floor(now/1000)-60)})};};
 return {key,account,scope,ordinary,v4,validateLoginChallenge,captureLoginBinding};
}
test("v2 recognizes the exact ordinary producer variant without a kind or publication permission",{timeout:20000},async()=>{
 const f=await loginBoundaryFixture();try{
  const original=f.ordinary(),actual=f.validateLoginChallenge(original,f.account.address,f.scope);
  assert.deepEqual(Object.keys(actual).sort(),["id","message"]);assert.deepEqual(actual,original);assert(Object.isFrozen(actual));
  const {readSignInMessageV4}=await import("../packages/protocol/learning-results-v4.ts");assert.equal(readSignInMessageV4(actual.message),undefined);
 }finally{f.key.fill(0);}
});
test("v2 recognizes the exact V4 producer variant and its original chain/community/contract/policy",{timeout:20000},async()=>{
 const f=await loginBoundaryFixture();try{
  const original=f.v4(),actual=f.validateLoginChallenge(original,f.account.address,f.scope);
  assert.deepEqual(Object.keys(actual).sort(),["id","kind","message"]);assert.deepEqual(actual,original);assert(Object.isFrozen(actual));
  const local={...f.scope,chainId:31337 as const};assert.deepEqual(f.validateLoginChallenge(f.v4(local),f.account.address,local),f.v4(local));
 }finally{f.key.fill(0);}
});
test("v2 rejects malformed and mixed challenge variants instead of inventing another producer shape",{timeout:20000},async()=>{
 const f=await loginBoundaryFixture();try{
  for(const bad of [null,[],{}, {...f.ordinary(),kind:"siwe"},{...f.ordinary(),kind:undefined},
   {...f.ordinary(),kind:"sign-in-v4"},{id:f.v4().id,message:f.v4().message},{...f.v4(),kind:"siwe"},
   {...f.ordinary(),grant:true},{...f.ordinary(),id:"bad"},{...f.ordinary(),message:"not SIWE"}])
   assert.throws(()=>f.validateLoginChallenge(bad,f.account.address,f.scope));
 }finally{f.key.fill(0);}
});
test("v2 ordinary challenges retain exact domain/chain/origin/account/nonce/statement/time fences",{timeout:20000},async()=>{
 const f=await loginBoundaryFixture();try{
  const original=f.ordinary();
  for(const fields of [{domain:"other.example"},{uri:"https://other.example"},{chainId:31337},
   {address:"0x1111111111111111111111111111111111111111" as `0x${string}`},{nonce:"0".repeat(64)},
   {statement:"Authorize a new permission"},{issuedAt:new Date(Date.now()-180000),expirationTime:new Date(Date.now()+120000)}])
   assert.throws(()=>f.validateLoginChallenge(f.ordinary(fields),f.account.address,f.scope));
  for(const value of [original.message.replace("Nonce: "+"b".repeat(64),"Nonce: zzzzzzzz"),
   original.message.replace("Version: 1","Version: 2"),original.message+"\nResources:\n- https://other.example/grant"])
   assert.throws(()=>f.validateLoginChallenge({...original,message:value},f.account.address,f.scope));
 }finally{f.key.fill(0);}
});
test("v2 V4 scope mismatches and malformed nonce cannot pass the ordinary fallback",{timeout:20000},async()=>{
 const f=await loginBoundaryFixture();try{
  for(const patch of [{origin:"https://other.example"},{chainId:31337 as const},{communityId:"0x"+"e".repeat(64)},
   {contract:"0x00000000000000000000000000000000000000e4"},{publicationPolicy:"0x"+"e".repeat(64)}])
   assert.throws(()=>f.validateLoginChallenge(f.v4(patch),f.account.address,f.scope));
  const v4=f.v4();assert.throws(()=>f.validateLoginChallenge({...v4,message:v4.message.replace("Nonce: "+"b".repeat(64),"Nonce: "+"0".repeat(64))},f.account.address,f.scope));
 }finally{f.key.fill(0);}
});
test("v2 a withdrawn/configured V4 account's ordinary fallback remains ordinary on the producer's fixed chain",{timeout:20000},async()=>{
 const f=await loginBoundaryFixture();try{
  const local={...f.scope,chainId:31337 as const},actual=f.validateLoginChallenge(f.ordinary(),f.account.address,local);
  assert(!("kind" in actual));const {readSignInMessageV4}=await import("../packages/protocol/learning-results-v4.ts");
  assert.equal(readSignInMessageV4(actual.message),undefined);
  // Actual withdrawal DB/authorization behavior is the unchanged owning
  // learning-sign-in.test.ts scenario; this case checks only client parsing.
 }finally{f.key.fill(0);}
});
test("v2 real pinned signing verifies offline for both exact forms without transport or posting",{timeout:20000},async()=>{
 const f=await loginBoundaryFixture(),input={key:f.key,scope:{...f.scope},signal:new AbortController().signal},binding=f.captureLoginBinding(input);
 try{
  const {verifyMessage}=await import("viem");
  for(const value of [f.ordinary(),f.v4()]){
   const actual=await binding.sign(value);assert.deepEqual(actual.proof,value);
   assert(await verifyMessage({address:binding.address,message:actual.proof.message,signature:actual.signature}));
   assert(!("postingAuthority" in actual) && !("session" in actual));
  }
 }finally{binding.dispose();f.key.fill(0);}
});
test("v2 a deferred challenge cannot move the original origin/community/signer/signal before signing",{timeout:20000},async()=>{
 for(const change of ["origin","community","key","signal","abort"]){
  const f=await loginBoundaryFixture(),abort=new AbortController(),input={key:f.key,scope:{...f.scope},signal:abort.signal},binding=f.captureLoginBinding(input);
  try{
   const gate=deferred<void>(),pending=(async()=>{await gate.promise;return binding.sign(f.ordinary());})();
   if(change==="origin")input.scope.origin="https://other.example";else if(change==="community")input.scope.communityId="0x"+"e".repeat(64);
   else if(change==="key")input.key[0]=input.key[0]!^1;else if(change==="signal")input.signal=new AbortController().signal;else abort.abort();
   gate.resolve(undefined);await assert.rejects(pending);
  }finally{binding.dispose();f.key.fill(0);}
 }
});
test("v2 mutations during actual asynchronous signing cannot return a verification proof",{timeout:20000},async()=>{
 for(const change of ["scope","challenge"]){
  const f=await loginBoundaryFixture(),input={key:f.key,scope:{...f.scope},signal:new AbortController().signal},binding=f.captureLoginBinding(input);
  try{
   const value=f.ordinary(),pending=binding.sign(value);
   if(change==="scope")input.scope.publicationPolicy="0x"+"e".repeat(64);else value.id="e".repeat(64);
   await assert.rejects(pending,change==="scope"?/actual_login_binding_changed/:/actual_login_challenge_changed/);
  }finally{binding.dispose();f.key.fill(0);}
 }
});
test("v2 a challenge that becomes stale during signing is rejected and a disposed signer cannot be reused",{timeout:20000},async t=>{
 const now=1_800_000_000_000;t.mock.timers.enable({apis:["Date"],now});
 const f=await loginBoundaryFixture(),input={key:f.key,scope:{...f.scope},signal:new AbortController().signal},binding=f.captureLoginBinding(input);
 try{
  const pending=binding.sign(f.ordinary());t.mock.timers.setTime(now+120001);
  await assert.rejects(pending,/actual_login_scope_or_time_changed/);
  binding.dispose();assert.throws(()=>binding.assertCurrent(),/actual_login_binding_withdrawn/);
 }finally{binding.dispose();f.key.fill(0);t.mock.timers.reset();}
});
