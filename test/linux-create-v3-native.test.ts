// UNRUN. Real D1 native initializer and application/account handlers, public
// local test signatures. Not a full Linux process/restart/provider acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {nativeProducerFixture} from "./application-native-producer-fixture.ts";
import {createProfileFixture} from "./linux-create-v3-fixture.ts";
import {nativeOriginal,nativeCurrent,initializeNativeOriginal,nativeCanonical,type NativeOriginal} from "../packages/community/native-business-binding.ts";
import {nativeBusinessTransition} from "../packages/community/native-business-transition.ts";
import {signRecord,canonicalDigest} from "../deploy/linux/installed-records.ts";
import {communityFetch} from "../services/community-application.ts";

function originalFixture(){
  const profile=createProfileFixture(),pair=generateKeyPairSync("ed25519"),key=pair.privateKey.export({format:"der",type:"pkcs8"}),now=Date.now();
  const trust={keyId:"public-v3-native-test",spki:pair.publicKey.export({format:"der",type:"spki"}).toString("base64")};
  const body={installationId:profile.infrastructure.mapping.linuxInstallationId,requestId:"original-create-v3",recordId:"original-profile-v3",
    generation:1,issuedAt:now-1000,expiresAt:now+60000,profile,profileDigest:canonicalDigest(profile),outcome:"authorized-profile" as const};
  // Signature-format fixture only, never supplied to verifyInstalledRelease as
  // a genuine complete native release or a source/readiness attestation.
  const release={schema:"pirate.complete-linux-release/1" as const,sourceDigest:profile.runtime.sourceDigest,artifactDigest:profile.runtime.artifactDigest,
    graph:{installationId:body.installationId,durableScope:"a".repeat(64)}};
  const original:NativeOriginal={schema:"pirate.native-application-original/1",record:signRecord(body,trust,key),
    release:signRecord(release,trust,key),trust,durableScope:"a".repeat(64)};
  return {profile,key,trust,body,original,raw:nativeCanonical(original)};
}
test("genuine V3 native initializer stores exact signed original and repeated initialization preserves rows",async()=>{
  const f=await nativeProducerFixture(false),v3=originalFixture();
  try{
    await f.db.batch(nativeBusinessTransition(f.db,f.draft));
    assert.deepEqual(await nativeOriginal(v3.raw),v3.original);
    const digest=await initializeNativeOriginal(f.db,v3.raw);
    const before=await f.db.prepare("SELECT * FROM native_application_original").all();
    const identity=await f.db.prepare("SELECT * FROM application_identity").all();
    assert.equal(before.results.length,1);assert.equal(before.results[0]!.original_digest,digest);
    assert.equal(before.results[0]!.original_json,v3.raw);
    // Reopened consumer over the SAME durable DB; no completion/resource rows
    // are seeded. The actual initializer and exact original run again.
    assert.equal(await initializeNativeOriginal(f.db,v3.raw),digest);
    assert.deepEqual((await f.db.prepare("SELECT * FROM native_application_original").all()).results,before.results);
    assert.deepEqual((await f.db.prepare("SELECT * FROM application_identity").all()).results,identity.results);
    assert(!Object.hasOwn(v3.profile.settings,"recovery"));assert(!Object.hasOwn(v3.profile.settings.storage,"backup"));
  }finally{v3.key.fill(0);await f.dispose();}
});
test("V3 native application login survives handler recreation with original identity and no second installation",async()=>{
  const f=await nativeProducerFixture(false),v3=originalFixture();
  try{
    await f.db.batch(nativeBusinessTransition(f.db,f.draft));await initializeNativeOriginal(f.db,v3.raw);
    f.env.NATIVE_APPLICATION_ORIGINAL_JSON=v3.raw;
    const login=await f.login();
    const accounts=(await f.db.prepare("SELECT * FROM community_accounts").all()).results;
    const retained=(await f.db.prepare("SELECT * FROM native_application_original").all()).results;
    const response=await communityFetch(new Request(v3.profile.settings.origin+"/api/session",{headers:{Cookie:login.cookie}}),{...f.env},{...f.ports});
    assert.equal(response.status,200);
    await initializeNativeOriginal(f.db,v3.raw);
    assert.deepEqual((await f.db.prepare("SELECT * FROM community_accounts").all()).results,accounts);
    assert.deepEqual((await f.db.prepare("SELECT * FROM native_application_original").all()).results,retained);
    assert.equal((await f.db.prepare("SELECT * FROM native_business_bindings WHERE kind='session'").all()).results.length,1);
  }finally{v3.key.fill(0);await f.dispose();}
});
test("native V3 conflicting second signed original refuses atomically without replacing first identity",async()=>{
  const f=await nativeProducerFixture(false),v3=originalFixture();
  try{
    await f.db.batch(nativeBusinessTransition(f.db,f.draft));await initializeNativeOriginal(f.db,v3.raw);
    const before=(await f.db.prepare("SELECT * FROM native_application_original").all()).results;
    const changed={...v3.original,record:signRecord({...v3.body,requestId:"replacement-request",recordId:"replacement-record"},v3.trust,v3.key)};
    await assert.rejects(initializeNativeOriginal(f.db,nativeCanonical(changed)));
    assert.deepEqual((await f.db.prepare("SELECT * FROM native_application_original").all()).results,before);
  }finally{v3.key.fill(0);await f.dispose();}
});
test("native current approval for V2 digest cannot authorize V3 even with same original resource IDs",async()=>{
  const v3=originalFixture(),f=await nativeProducerFixture(false);
  try{
    const now=Date.now(),policy={installationId:v3.body.installationId,generation:1,issuedAt:now-1000,expiresAt:now+60000,
      profileDigests:[canonicalDigest(f.profile)],revokedRecordIds:[],hostFingerprint:"fixture-host",resourceIdentity:v3.profile.identity};
    await assert.rejects(nativeCurrent(signRecord(policy,v3.trust,v3.key),v3.original),/native_current_authority_changed/);
    assert.equal((await nativeCurrent(signRecord({...policy,profileDigests:[v3.body.profileDigest]},v3.trust,v3.key),v3.original)).profileDigests[0],v3.body.profileDigest);
    const changed=structuredClone(v3.original);changed.record.body.profile.settings.slug="changed-slug";
    await assert.rejects(nativeOriginal(nativeCanonical(changed)),/native_original_signature/);
  }finally{v3.key.fill(0);await f.dispose();}
});
