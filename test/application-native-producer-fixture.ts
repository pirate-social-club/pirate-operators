// Real local D1/R2 and owning application/account handlers. Public local test
// signing keys only; no provider/native acceptance, fake DB or seeded completion.
import {Miniflare} from "miniflare";
import {generateKeyPairSync} from "node:crypto";
import {readFile} from "node:fs/promises";
import {privateKeyToAccount} from "viem/accounts";
import {bytesToHex} from "viem";
import {fixtureProfile} from "./linux-shared-native-profile-fixture.ts";
import {migrateOwnerDatabase} from "./owner-publishing-migration-fixture.ts";
import {signRecord,canonicalDigest} from "../deploy/linux/installed-records.ts";
import type {ProfileAdmission,CurrentAdmission} from "../deploy/linux/full-profile-authority.ts";
import {initializeNativeOriginal,nativeCanonical,type NativeOriginal} from "../packages/community/native-business-binding.ts";
import {nativeBusinessTransition} from "../packages/community/native-business-transition.ts";
import {communityFetch,type CommunityEnv,type CommunityDependencies} from "../services/community-application.ts";
import type {CommunityQueueJob} from "../services/community-private-dance.ts";
import {verifyLoginOffline} from "../harness/login-verifier.ts";
import {object,insist,hashText} from "../packages/community/common.ts";
import {validateSharedConfig} from "../packages/community/shared-config-manifest.ts";
import {parseSharedProfileDocument} from "../packages/community/shared-directory.ts";
import {configurationState} from "../packages/community/config-manifest.ts";
import {signNativeReadback,type NativeReadbackRequest} from "../packages/community/native-readback-request.ts";
import {UNREGISTERED_OWNER_POLICY_VERSION,UNREGISTERED_OWNER_POLICY_HASH} from "../packages/community/owner-policy.ts";
import {address} from "../packages/community/manifest-core.ts";

