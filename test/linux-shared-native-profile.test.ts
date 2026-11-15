import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,randomBytes} from "node:crypto";
import {mkdir,mkdtemp,writeFile,readFile,readlink,rename,open,lstat} from "node:fs/promises";
import {join} from "node:path";
import {fixtureProfile} from "./linux-shared-native-profile-fixture.ts";
import {linuxProfileFrom} from "../packages/community-setup/shared-linux-profile.ts";
import {validateOriginal,decodeRecoveryKey,withRecoveryKey} from "../deploy/linux/full-profile-authority.ts";
import {signRecord,canonicalDigest,type TrustAnchor} from "../deploy/linux/installed-records.ts";
import {captureSnapshot} from "../deploy/linux/cohort-manifest.ts";
import {acquireOperation} from "../deploy/linux/backend-state.ts";
import {sharedAuthorityProtocolReader} from "./linux-shared-authority-protocol-reader.ts";
import {sealSnapshot,inspectAuthenticatedFullProfile} from "../deploy/linux/cohort-archive.ts";
function signer(){
 const pair=generateKeyPairSync("ed25519"),trust:TrustAnchor={keyId:"public-test-profile",spki:pair.publicKey.export({format:"der",type:"spki"}).toString("base64")};
 return {trust,key:pair.privateKey.export({format:"der",type:"pkcs8"})};
}
function body(){
 const profile=fixtureProfile();return {installationId:profile.infrastructure.mapping.linuxInstallationId,
  generation:2,requestId:"fixture-request",recordId:"fixture-record",issuedAt:Date.now()-100,expiresAt:Date.now()+60000,
  profile,profileDigest:canonicalDigest(profile),outcome:"authorized-profile" as const};
}
test("real Ed25519 original signature and complete V2 profile preserve independent explicit IDs",{timeout:20000},()=>{
 const s=signer(),original=body();try{
  const result=validateOriginal(signRecord(original,s.trust,s.key),s.trust,original.installationId);
  assert.deepEqual(result,original);assert.equal(result.profile.infrastructure.mapping.linuxInstallationId,"fixture-explicit-linux-installation");
  assert.equal(result.profile.infrastructure.mapping.directoryInstallationId,"0x"+"e".repeat(64));
 }finally{s.key.fill(0);}
 // Only the original signature/codec is tested, not current authority or host readiness.
});
test("wrong issuer signature installation and complete profile preimage refuse",{timeout:20000},()=>{
 const s=signer(),other=signer(),original=body(),record=signRecord(original,s.trust,s.key);
 try{
  assert.throws(()=>validateOriginal(record,other.trust,original.installationId));
  assert.throws(()=>validateOriginal(record,s.trust,"another-opaque-installation"));
  const changed=structuredClone(record);changed.body.profile.settings.origin="https://other.example";
  assert.throws(()=>validateOriginal(changed,s.trust,original.installationId));
  assert.throws(()=>validateOriginal({...record,signature:record.signature.slice(1)},s.trust,original.installationId));
 }finally{s.key.fill(0);other.key.fill(0);}
});
test("V1 cannot become V2 through a marker or signature",{timeout:20000},()=>{
 const p=fixtureProfile();
 assert.throws(()=>linuxProfileFrom({...p,schema:"pirate.community-linux-profile/1"}));
 const s=signer(),b=body();try{
  const legacy={...b,profile:{...b.profile,schema:"pirate.community-linux-profile/1"}};
  assert.throws(()=>validateOriginal(signRecord(legacy,s.trust,s.key) as never,s.trust,b.installationId));
 }finally{s.key.fill(0);}
});
test("source registry resource and Directory mapping mutations are not normalized away",{timeout:20000},()=>{
 const p=fixtureProfile();
 for(const mutate of [
  (x:typeof p)=>{x.infrastructure.mapping.directoryInstallationId="0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";},
  (x:typeof p)=>{x.infrastructure.binding.sourceSha256="b".repeat(64);},
  (x:typeof p)=>{x.identity.communityId="0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";},
  (x:typeof p)=>{x.infrastructure.configuration.app.origin="https://other.example";},
 ]){
  const changed=structuredClone(p);mutate(changed);assert.throws(()=>linuxProfileFrom(changed));
 }
});
test("separate recovery-key channel decodes exact canonical 32 bytes; malformed inputs refuse",{timeout:20000},async()=>{
 const key=randomBytes(32),encoded="pirate-key-v1:"+key.toString("base64url");
 try{const decoded=decodeRecoveryKey(encoded);assert.deepEqual(decoded,key);decoded.fill(0);
  for(const value of [encoded+"=",encoded+"\n","0x"+key.toString("hex"),"pirate-key-v1:"+key.toString("base64"),
   "pirate-key-v1:"+"A".repeat(42)+"B"])
   assert.throws(()=>decodeRecoveryKey(value));
  let borrowed:Uint8Array|undefined;
  await assert.rejects(withRecoveryKey(encoded,async bytes=>{borrowed=bytes;throw Error("controlled_action_failure");}),/controlled_action_failure/);
  assert(borrowed);assert(borrowed.every(byte=>byte===0));
 }finally{key.fill(0);}
});
test("real encrypted archive authenticates full V2 profile and exact original ledger; no authority is inferred",{timeout:20000},async()=>{
 const temporary=process.env.TMPDIR;assert(temporary,"Root must provide an owned private TMPDIR");
 const root=await mkdtemp(join(temporary,"shared-v2-archive-")),configuration=join(root,"configuration");
 await mkdir(configuration,{mode:0o700});const s=signer(),key=randomBytes(32);
 try{
  const b=body(),ledger=Buffer.from(JSON.stringify(signRecord({originalLinuxInstallationId:b.installationId,
   directoryInstallationId:b.profile.infrastructure.mapping.directoryInstallationId,
   directoryCommunityId:b.profile.identity.communityId,hostingOrigin:b.profile.settings.origin,
   runtimeDocumentSha256:"3".repeat(64),acceptedReaderSourceSha256:"4".repeat(64),
   readerSourceRelativePath:"packages/community/directory-reader.ts",mappingRecordId:b.profile.infrastructure.mapping.mappingId,
   originalNonce:"0001-raw-Case-Preserved"},s.trust,s.key))+"\n");
  const crypto=await import("node:crypto");
  b.profile.infrastructure.mapping.evidence={relativePath:"mapping.json",sha256:crypto.createHash("sha256").update(ledger).digest("hex")};
  b.profileDigest=canonicalDigest(b.profile);const authority=signRecord(b,s.trust,s.key);
  await writeFile(join(configuration,"linux-profile.json"),JSON.stringify(b.profile)+"\n",{mode:0o600,flag:"wx"});
  await writeFile(join(configuration,"profile-authority.json"),JSON.stringify(authority)+"\n",{mode:0o600,flag:"wx"});
  await writeFile(join(configuration,"mapping.json"),ledger,{mode:0o600,flag:"wx"});
  const identity={deploymentId:b.profile.identity.deploymentId,profileSha256:b.profileDigest,
   releaseSha256:b.profile.runtime.artifactDigest.slice(2),backendSha256:"a".repeat(64),
   origin:b.profile.settings.origin,communityId:b.profile.identity.communityId,writerFenceSha256:"b".repeat(64)};
  const snapshot=await captureSnapshot(identity,{configuration}),archive=join(root,"archive.bin");
  const sealed=await sealSnapshot({snapshot,key,output:archive});
  const staging=join(root,"staging");await mkdir(staging,{mode:0o700});
  const actual=await inspectAuthenticatedFullProfile({archive,archiveSha256:sealed.archiveSha256,key,stagingDirectory:staging});
  assert.deepEqual(actual.profile,b.profile);assert.deepEqual(actual.authority,authority);
  assert.equal(actual.producerAuthorityVerified,false); // Actual current authority is NOT mocked/accepted here.
  assert.deepEqual(validateOriginal(actual.authority,s.trust,b.installationId).profile,b.profile);
  assert.equal(actual.manifest.files.find(x=>x.path==="configuration/mapping.json")!.sha256,b.profile.infrastructure.mapping.evidence.sha256);
  const wrong=randomBytes(32);
  try{await assert.rejects(inspectAuthenticatedFullProfile({archive,archiveSha256:sealed.archiveSha256,key:wrong,stagingDirectory:staging}));}
  finally{wrong.fill(0);}
  const damaged=await readFile(archive);damaged[damaged.length-1]=damaged[damaged.length-1]!^1;
  await writeFile(join(root,"damaged.bin"),damaged,{mode:0o600,flag:"wx"});
  await assert.rejects(inspectAuthenticatedFullProfile({archive:join(root,"damaged.bin"),archiveSha256:sealed.archiveSha256,key,stagingDirectory:staging}));
 }finally{s.key.fill(0);key.fill(0);}
 // Root retains the entire owned temporary cohort, raw failures and receipts.
 // This byte/signature test never claims complete service, current namespace,
 // stopped-writer, native/cold-restart or second-host restore acceptance.
});


