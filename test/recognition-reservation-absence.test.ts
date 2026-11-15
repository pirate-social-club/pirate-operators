// Real handlers, D1, request/receipt cryptography and queue recovery. Provider
// and chain transports remain explicit simulations; no real MOSS is claimed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { canonical, hashJson, publicId } from "../packages/community/common.ts";
import { signRecognitionRequest } from "../packages/recognition/authorization.ts";
import { verifyReservation } from "../packages/recognition/reservation-receipt.ts";
import { reservationFixture, type ReservationFixture } from "./recognition-reservation-fixture.ts";
import { drive, rows, submit } from "./recognition-reservation-helpers.ts";
import { canonicalHttpFixture } from "./fixtures/canonical-http.ts";

async function signed(f:ReservationFixture,jobId:string,action:"intent_status"|"intent_reserve"="intent_status") {
  const config=await f.apps[0]!.f.current(),now=Math.floor(Date.now()/1000);
  return signRecognitionRequest(f.apps[0]!.f.ports.managed.publisher,{
    namespace:f.profile.namespace as `0x${string}`,profileSha256:f.profile.sha256 as `0x${string}`,
    communityId:config.communityId,communityOrigin:config.app.origin,serviceOrigin:f.profile.origin,
    configurationRevision:config.configurationRevision,action,nonce:publicId(),issuedAt:now,expiresAt:now+120,
  },{jobId});
}
const request=(f:ReservationFixture,path:string,wire:unknown)=>f.fetch(new Request(f.profile.origin+path,{
  method:"POST",headers:{"content-type":"application/json"},body:canonical(wire),
}));

test("a genuine signed absence recovers the original pre-transport failure; an unsigned conflict cannot authorize a resend",async()=>{
  const f=await reservationFixture();try {
    const song=await submit(f);f.flags.loseReserveBeforeService=true;
    await song.app.deliver(song.jobId);
    const original=(await rows(song.app.f.community.db,"external_operations"))[0]!;
    assert.equal(original.step,"catalog_reserve");assert.equal(original.status,"uncertain");
    assert.equal((await rows(f.db,"shared_recognition_reservations")).length,0);
    assert.equal(f.counts.identifies,0);
    song.app.f.ports.catalog!.transport=async req=>new URL(req.url).pathname.endsWith("/status")
      ?Response.json({error:"recognition_reservation_conflict"},{status:409}):f.fetch(req);
    await drive(f,song.jobId,0,2);
    assert.equal((await rows(song.app.f.community.db,"external_operation_reconciliations")).length,0);
    assert.equal((await rows(f.db,"shared_recognition_reservations")).length,0);
    assert.equal(f.requests.filter(r=>new URL(r.url).pathname==="/v1/reservations").length,1);
    song.app.f.ports.catalog!.transport=f.fetch;f.restart();
    assert.equal((await drive(f,song.jobId)).phase,"published");
    const after=(await rows(song.app.f.community.db,"external_operations")).find(r=>r.operation_id===original.operation_id)!;
    assert.equal(after.request_hash,original.request_hash);assert.equal(after.prepared_json,original.prepared_json);
    const proofs=(await rows(song.app.f.community.db,"external_operation_reconciliations")).filter(r=>r.operation_id===original.operation_id);
    assert.equal(proofs.length,1);
    const proof=JSON.parse(JSON.parse(String(proofs[0]!.proof_json)).absenceProof);
    assert.equal(proof.receipt.payload.purpose,"reservation_absent");
    assert.equal(proof.receipt.payload.state,"absent");assert.equal(proof.receipt.payload.recordingId,null);
    const payload=await verifyReservation(proof.receipt,f.profile,{
      requestSha256:hashJson(proof.request),intentSha256:hashJson(song.intent),
      communityId:song.intent.communityId,configurationRevision:song.intent.configurationRevision,
    },proof.receipt.payload.issuedAt);
    await assert.rejects(verifyReservation(proof.receipt,f.profile,{requestSha256:publicId()},payload.issuedAt));
    await assert.rejects(verifyReservation(proof.receipt,f.profile,{},payload.expiresAt));
    assert.equal((await rows(f.db,"shared_recognition_reservations")).length,1);
    assert.equal((await rows(song.app.f.community.db,"publication_jobs")).length,1);
    assert.equal(f.counts.uploads,1);assert.equal(song.app.f.posts.broadcasts(),1);
    await mkdir(".local/web2-catalog-recovery",{recursive:true});
    await writeFile(`.local/web2-catalog-recovery/absence-${process.pid}.json`,JSON.stringify({
      jobId:song.jobId,operationId:original.operation_id,requestHash:original.request_hash,
      preparedSha256:hashJson(JSON.parse(String(original.prepared_json))),proof,
      reservations:1,jobs:1,uploads:f.counts.uploads,broadcasts:song.app.f.posts.broadcasts(),
    },null,2));
  }finally{await f.dispose();}
});

test("an absence observed before asynchronous signing cannot survive a concurrent genuine reservation",async()=>{
  const f=await reservationFixture();try {
    const song=await submit(f),status=await signed(f,song.jobId),reserve=await signed(f,song.jobId,"intent_reserve");
    f.beforeSign(async()=>{const r=await request(f,"/v1/reservations",reserve);assert.equal(r.status,202);});
    const response=await request(f,"/v1/reservations/status",status);
    assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:"recognition_reservation_changed"});
    assert.equal((await rows(f.db,"shared_recognition_reservations")).length,1);assert.equal(f.counts.identifies,0);
  }finally{await f.dispose();}
});