export const nativeMigrationNames=[
  "0001_setup.sql","0002_first_song.sql","0003_publication_journal.sql","0004_creator_connection.sql",
  "0005_input_capabilities.sql","0006_song_stems.sql","0007_owner_curated.sql","0008_karaoke.sql",
  "0009_study.sql","0010_study_retention.sql","0011_manual_rewards.sql","0012_owner_budget_windows.sql",
  "0013_learning_authorization.sql","0014_reward_closure_snapshots.sql","0015_community_media.sql",
  "0016_dance.sql","0017_dance_canonical_controls.sql","0018_learning_authority.sql","0019_community_profiles.sql",
];
export async function nativeProducerFixture(applyNative=true,owner=false){
  const runtime=new Miniflare({name:"native-producer-fixture",modules:true,
    script:"export default {fetch(){return new Response(null,{status:404})}}",compatibilityDate:"2026-08-06",
    d1Databases:["DB"],r2Buckets:["MEDIA"],queueProducers:{JOBS:"native-producer-jobs"},
    serviceBindings:{ASSETS:"native-producer-fixture"}});
  try{
    const bindings=await runtime.getBindings<{DB:D1Database;MEDIA:R2Bucket;JOBS:Queue<CommunityQueueJob>;ASSETS:Fetcher}>();
    const db=bindings.DB;
    await migrateOwnerDatabase(db,nativeMigrationNames.map(n=>"apps/community-wizard/infra/migrations/"+n));
    const draft=await readFile(new URL("../packages/community/native-business.sql",import.meta.url),"utf8");
    const profile=fixtureProfile(),keys=generateKeyPairSync("ed25519");
    const controller=privateKeyToAccount(bytesToHex(new Uint8Array(32).fill(19)));
    if(owner){
      profile.infrastructure.configuration.controller=address(controller.address.toLowerCase());
      profile.infrastructure.configuration.policies.admission={version:UNREGISTERED_OWNER_POLICY_VERSION,sha256:UNREGISTERED_OWNER_POLICY_HASH};
    }
    const trust={keyId:"public-native-fixture",spki:keys.publicKey.export({format:"der",type:"spki"}).toString("base64")};
    const now=Date.now(),body:ProfileAdmission={installationId:profile.infrastructure.mapping.linuxInstallationId,
      requestId:"fixture-original-request",recordId:"fixture-original-record",generation:1,issuedAt:now-1000,expiresAt:now+60000,
      profile,profileDigest:canonicalDigest(profile),outcome:"authorized-profile"};
    const fixtureRelease={schema:"pirate.complete-linux-release/1" as const,sourceDigest:profile.runtime.sourceDigest,artifactDigest:profile.runtime.artifactDigest,
      graph:{installationId:body.installationId,durableScope:"a".repeat(64)}};
    // Only a public signature/control-record fixture; never passed to the real
    // installed-release verifier as a complete release or a host/readiness proof.
    const original:NativeOriginal={schema:"pirate.native-application-original/1",record:signRecord(body,trust,
      keys.privateKey.export({format:"der",type:"pkcs8"})),release:signRecord(fixtureRelease,trust,
      keys.privateKey.export({format:"der",type:"pkcs8"})),trust,durableScope:"a".repeat(64)};
    const raw=nativeCanonical(original),readbackKey="42".repeat(32);
    const currentBody:CurrentAdmission={installationId:body.installationId,generation:1,issuedAt:now-1000,expiresAt:now+60000,
      profileDigests:[body.profileDigest],revokedRecordIds:[],hostFingerprint:"public-fixture-host",resourceIdentity:profile.identity};
    const current=signRecord(currentBody,trust,keys.privateKey.export({format:"der",type:"pkcs8"}));
    const currentApproval=(change:Partial<CurrentAdmission>={})=>signRecord({...currentBody,...change},trust,
      keys.privateKey.export({format:"der",type:"pkcs8"}));
    if(applyNative){await db.batch(nativeBusinessTransition(db,draft));await initializeNativeOriginal(db,raw);}
    const env:CommunityEnv={...bindings,COMMUNITY_NAME:profile.settings.name,PLAN_ID:"b".repeat(64),
      APPLICATION_PROFILE_HASH:"0x"+"a".repeat(64),MANAGED_PROFILE_HASH:"0x"+"c".repeat(64),
      COMMUNITY_PUBLISHER_PRIVATE_KEY:"0x"+"12".repeat(32),
      NATIVE_APPLICATION_ORIGINAL_JSON:raw,NATIVE_READBACK_KEY:readbackKey,
      COMMUNITY_DEPLOYMENT_PROFILE_JSON:JSON.stringify({schema:"pirate.community-deployment/1",
        origin:profile.settings.origin,name:profile.settings.name,planId:"b".repeat(64),postingPeriod:"native-fixture",
        rpcUrl:"http://127.0.0.1:1",ipfsGateways:["https://gateway.pinata.cloud"],
        managedOrigin:"https://managed.fixture.example",creatorOrigin:"https://creator.fixture.example",
        directoryProfile:profile.infrastructure.directory,
        posts:{address:profile.infrastructure.configuration.postsContract,runtimeCodeHash:"0x"+"c".repeat(64),deploymentBlock:"1"}})};
    // The external Directory transport is controlled here; its real closed
    // profile/configuration decoder runs on every read, not a health boolean.
    const configuration=async()=>validateSharedConfig(profile.infrastructure.configuration,
      parseSharedProfileDocument(profile.infrastructure.directory),configurationState(),1n);
    const ports:CommunityDependencies={configuration,freshConfiguration:configuration,verifyLogin:verifyLoginOffline,
      creatorHealth:async()=>{throw Error("unexpected_external_health_call");}};
    const call=(path:string,init:RequestInit={})=>communityFetch(new Request(profile.settings.origin+path,init),env,ports);
    const post=(path:string,value:unknown,headers:Record<string,string>={})=>call(path,{method:"POST",
      headers:{Origin:profile.settings.origin,"Content-Type":"application/json",...headers},body:JSON.stringify(value)});
    const wallet=privateKeyToAccount(bytesToHex(new Uint8Array(32).fill(17)));
    const challenge=async()=>{
      const response=await post("/api/auth/challenge",{address:wallet.address});insist(response.ok,"fixture_challenge_failed");
      const value=object(await response.json());insist(typeof value.id==="string"&&typeof value.message==="string","fixture_challenge_shape");
      const signature=await wallet.signMessage({message:value.message});return{id:value.id,message:value.message,signature};
    };
    const login=async()=>{
      const c=await challenge(),verified=await post("/api/auth/verify",{id:c.id,signature:c.signature});
      insist(verified.ok,"fixture_verify_failed");const cookie=verified.headers.get("Set-Cookie")?.split(";")[0];
      insist(cookie,"fixture_cookie_missing");return{...c,cookie};
    };
    const signed=async(cookie:string,change:Partial<NativeReadbackRequest>={})=>{
      const issuedAt=Date.now();const scope:NativeReadbackRequest={version:1,role:"application",nonce:crypto.randomUUID().replaceAll("-","")+crypto.randomUUID().replaceAll("-",""),
        issuedAt,expiresAt:issuedAt+15000,installationId:body.installationId,profileDigest:body.profileDigest,generation:1,
        resourceId:profile.identity.resources.application!,method:"GET",path:"/api/session",cookieHash:hashText(cookie),current,...change};
      return{Cookie:cookie,...await signNativeReadback(scope,readbackKey)};
    };
    return{runtime,db,draft,env,ports,profile,original,controller,wallet,currentApproval,readbackKey,call,post,challenge,login,signed,dispose:()=>runtime.dispose()};
  }catch(error){await runtime.dispose();throw error;}
}