// This fault is injected only into a genuine lease's audit await. It cannot
// establish host/backend acceptance and never supplies a successful readback.
test("original Directory ledger refuses rename plus replacement across its awaited receipt with zero completion",{timeout:20000},async()=>{
 const temporary=process.env.TMPDIR;assert(temporary,"Root must provide an owned private TMPDIR");
 const root=await mkdtemp(join(temporary,"shared-v2-ledger-race-")),s=signer();
 for(const role of ["configuration","control","destination"])await mkdir(join(root,role),{mode:0o700});
 const installationId=fixtureProfile().infrastructure.mapping.linuxInstallationId;
 const actual=await acquireOperation(join(root,"control"),"raw-ledger-race",installationId,
  {kind:"public-protocol-ledger-race"},await readlink("/proc/self/ns/pid"));
 const destination=join(root,"destination");
 const lease={...actual,async record(phase:string,facts:unknown){
  if(phase==="original-directory-ledger-retained"){
   await rename(destination,destination+".original");await mkdir(destination,{mode:0o700});
   await writeFile(join(destination,"mapping.json"),await readFile(join(root,"configuration","mapping.json")),{mode:0o600,flag:"wx"});
  }
  return actual.record(phase,facts);
 }};
 let completed=0;let reader:Awaited<ReturnType<typeof sharedAuthorityProtocolReader>>|undefined;
 try{
  reader=await sharedAuthorityProtocolReader({root,installationId,trust:s.trust,privateKey:s.key,lease});
  await assert.rejects(async()=>{await reader!.shared.retainOriginal(destination,reader!.profile,lease);completed++;},
   /original_mapping_destination_changed/);
  assert.equal(completed,0);
  assert.deepEqual(await readFile(join(destination+".original","mapping.json")),await readFile(join(root,"configuration","mapping.json")));
 }finally{await reader?.close();s.key.fill(0);}
 // Original and replacement evidence and the real lease remain for Root custody.
});