test("an absence observed before asynchronous signing cannot survive changed canonical owner authority",async()=>{
  const f=await reservationFixture();try {
    const song=await submit(f),status=await signed(f,song.jobId);
    f.beforeSign(async()=>{song.app.f.changeConfiguration({...song.app.f.configuration,configurationRevision:song.app.f.configuration.configurationRevision+1});});
    const response=await request(f,"/v1/reservations/status",status);
    assert.notEqual(response.status,200);const body=await response.json() as {receipt?:unknown};assert.equal(body.receipt,undefined);
    assert.equal((await rows(f.db,"shared_recognition_reservations")).length,0);assert.equal(f.counts.identifies,0);
  }finally{await f.dispose();}
});

test("an existing reservation with a missing joined catalog row cannot become signed absence",async()=>{
  const f=await reservationFixture();try {
    const song=await submit(f);await song.app.deliver(song.jobId);
    assert.equal((await rows(f.db,"shared_recognition_reservations")).length,1);
    await f.db.prepare("DELETE FROM shared_recognition_catalog_revision").run();
    const response=await request(f,"/v1/reservations/status",await signed(f,song.jobId));
    assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:"recognition_reservation_conflict"});
    assert.equal((await rows(f.db,"shared_recognition_reservations")).length,1);assert.equal(f.counts.identifies,0);
  }finally{await f.dispose();}
});

test("a delayed original arriving after signed absence cannot turn the same-operation retry into another paid effect",async()=>{
  const f=await reservationFixture();try {
    const song=await submit(f);f.flags.loseReserveBeforeService=true;await song.app.deliver(song.jobId);
    const original=(await rows(song.app.f.community.db,"external_operations"))[0]!,delayed=f.requests[0]!.clone();let arrivals=0;
    song.app.f.ports.catalog!.transport=async req=>{
      const response=await f.fetch(req);
      if(new URL(req.url).pathname.endsWith("/status")&&response.ok) {
        const body=await response.clone().json() as {receipt:{payload:{purpose:string}}};
        if(body.receipt.payload.purpose==="reservation_absent") {
          const original=new Request(delayed.url,{method:delayed.method,headers:delayed.headers,body:await delayed.clone().arrayBuffer()});
          arrivals++;assert.equal((await f.fetch(original)).status,202);
        }
      }
      return response;
    };
    assert.equal((await drive(f,song.jobId)).phase,"published");assert.equal(arrivals,1);
    const after=(await rows(song.app.f.community.db,"external_operations")).find(r=>r.operation_id===original.operation_id)!;
    assert.equal(after.request_hash,original.request_hash);assert.equal(after.prepared_json,original.prepared_json);
    assert.equal((await rows(f.db,"shared_recognition_reservations")).length,1);
    assert.equal((await rows(f.db,"shared_recognition_original_calls")).length,1);
    // One original identification and one enrollment verification share the host.
    assert.equal(f.counts.identifies,2);
    assert.equal(f.counts.uploads,1);assert.equal(song.app.f.posts.broadcasts(),1);
  }finally{await f.dispose();}
});

test("the actual workerd reservation client reaches signed HTTP status and refuses a redirect without another destination",async()=>{
  const f=await reservationFixture();let worker:Miniflare|undefined,http:Awaited<ReturnType<typeof canonicalHttpFixture>>|undefined;
  try {
    const song=await submit(f);let redirect=false,calls=0;
    http=await canonicalHttpFixture(new Map([[f.profile.origin,f.fetch]]));
    const bundle=await build({bundle:true,write:false,format:"esm",platform:"browser",target:"es2022",stdin:{
      resolveDir:fileURLToPath(new URL("..",import.meta.url)),contents:`
        import {reservationClient} from './packages/recognition/reservation-client.ts';
        import {privateKeyToAccount} from 'viem/accounts';
        export default {async fetch(request,env){try {
          const client=reservationClient({profile:JSON.parse(env.PROFILE),publisher:privateKeyToAccount(env.KEY),
            current:async()=>{},beforeSend:async()=>{},transport:request=>env.CATALOG.fetch(request)});
          return Response.json(await client.status(JSON.parse(env.INTENT)));
        }catch(error){return Response.json({error:error.message},{status:500});}}};`,
    }});
    worker=new Miniflare({modules:true,script:bundle.outputFiles[0]!.text,compatibilityDate:"2026-08-06",
      bindings:{PROFILE:JSON.stringify(f.profile),INTENT:JSON.stringify(song.intent),KEY:`0x${"11".repeat(32)}`},
      serviceBindings:{CATALOG:async(request:Request)=>{calls++;return redirect
        ?new Response(null,{status:302,headers:{location:"https://unselected.example/reservation"}})
        :http!.transport(new Request(request.url,{method:request.method,headers:request.headers,body:await request.arrayBuffer()}));}},
    });
    const status=await worker.dispatchFetch("https://owned-worker.example/status");
    assert.equal(status.status,200,await status.clone().text());
    const payload=await status.json() as {state:string};assert.equal(payload.state,"absent");
    assert.equal(http.evidence.length,1);assert.equal(http.evidence[0]!.status,200);
    redirect=true;
    const refused=await worker.dispatchFetch("https://owned-worker.example/status");
    assert.equal(refused.status,500);assert.deepEqual(await refused.json(),{error:"recognition_catalog_pending"});
    assert.equal(calls,2);assert.equal(http.evidence.length,1);
    assert.equal((await rows(f.db,"shared_recognition_reservations")).length,0);
    await mkdir(".local/web2-catalog-recovery",{recursive:true});
    await writeFile(`.local/web2-catalog-recovery/workerd-http-${process.pid}.json`,JSON.stringify({calls,http:http.evidence,
      signedAbsence:payload,redirectRefused:true,unselectedDestinations:0},null,2));
  }finally{await worker?.dispose();await http?.close();await f.dispose();}
});
