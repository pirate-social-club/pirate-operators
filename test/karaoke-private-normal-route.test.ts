// Actual SQLite/operator/signatures; media/ASR facts here are explicit fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {accounts,keys} from "../harness/runtime.ts";
import {fixtureManifest} from "../harness/karaoke-fixture.ts";
import {digest,sign,type Ticket,type Song,type Signed} from "../packages/protocol/index.ts";
import {quoteIdOf} from "../packages/protocol/payments.ts";
import {operatorQuote} from "../services/purchases.ts";
import {karaokeRoute,tick} from "../services/karaoke.ts";
import {privateKaraokeScope} from "../services/karaoke-private-profile.ts";
import {speechRepairFixture} from "./karaoke-admission-repair1-fixture.ts";
import type {Env,Store} from "../services/runtime.ts";
import type {Attempt} from "../services/karaoke-result.ts";

function fixture() {
 const f=speechRepairFixture();const profile={schema:"pirate.study-private-runtime/5",version:5,chainId:6343,
  communityId:f.policy.communityId,sourceChainId:6343,contract:accounts[0].address.toLowerCase(),
  releaseHash:digest("private Karaoke fixture release"),speechPolicyHash:digest(f.policy)};
 const env={...f.env,ROLE:"operator",SERVICE_MODE:"internal",LOCAL_ONLY:"pirate-local-skeleton",COMMUNITY_ID:f.policy.communityId,
  PRIVATE_KEY:keys[2],ISSUER:accounts[1].address,OPERATOR_ADDRESS:accounts[2].address,
  COMMUNITY_ADDRESS:accounts[3].address,PAYMENT_CHAIN_ID:"6343",SIGNATURE_CHAIN_ID:"6343",
  PAYMENT_TOKEN:accounts[4].address,PAYMENTS_CONTRACT:accounts[4].address,
  QUOTE_VALID_FROM:String(f.store.now()-10),QUOTE_VALID_UNTIL:String(f.store.now()+3600),
  HISTORY_RETENTION_DAYS:"30",STUDY_PRIVATE_V5_PROFILE:JSON.stringify(profile),
  KARAOKE_PRIVATE_PROFILE:digest(profile),KARAOKE_LOCAL_MODEL_SHA256:digest("fixture model"),
  KARAOKE_LOCAL_TRANSCRIBER:{fetch:async()=>{throw Error("unused fixture recognizer");}}} as unknown as Env;
 const store=f.store as unknown as Store;
 const manifest=fixtureManifest({communityId:f.policy.communityId,title:"Fixture song"} as Song);
 const id=digest("private Karaoke fixture take");
 const call=async(path:string,value:unknown)=>karaokeRoute(new Request("https://operator.invalid"+path,
  {method:"POST",body:JSON.stringify(value)}),env,store,{} as DurableObjectState);
 const ticket=async():Promise<Signed<Ticket>>=>sign("ticket",{ticketId:id,communityId:f.policy.communityId,
  participant:accounts[5].address,songHash:manifest.songHash,manifestSha256:digest(manifest),
  sessionKey:accounts[6].address,operator:accounts[2].address,quoteId:quoteIdOf(operatorQuote(env)),
  community:accounts[3].address,mode:"performance",maxPaidSegments:manifest.segments.length,
  maxDurationMs:27000,issuedAt:f.store.now(),expiresAt:f.store.now()+120,
  privateProfileHash:env.KARAOKE_PRIVATE_PROFILE as Ticket["privateProfileHash"]},keys[1],6343);
 return {...f,env,store,manifest,id,call,ticket};
}
async function artifact(label:string,f:ReturnType<typeof fixture>) {
 const bytes=JSON.stringify({schema:"pirate.private-karaoke-source-fixture/1",label,scope:f.store.get("privateKaraokeScope:1"),
  recordKeys:f.store.entries("").map(x=>x.key),result:f.store.get("result:"+f.id),history:f.store.get("history:"+f.id)})+"\n";
 const path=".local/private-karaoke-source/"+label+".json";await mkdir(".local/private-karaoke-source",{recursive:true});
 await writeFile(path,bytes);return {path,sha256:createHash("sha256").update(bytes).digest("hex")};
}
test("private signed take finalizes and recovers history without public consent or transaction rows",async t=>{
 const f=fixture();try {
  const ticket=await f.ticket();assert.equal((await f.call("/prepare",{ticket,manifest:f.manifest}))?.status,200);
  const now=f.store.now();f.store.set("attempt:"+f.id,{ticketId:f.id,attemptId:digest(f.id),startedAt:now,
   connected:false,disconnectedAt:now,lastAudioAt:null,failedLineIds:[],generation:1,
   ended:{endedAt:now,performanceEndedAt:now,status:"completed",paymentDeadline:now},closing:{block:null},finalized:false} satisfies Attempt);
  await tick(f.env,f.store);await tick(f.env,f.store);
  const result=await f.call("/result",{ticketId:f.id});assert.equal(result?.status,200);
  const record=await(await f.call("/record",{ticketId:f.id}))!.json() as {consent:unknown;publication:{state:string}};
  assert.equal(record.consent,null);assert.equal(record.publication.state,"private");
  const proof=await accounts[6].signMessage({message:"connect:"+f.id});
  assert.equal((await f.call("/history",{ticketId:f.id,proof}))?.status,200);
  for(const prefix of ["tx:","consent:","publication:","publicationV2:","pendingEnrollment:","pendingAuthorization:"])
   assert.equal(f.store.entries(prefix).length,0,prefix);
  t.diagnostic(JSON.stringify(await artifact("private-terminal",f)));
 } finally {f.close();}
});
for(const target of ["RECORDS_CONTRACT","RESULTS_V2_CONTRACT","RESULTS_V3_CONTRACT","RESULTS_V4_CONTRACT"])
 test("private profile rejects configured public target "+target,async()=>{
  const f=fixture();try{(f.env as unknown as Record<string,unknown>)[target]=accounts[0].address;
   await assert.rejects(f.call("/prepare",{ticket:await f.ticket(),manifest:f.manifest}),/private_karaoke_public_target/);
   assert.equal(f.store.entries("ticket:").length,0);assert.equal(f.store.entries("tx:").length,0);
  }finally{f.close();}
 });
test("private scope never reclassifies old public state or admits a changed profile",async()=>{
 const f=fixture();try {
  f.store.set("consent:historical",{retained:true});assert.throws(()=>privateKaraokeScope(f.env,f.store),/private_karaoke_state_unclassified/);
  f.store.delete("consent:historical");privateKaraokeScope(f.env,f.store);
  f.env.KARAOKE_PRIVATE_PROFILE=digest("changed");assert.throws(()=>privateKaraokeScope(f.env,f.store),/private_karaoke_profile/);
 }finally{f.close();}
});
test("private operator refuses public ticket bytes and public endpoints before state mutation",async()=>{
 const f=fixture();try {
  const raw=await f.ticket();const {privateProfileHash:ignored,...body}=raw.body;
  const publicTicket=await sign("ticket",body,keys[1],6343);
  await assert.rejects(f.call("/prepare",{ticket:publicTicket,manifest:f.manifest}),/private_karaoke_ticket/);
  for(const path of ["/consent","/enrollment","/enrollment/request","/__correct","/attempt/purchases"])
   assert.equal((await f.call(path,{}))?.status,404,path);
  assert.equal(f.store.entries("ticket:").length,0);assert.equal(f.store.entries("tx:").length,0);
 }finally{f.close();}
});