// Additional P2 regression. Same inode, byte length, permission and parseable
// JSON survive; only the exact byte binding detects the post-audit mutation.
test("original Directory ledger refuses same-inode same-length overwrite during audit with zero completion",{timeout:20000},async()=>{
 const temporary=process.env.TMPDIR;assert(temporary,"Root must provide an owned private TMPDIR");
 const root=await mkdtemp(join(temporary,"shared-v2-ledger-inplace-")),s=signer();
 for(const role of ["configuration","control","destination"])await mkdir(join(root,role),{mode:0o700});
 const installationId=fixtureProfile().infrastructure.mapping.linuxInstallationId;
 const actual=await acquireOperation(join(root,"control"),"raw-ledger-inplace",installationId,
  {kind:"public-protocol-ledger-inplace"},await readlink("/proc/self/ns/pid"));
 const destination=join(root,"destination","mapping.json");
 let observed:{before:Awaited<ReturnType<typeof lstat>>;after:Awaited<ReturnType<typeof lstat>>}|undefined;
 const lease={...actual,async record(phase:string,facts:unknown){
  if(phase==="original-directory-ledger-retained"){
   const before=await lstat(destination),fd=await open(destination,"r+");
   try{await fd.write(Buffer.from(" "),0,1,before.size-1);await fd.sync();}
   finally{await fd.close();}
   const after=await lstat(destination);
   assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);
   assert.equal(after.size,before.size);assert.equal(after.mode,before.mode);assert.equal(after.nlink,1);
   observed={before,after};
  }
  return actual.record(phase,facts);
 }};
 let completed=0;let reader:Awaited<ReturnType<typeof sharedAuthorityProtocolReader>>|undefined;
 try{
  reader=await sharedAuthorityProtocolReader({root,installationId,trust:s.trust,privateKey:s.key,lease});
  await assert.rejects(async()=>{await reader!.shared.retainOriginal(join(root,"destination"),reader!.profile,lease);completed++;},
   /original_mapping_destination_bytes_changed/);
  assert(observed);assert.equal(completed,0);
  const copied=await readFile(destination),original=await readFile(join(root,"configuration","mapping.json"));
  assert.equal(copied.length,original.length);assert.notDeepEqual(copied,original);
  assert.deepEqual(JSON.parse(copied.toString("utf8")),JSON.parse(original.toString("utf8")));
 }finally{await reader?.close();s.key.fill(0);}
 // Original ledger, corrupted destination, real lease and audit evidence remain.
});
