// ALL UNRUN. No provider, namespace, native startup or release acceptance follows.
import test from "node:test";
import assert from "node:assert/strict";
import {object,hashText,hashJson} from "../packages/community/common.ts";
import {nativeProducerFixture} from "./application-native-producer-fixture.ts";
import {nativeBusinessTransition} from "../packages/community/native-business-transition.ts";
import {nativeOriginal} from "../packages/community/native-business-binding.ts";
import {communityFetch} from "../services/community-application.ts";
import {MediaRepository} from "../packages/community-media/repository.ts";
import {MEDIA_VERSION,type MediaRecord} from "../packages/community-media/contracts.ts";
import {accountSession} from "../packages/community/accounts.ts";
import {nativeLearningFences} from "../packages/community/native-business-fences.ts";
import {reserveOwnerSubmission} from "../packages/community/submissions.ts";
import {validateOwnerAuthorization} from "../packages/community/owner-authorization.ts";
import {UNREGISTERED_OWNER_POLICY_VERSION} from "../packages/community/owner-policy.ts";

type RuntimeSchemaRow={type:string;name:string;tbl_name:string;sql:string|null};
const runtimeMetadataSql = "CREATE TABLE _cf_METADATA (\n        key INTEGER PRIMARY KEY,\n        value BLOB\n      )";
function attestRuntimeMetadata(schema:readonly RuntimeSchemaRow[]){
  const metadata=schema.filter(entry=>entry.name.toLowerCase()==='_cf_metadata');
  assert.deepEqual(metadata,metadata.length===0?[]:[{
    type:'table',name:'_cf_METADATA',tbl_name:'_cf_METADATA',sql:runtimeMetadataSql,
  }]);
  return metadata;
}
async function runtimeMetadata(database:D1Database){
  const schema=(await database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE lower(name)='_cf_metadata'").all<RuntimeSchemaRow>()).results;
  return attestRuntimeMetadata(schema);
}
function mismatchedMetadataPin(draft:string){
  const literal="'"+runtimeMetadataSql.replaceAll("'","''")+"'";
  assert.equal(draft.split(literal).length,2,"one exact metadata pin required");
  const changed=literal.replace('value BLOB','value TEXT');
  assert.notEqual(changed,literal);
  return draft.replace(literal,changed);
}

async function nativeDatabaseImage(database:D1Database){
  const schema=(await database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all<RuntimeSchemaRow>()).results;
  attestRuntimeMetadata(schema);
  const tables=await Promise.all(schema.filter(entry=>entry.type==='table'&&!entry.name.startsWith('sqlite_')&&entry.name!=='_cf_METADATA').map(async entry=>{
    const name='"'+entry.name.replaceAll('"','""')+'"';
    return {name:entry.name,rows:(await database.prepare("SELECT rowid AS retained_rowid,* FROM "+name+" ORDER BY rowid").all()).results};
  }));
  return {schema,tables};
}

async function ownerUpload(f:Awaited<ReturnType<typeof nativeProducerFixture>>){
 const login=await f.login(),config=f.profile.infrastructure.configuration;
 const session=await accountSession(new Request(config.app.origin+"/api/session",{headers:{Cookie:login.cookie}}),f.db,
   {communityId:config.communityId,origin:config.app.origin});
 const seconds=Math.floor(Date.now()/1000),authorization={schema:"pirate.owner-publishing-authorization/1",
   communityId:config.communityId,ownerWallet:f.wallet.address.toLowerCase(),policy:config.policies.admission,
   validFrom:seconds-10,expiresAt:seconds+60};
 const signed=await validateOwnerAuthorization({authorization,signature:await f.controller.signMessage({message:{raw:hashJson(authorization)}})},config);
 const bytes=new TextEncoder().encode("public bounded upload fixture"),requestId="native-owner-upload-original";
 const row=await reserveOwnerSubmission(f.db,session,{chainId:config.chainId,communityId:config.communityId,
   postsContract:config.postsContract,configurationRevision:config.configurationRevision,publisher:config.publisher,
   moderationSigner:config.policies.moderationSigner},signed.authorization,{title:"Native upload",language:"en",lyrics:"Fixture lyrics",
   original:true,acceptedPolicy:UNREGISTERED_OWNER_POLICY_VERSION,rating:"general",audioSha256:hashText("public bounded upload fixture"),audioBytes:bytes.length},requestId);
 return{login,session,row,requestId,bytes};
}

test("owner media upload readback joins real reservation, checksum-validated R2 and original request across restart",async()=>{
 const f=await nativeProducerFixture(true,true);try{
  const upload=await ownerUpload(f),id=upload.row.submission_id,path="/api/uploads/"+id;
  const uploaded=await f.call(path+"/audio",{method:"PUT",headers:{Cookie:upload.login.cookie,Origin:f.profile.settings.origin,
    "X-CSRF-Token":upload.session.csrf_token,"Content-Type":"audio/mpeg"},body:upload.bytes});
  assert.equal(uploaded.status,200);
  const headers=await f.signed(upload.login.cookie,{role:"media",path,resourceId:f.profile.identity.resources.privateData!});
  const response=await communityFetch(new Request(f.profile.settings.origin+path,{headers}),{...f.env},{...f.ports});
  assert.equal(response.status,200);const proof=object(object(await response.json()).nativeReadback);
  assert.equal(proof.requestId,upload.requestId);assert.equal(proof.outcome,"uploaded");
  const retained=await f.db.prepare("SELECT request_id,proof_json FROM native_business_bindings WHERE kind='submission'").first<{request_id:string;proof_json:string}>();
  assert.equal(retained?.request_id,upload.requestId);assert.equal(JSON.parse(retained!.proof_json).requestHash,upload.row.request_hash);
 }finally{await f.dispose();}
});
test("authenticated media readback refuses another account's real reservation without accepting a body identity",async()=>{
 const f=await nativeProducerFixture(true,true);try{
  const upload=await ownerUpload(f);await f.db.prepare("DELETE FROM community_sessions").run();
  const other=await f.login();
  // Rotate the credential owner in the real database so this control does not
  // rely on an untrusted account header or a fabricated successful readback.
  const otherAccount=crypto.randomUUID();
  await f.db.batch([f.db.prepare("INSERT INTO community_accounts(account_id,author_id,created_at) VALUES(?,?,?)").bind(otherAccount,crypto.randomUUID(),Date.now()),
    f.db.prepare("UPDATE credential_bindings SET account_id=? WHERE binding_id=(SELECT binding_id FROM community_sessions)").bind(otherAccount),
    f.db.prepare("UPDATE community_sessions SET account_id=?").bind(otherAccount)]);
  const path="/api/uploads/"+upload.row.submission_id;
  const response=await f.call(path,{headers:await f.signed(other.cookie,{role:"media",path,resourceId:f.profile.identity.resources.privateData!})});
  assert.equal(response.status,404);assert.equal((await f.db.prepare("SELECT * FROM native_readback_nonces").all()).results.length,0);
 }finally{await f.dispose();}
});
test("missing real R2 object cannot yield uploaded media proof or spend readback nonce",async()=>{
 const f=await nativeProducerFixture(true,true);try{
  const upload=await ownerUpload(f),path="/api/uploads/"+upload.row.submission_id;
  assert.equal((await f.call(path+"/audio",{method:"PUT",headers:{Cookie:upload.login.cookie,Origin:f.profile.settings.origin,
    "X-CSRF-Token":upload.session.csrf_token,"Content-Type":"audio/mpeg"},body:upload.bytes})).status,200);
  const row=await f.db.prepare("SELECT object_key FROM media_submissions WHERE submission_id=?").bind(upload.row.submission_id).first<{object_key:string}>();
  await f.env.MEDIA.delete(row!.object_key);
  assert.equal((await f.call(path,{headers:await f.signed(upload.login.cookie,{role:"media",path,resourceId:f.profile.identity.resources.privateData!})})).status,409);
  assert.equal((await f.db.prepare("SELECT * FROM native_readback_nonces").all()).results.length,0);
 }finally{await f.dispose();}
});
test("object-key change after real R2 read invalidates the final primary upload snapshot",async()=>{
 const f=await nativeProducerFixture(true,true);try{
  const upload=await ownerUpload(f),path="/api/uploads/"+upload.row.submission_id;
  assert.equal((await f.call(path+"/audio",{method:"PUT",headers:{Cookie:upload.login.cookie,Origin:f.profile.settings.origin,
    "X-CSRF-Token":upload.session.csrf_token,"Content-Type":"audio/mpeg"},body:upload.bytes})).status,200);
  const fresh=f.ports.freshConfiguration!;let reads=0;
  f.ports.freshConfiguration=async()=>{
    const config=await fresh();
    if(++reads===2)await f.db.prepare("UPDATE media_submissions SET object_key=? WHERE submission_id=?")
      .bind("staging/changed-after-head/"+crypto.randomUUID(),upload.row.submission_id).run();
    return config;
  };
  const headers=await f.signed(upload.login.cookie,{role:"media",path,resourceId:f.profile.identity.resources.privateData!});
  await assert.rejects(f.call(path,{headers}),/CHECK constraint failed/);
  assert.equal((await f.db.prepare("SELECT * FROM native_readback_nonces").all()).results.length,0);
 }finally{await f.dispose();}
});
test("native capture failure rolls back owner reservation and retains quota/history",async()=>{
 const f=await nativeProducerFixture(true,true);try{
  await f.db.prepare("CREATE TRIGGER failed_submission_capture BEFORE INSERT ON native_business_bindings WHEN NEW.kind='submission' BEGIN SELECT RAISE(ABORT,'submission_capture_boundary'); END").run();
  await assert.rejects(ownerUpload(f),/submission_capture_boundary/);
  assert.equal((await f.db.prepare("SELECT * FROM media_submissions").all()).results.length,0);
  assert.equal((await f.db.prepare("SELECT * FROM native_business_bindings WHERE kind='session'").all()).results.length,1);
 }finally{await f.dispose();}
});
test("native transition refuses changed affected parent schema and preserves its column/data",async()=>{
 const f=await nativeProducerFixture(false);try{
  await f.db.prepare("ALTER TABLE media_submissions ADD COLUMN retained_custom TEXT").run();
  const before=(await f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all()).results;
  await assert.rejects(f.db.batch(nativeBusinessTransition(f.db,f.draft)),/native_business_schema_refusal/);
  assert.deepEqual((await f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all()).results,before);
 }finally{await f.dispose();}
});

test("native session readback joins real signed login and survives application restart",async()=>{
 const f=await nativeProducerFixture();try{
  const login=await f.login(),headers=await f.signed(login.cookie);
  const response=await f.call("/api/session",{headers});assert.equal(response.status,200);
  const saved=object(object(await response.json()).nativeReadback);
  assert.equal(saved.requestId,login.id);assert.equal(saved.outcome,"authenticated");
  assert.equal(saved.installationId,f.original.record.body.installationId);
  assert.equal(saved.profileDigest,f.original.record.body.profileDigest);assert.equal(saved.generation,1);
  assert.equal(saved.resourceId,f.profile.identity.resources.application);
  const row=await f.db.prepare("SELECT request_id,proof_json FROM native_business_bindings WHERE kind='session'").first<{request_id:string;proof_json:string}>();
  assert.equal(row?.request_id,login.id);assert.deepEqual(JSON.parse(row!.proof_json),{message:login.message,signature:login.signature.toLowerCase()});
  const next=await communityFetch(new Request(f.profile.settings.origin+"/api/session",{headers:await f.signed(login.cookie)}),{...f.env},{...f.ports});
  assert.equal(next.status,200);assert.deepEqual(object(object(await next.json()).nativeReadback),saved);
 }finally{await f.dispose();}
});
test("ordinary authenticated response never echoes native identity from client headers or query",async()=>{
 const f=await nativeProducerFixture();try{
  const login=await f.login(),response=await f.call("/api/session?installationId=forged&generation=9",{headers:{Cookie:login.cookie,"X-Pirate-Request-ID":"forged"}});
  const body=object(await response.json());assert.equal(response.status,200);assert.ok(!("nativeReadback" in body));assert.ok(!("accountId" in body));
 }finally{await f.dispose();}
});
for(const field of ["installationId","resourceId","profileDigest","generation"] as const)test("native managed request refuses mismatched "+field,async()=>{
 const f=await nativeProducerFixture();try{
  const login=await f.login();const change=field==="generation"?{generation:2}:{[field]:"wrong-original"};
  const response=await f.call("/api/session",{headers:await f.signed(login.cookie,change)});assert.equal(response.status,403);
  assert.equal((await f.db.prepare("SELECT nonce FROM native_readback_nonces").all()).results.length,0);
 }finally{await f.dispose();}
});
test("native request refuses wrong MAC and expired scope before consuming a nonce",async()=>{
 const f=await nativeProducerFixture();try{
  const login=await f.login(),bad={...await f.signed(login.cookie),"X-Pirate-Native-Mac":"00".repeat(32)};
  assert.equal((await f.call("/api/session",{headers:bad})).status,403);
  assert.equal((await f.call("/api/session",{headers:await f.signed(login.cookie,{issuedAt:Date.now()-20000,expiresAt:Date.now()-1000})})).status,403);
 }finally{await f.dispose();}
});
test("native nonce replay remains refused after restarting the owning handler",async()=>{
 const f=await nativeProducerFixture();try{
  const login=await f.login(),headers=await f.signed(login.cookie);assert.equal((await f.call("/api/session",{headers})).status,200);
  await assert.rejects(communityFetch(new Request(f.profile.settings.origin+"/api/session",{headers}),{...f.env},{...f.ports}));
  assert.equal((await f.db.prepare("SELECT nonce FROM native_readback_nonces").all()).results.length,1);
 }finally{await f.dispose();}
});
test("session revocation after request authentication cannot produce a native result",async()=>{
 const f=await nativeProducerFixture();try{
   const login=await f.login(),headers=await f.signed(login.cookie),fresh=f.ports.freshConfiguration!;
   let reads=0;
   f.ports.freshConfiguration=async()=>{
     const config=await fresh();
     if(++reads===2)await f.db.prepare("DELETE FROM community_sessions").run();
     return config;
   };
  assert.equal((await f.call("/api/session",{headers})).status,401);
  assert.equal((await f.db.prepare("SELECT nonce FROM native_readback_nonces").all()).results.length,0);
 }finally{await f.dispose();}
});
test("changed current Directory selection refuses the original profile",async()=>{
 const f=await nativeProducerFixture();try{
  const login=await f.login(),headers=await f.signed(login.cookie);
  f.ports.freshConfiguration=async()=>({...f.profile.infrastructure.configuration,publisher:"0x1111111111111111111111111111111111111111"});
  assert.equal((await f.call("/api/session",{headers})).status,409);
 }finally{await f.dispose();}
});
test("failed native capture rolls back the actual login transaction and preserves challenge",async()=>{
 const f=await nativeProducerFixture();try{
  const challenge=await f.challenge();await f.db.prepare("CREATE TRIGGER injected_native_capture_failure BEFORE INSERT ON native_business_bindings BEGIN SELECT RAISE(ABORT,'capture_boundary'); END").run();
   const refused=await f.post("/api/auth/verify",{id:challenge.id,signature:challenge.signature});
   assert.equal(refused.status,503);assert.equal(object(await refused.json()).error,"community_service_unavailable");
  assert.equal((await f.db.prepare("SELECT consumed FROM login_challenges WHERE challenge_id=?").bind(challenge.id).first<{consumed:number}>())?.consumed,0);
  for(const table of ["community_sessions","community_accounts","credential_bindings","native_business_bindings"])
    assert.equal((await f.db.prepare("SELECT * FROM "+table).all()).results.length,0);
 }finally{await f.dispose();}
});
for(const kind of ["object","incoming","trigger","view"] as const)test("additive native schema refuses unknown "+kind+" atomically",async()=>{
 const f=await nativeProducerFixture(false);try{
  const unexpected={object:"CREATE TABLE native_readback_nonces(retained TEXT)",
    incoming:"CREATE TABLE custom_incoming(id TEXT REFERENCES native_application_original(original_digest))",
    trigger:"CREATE TRIGGER unknown_future_native AFTER INSERT ON community_accounts BEGIN INSERT INTO native_readback_nonces VALUES('not-a-real-request',0); END",
    view:"CREATE VIEW unknown_native_view AS SELECT * FROM native_application_original"};
  await f.db.prepare(unexpected[kind]).run();
  const before=(await f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all()).results;
  await assert.rejects(f.db.batch(nativeBusinessTransition(f.db,f.draft)),/native_business_schema_refusal/);
  assert.deepEqual((await f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all()).results,before);
 }finally{await f.dispose();}
});
test("native additive transition rolls back DDL after staged tables without changing old data",async()=>{
 const f=await nativeProducerFixture(false);try{
  await f.db.prepare("INSERT INTO community_accounts VALUES('retained','0x1234',1)").run();
  const before=(await f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all()).results;
  const statements=nativeBusinessTransition(f.db,f.draft);
   await assert.rejects(f.db.batch([...statements.slice(0,8),f.db.prepare("INSERT INTO native_application_transition_guard VALUES(0)"),...statements.slice(8)]),/native_business_schema_refusal/);
  assert.deepEqual((await f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all()).results,before);
  assert.equal((await f.db.prepare("SELECT account_id FROM community_accounts").first<{account_id:string}>())?.account_id,"retained");
 }finally{await f.dispose();}
});
test("additive native schema retains original parent indexes and populated rowids",async()=>{
 const f=await nativeProducerFixture(false);try{
  await f.db.prepare("CREATE INDEX retained_account_created ON community_accounts(created_at)").run();
  await f.db.prepare("INSERT INTO community_accounts(rowid,account_id,author_id,created_at) VALUES(91,'retained','retained-author',1)").run();
  const schema=(await f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all()).results;
  const rows=(await f.db.prepare("SELECT rowid,* FROM community_accounts ORDER BY rowid").all()).results;
  const beforeRuntimeMetadata=await runtimeMetadata(f.db);
  await f.db.batch(nativeBusinessTransition(f.db,f.draft));
  const after=(await f.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all()).results;
  for(const entry of schema)assert.ok(after.some(candidate=>JSON.stringify(candidate)===JSON.stringify(entry)));
  assert.deepEqual(await runtimeMetadata(f.db),beforeRuntimeMetadata);
  assert.deepEqual((await f.db.prepare("SELECT rowid,* FROM community_accounts ORDER BY rowid").all()).results,rows);
  assert.equal((await f.db.prepare("PRAGMA foreign_key_check").all()).results.length,0);
 }finally{await f.dispose();}
});
test("native original verification refuses signature/body substitution",async()=>{
 const f=await nativeProducerFixture();try{
  const changed=structuredClone(f.original);changed.record.body.generation++;
  await assert.rejects(nativeOriginal(JSON.stringify(changed)),/native_original_signature/);
 }finally{await f.dispose();}
});
test("actual pending media reservation captures scope once without resetting exhausted quota",async()=>{
 const f=await nativeProducerFixture();try{
  const login=await f.login(),origin=f.profile.settings.origin;
  const session=await accountSession(new Request(origin+"/api/session",{headers:{Cookie:login.cookie}}),f.db,
    {communityId:f.profile.infrastructure.configuration.communityId,origin});
  const now=Date.now(),record:MediaRecord={version:MEDIA_VERSION,id:crypto.randomUUID(),requestId:"native-media-original-request",
    revision:1,state:"uploading",purpose:"private-review",publicConsent:false,communityId:f.profile.identity.communityId,
    accountId:session.account_id,songKey:"component-fixture-song",songRevision:1,audioSha256:"a".repeat(64),
    recordingSha256:"b".repeat(64),sourceBytes:1,startSample:0,durationSamples:288000,mediaPolicyVersion:"pirate.dance-private/1",
    createdAt:now,uploadExpiresAt:now+60000,expiresAt:now+60000,attempts:0};
  const repository=new MediaRepository(f.db,record.communityId),quota={perAccount:1,perCommunity:1,bytesPerCommunity:1};
  assert.equal((await repository.reserve(record,quota)).state,"uploading");
  const first=(await f.db.prepare("SELECT rowid,* FROM native_business_bindings WHERE kind='media'").all()).results;
  assert.equal(first.length,1);
  await assert.rejects(repository.reserve({...record,id:crypto.randomUUID(),requestId:"new-request"},quota),/media_capacity_full/);
  await repository.reserve(record,quota);
  assert.deepEqual((await f.db.prepare("SELECT rowid,* FROM native_business_bindings WHERE kind='media'").all()).results,first);
  assert.equal((await repository.get(record.id)).state,"uploading"); // No ready/completed fixture row.
 }finally{await f.dispose();}
});
test("learning authority change during an await invalidates final primary fence",async()=>{
 const f=await nativeProducerFixture();try{
  const login=await f.login(),session=await accountSession(new Request(f.profile.settings.origin+"/api/session",{headers:{Cookie:login.cookie}}),f.db,
    {communityId:f.profile.infrastructure.configuration.communityId,origin:f.profile.settings.origin});
  const fences=await nativeLearningFences(f.db,session.account_id);
  // The actual authority dirty table is changed at the asynchronous boundary;
  // neither its absence nor an old revision may continue to authorize readback.
  await f.db.prepare("INSERT INTO learning_authority_dirty(account_id,updated_at,version) VALUES(?,0,1)").bind(session.account_id).run();
  const query="SELECT 1 AS valid WHERE "+fences.map(f=>"("+f.sql+")").join(" AND ");
  assert.equal(await f.db.withSession("first-primary").prepare(query).bind(...fences.flatMap(f=>f.values)).first(),null);
 }finally{await f.dispose();}
});
test("fresh signed current generation does not rewrite original business scope or history",async()=>{
 const f=await nativeProducerFixture();try{
  const login=await f.login(),before=(await f.db.prepare("SELECT rowid,* FROM native_business_bindings").all()).results;
  const headers=await f.signed(login.cookie,{generation:2,current:f.currentApproval({generation:2})});
  const response=await f.call("/api/session",{headers});assert.equal(response.status,200);
  assert.equal(object(object(await response.json()).nativeReadback).generation,2);
  assert.equal((await f.db.prepare("SELECT generation FROM native_readback_nonces").first<{generation:number}>())?.generation,2);
  assert.deepEqual((await f.db.prepare("SELECT rowid,* FROM native_business_bindings").all()).results,before);
 }finally{await f.dispose();}
});
for(const kind of ["revoked","stale","resource","signer"] as const)test("native readback refuses signed current authority "+kind,async()=>{
 const f=await nativeProducerFixture();let other:Awaited<ReturnType<typeof nativeProducerFixture>>|undefined;
 try{
  const login=await f.login();
  if(kind==="signer")other=await nativeProducerFixture();
  const current=kind==="revoked"?f.currentApproval({revokedRecordIds:[f.original.record.body.recordId]}):
    kind==="stale"?f.currentApproval({issuedAt:Date.now()-20000,expiresAt:Date.now()-1000}):
    kind==="resource"?f.currentApproval({resourceIdentity:{...f.profile.identity,resources:{...f.profile.identity.resources,application:"foreign-resource"}}}):
    other!.currentApproval();
  assert.equal((await f.call("/api/session",{headers:await f.signed(login.cookie,{current})})).status,403);
  assert.equal((await f.db.prepare("SELECT nonce FROM native_readback_nonces").all()).results.length,0);
 }finally{await other?.dispose();await f.dispose();}
});

test('native metadata schema pin mismatch rolls back schema and actual account session submission history',async()=>{
  const f=await nativeProducerFixture(false,true);
  try{
    const upload=await ownerUpload(f);
    const metadata=await runtimeMetadata(f.db);
    assert.equal(metadata.length,1,'retained D1 fixture must expose its actual metadata schema');
    const before=await nativeDatabaseImage(f.db);
    const transition=nativeBusinessTransition(f.db,mismatchedMetadataPin(f.draft));
    await assert.rejects(f.db.batch([
      f.db.prepare("INSERT INTO transaction_guards VALUES('native-metadata-refusal-marker',1)"),
      f.db.prepare("UPDATE community_accounts SET created_at=created_at+1 WHERE account_id=?").bind(upload.session.account_id),
      ...transition,
    ]),/native_business_schema_refusal/);
    assert.deepEqual(await nativeDatabaseImage(f.db),before);
    assert.deepEqual(await runtimeMetadata(f.db),metadata);
    assert.equal((await f.db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
    assert.equal((await f.db.prepare("SELECT name FROM sqlite_schema WHERE name='native_application_transition_guard' OR name IN ('native_application_original','native_business_bindings','native_readback_nonces','native_binding_guards')").all()).results.length,0);
  }finally{await f.dispose();}
});
