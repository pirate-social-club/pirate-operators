import { address } from "../packages/community/manifest-core.ts";
// UNRUN. Real service/authority/database paths with explicit transport faults.
import test from "node:test";
import assert from "node:assert/strict";
import { CommunityError, hashJson, publicId } from "../packages/community/common.ts";
import { signRecognitionRequest, type RecognitionAction } from "../packages/recognition/authorization.ts";
import { verifyReservation } from "../packages/recognition/reservation-receipt.ts";
import { ReservationStore } from "../packages/recognition/reservation-store.ts";
import { RecognitionStore } from "../packages/recognition/store.ts";
import { reservationId } from "../packages/recognition/intent.ts";
import { leaseJob } from "../packages/community/publication-store.ts";
import { staleSessionReplica } from "./shared-recognition-replication-fixture.ts";
import { reservationFixture, otherOwner, reservationSigner, type ReservationFixture } from "./recognition-reservation-fixture.ts";
import { submit,drive,rows } from "./recognition-reservation-helpers.ts";

async function wire(f:ReservationFixture,jobId:string,index=0,action:RecognitionAction='intent_status',nonce=publicId(),wrongSigner=false) {
  const app=f.apps[index]!,config=await app.f.current(),now=Math.floor(Date.now()/1000);
  return signRecognitionRequest(wrongSigner?reservationSigner:app.f.ports.managed.publisher,{namespace:f.profile.namespace as `0x${string}`,
    profileSha256:f.profile.sha256 as `0x${string}`,communityId:config.communityId,communityOrigin:config.app.origin,serviceOrigin:f.profile.origin,
    configurationRevision:config.configurationRevision,action,nonce,issuedAt:now,expiresAt:now+120},{jobId});
}
const send=(f:ReservationFixture,path:string,signed:unknown)=>f.fetch(new Request(f.profile.origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(signed)}));
async function readyReservation(f:ReservationFixture,song:Awaited<ReturnType<typeof submit>>) {
  await song.app.deliver(song.jobId);
  for(let i=0;i<6;i++){await f.recoverShared();for(let n=0;n<6&&f.wakes.length;n++)await f.deliverShared();}
  const s=new ReservationStore(f.db,f.profile.namespace),row=await s.refreshReady(reservationId(song.intent),song.intent.communityId);
  assert.equal(s.database,f.db);assert.equal(s.namespace,f.profile.namespace);
  assert.deepEqual(Object.keys(s),['database','namespace']);
  assert.equal(row?.state,'ready');return row!;
}
for(const permission of [false,true])test(`a different creator cannot reuse an original as their own, derivatives=${permission}`,async()=>{
  const f=await reservationFixture({secondCreator:otherOwner});try {
    const a=await submit(f,0,'master',permission);assert.equal((await drive(f,a.jobId)).phase,'published');
    const b=await submit(f,1);assert.notEqual(a.intent.creatorKey,b.intent.creatorKey);
    const job=await drive(f,b.jobId,1,10);assert.notEqual(job.phase,'published');
    assert.equal(f.apps[1]!.f.posts.broadcasts(),0);assert.equal(f.counts.uploads,1);
    assert.equal((await rows(f.db,'shared_recognition_publications')).length,1);
  }finally{await f.dispose();}
});
test('wrong publisher, profile and action are refused before a reservation or provider intent exists',async()=>{
  const f=await reservationFixture();try {
    const s=await submit(f),wrong=await wire(f,s.jobId,0,'intent_reserve',publicId(),true);
    assert.equal((await send(f,'/v1/reservations',wrong)).status,403);
    const profile=await wire(f,s.jobId,0,'intent_reserve');profile.authorization.profileSha256=publicId();
    assert.equal((await send(f,'/v1/reservations',profile)).status,403);
    const action=await wire(f,s.jobId,0,'catalog_status');assert.equal((await send(f,'/v1/reservations',action)).status,403);
    assert.equal((await rows(f.db,'shared_recognition_reservations')).length,0);assert.equal(f.counts.identifies,0);
  }finally{await f.dispose();}
});
test('exact wire replay is idempotent while changing a body under the same nonce fails',async()=>{
  const f=await reservationFixture();try {
    const a=await submit(f),b=await submit(f,0,'another'),nonce=publicId(),signed=await wire(f,a.jobId,0,'intent_reserve',nonce);
    assert.equal((await send(f,'/v1/reservations',signed)).status,202);assert.equal((await send(f,'/v1/reservations',signed)).status,202);
    assert.equal((await send(f,'/v1/reservations',await wire(f,b.jobId,0,'intent_reserve',nonce))).status,409);
    assert.equal((await rows(f.db,'shared_recognition_reservations')).length,1);assert.equal(f.counts.identifies,0);
  }finally{await f.dispose();}
});
test('an old catalog-status proof or a publisher signature cannot stand in for accepted-intent admission',async()=>{
  const f=await reservationFixture();try {
    await assert.rejects(verifyReservation({payload:{schema:'pirate.recognition-catalog-receipt/1'},signature:'0x00'},f.profile,{},Math.floor(Date.now()/1000)));
    const s=await submit(f);await readyReservation(f,s);
    const response=await send(f,'/v1/reservations/status',await wire(f,s.jobId)),body=await response.json() as {receipt:unknown};
    const badPin={...f.profile,signer:s.app.f.ports.managed.publisher.address.toLowerCase()};
    // Recompute the public hash so failure is the distinct signing identity, not a malformed profile.
    const {sha256:_old,...payload}=badPin;badPin.sha256=hashJson(payload);
    await assert.rejects(verifyReservation(body.receipt,badPin,{},Math.floor(Date.now()/1000)));
  }finally{await f.dispose();}
});
test('canonical owner/current configuration changed during async signing cannot return ready',async()=>{
  const f=await reservationFixture();try {
    const s=await submit(f);await readyReservation(f,s);
    f.beforeSign(async()=>{s.app.f.changeConfiguration({...s.app.f.configuration,publisher:address(otherOwner.address)});});
    const response=await send(f,'/v1/reservations/status',await wire(f,s.jobId));
    assert.notEqual(response.status,200);assert.equal(f.counts.uploads,1);
  }finally{await f.dispose();}
});
test('fresh primary joined reservation fence rejects a permitted stale-session view after cancellation during signing',async()=>{
  let replica:ReturnType<typeof staleSessionReplica>|undefined;
  const f=await reservationFixture({serviceDatabase:db=>(replica=staleSessionReplica(db)).database});try {
    const s=await submit(f);await readyReservation(f,s);
    // Demonstrate the replica model permits a stale second read in ONE session.
    const session=replica!.database.withSession('first-primary'),sql='SELECT state FROM shared_recognition_reservations WHERE reservation_id=?',id=reservationId(s.intent);
    await session.prepare(sql).bind(id).first();
    f.beforeSign(async()=>{
      const cancelled=await send(f,'/v1/reservations/cancel',await wire(f,s.jobId,0,'intent_cancel'));
      assert.equal(cancelled.status,202,await cancelled.clone().text());
      assert.equal((await session.prepare(sql).bind(id).first<{state:string}>())?.state,'ready');
    });
    assert.equal((await send(f,'/v1/reservations/status',await wire(f,s.jobId))).status,409);
    assert.ok(replica!.counts.staleReads>0);
  }finally{await f.dispose();}
});
test('provisional and final references prevent deletion until the last verified withdrawal',async()=>{
  const f=await reservationFixture();try {
    const a=await submit(f);assert.equal((await drive(f,a.jobId)).phase,'published');
    const b=await submit(f,1);await readyReservation(f,b);
    const store=new RecognitionStore(f.db,f.profile.namespace),refs=await rows(f.db,'shared_recognition_publications'),p=JSON.parse(String(refs[0]!.publication_json));
    f.withdrawOnChain(p.communityId,p.postId);
    const wa=await signRecognitionRequest(a.app.f.ports.managed.publisher,{...(await wire(f,a.jobId)).authorization,action:"catalog_withdraw",nonce:publicId()},{associationId:refs[0]!.association_id});
    assert.equal((await send(f,"/v1/catalog/publications/withdraw",wa)).status,200);
    await f.recoverShared();for(let i=0;i<5&&f.wakes.length;i++)await f.deliverShared();
    assert.equal(f.counts.deletes,0);assert.equal((await store.get(String(refs[0]!.recording_id)))?.state,'ready');
    assert.equal((await drive(f,b.jobId,1)).phase,'published');
    const last=(await rows(f.db,'shared_recognition_publications'))[1]!,publication=JSON.parse(String(last.publication_json));
    f.withdrawOnChain(publication.communityId,publication.postId);
    const wb=await signRecognitionRequest(b.app.f.ports.managed.publisher,{...(await wire(f,b.jobId,1)).authorization,action:"catalog_withdraw",nonce:publicId()},{associationId:last.association_id});
    assert.equal((await send(f,"/v1/catalog/publications/withdraw",wb)).status,200);await f.recoverShared();for(let i=0;i<6&&f.wakes.length;i++)await f.deliverShared();
    assert.equal(f.counts.deletes,1);assert.equal((await store.get(String(last.recording_id)))?.state,'deleted');
    const again=await submit(f,0,'new-after-confirmed-deletion');
    assert.equal((await drive(f,again.jobId)).phase,'published');
    assert.equal((await rows(f.db,'shared_recognition_recordings')).length,1);
    assert.equal((await rows(f.db,'shared_recognition_recordings'))[0]!.recording_id,last.recording_id);
    assert.equal(f.counts.uploads,2);
  }finally{await f.dispose();}
});
test('quota ceilings and charges survive restarts and cannot be reset by a replacement configuration',async()=>{
  const f=await reservationFixture();try {
    const s=await submit(f);await readyReservation(f,s);const charges=await rows(f.db,'shared_recognition_quota_charges');
    assert.ok(charges.length>=2);await assert.rejects(f.db.prepare('UPDATE shared_recognition_quota_limits SET ceiling=ceiling+1').run(),/recognition_quota_changed/);
    f.restart();assert.deepEqual(await rows(f.db,'shared_recognition_quota_charges'),charges);
    const ready=await send(f,'/v1/reservations/status',await wire(f,s.jobId));assert.equal(ready.status,200);
    assert.deepEqual(await rows(f.db,'shared_recognition_quota_charges'),charges);
  }finally{await f.dispose();}
});

test('unknown provider effects keep provisional references even under a verified local cancellation',async()=>{
  const f=await reservationFixture();try {
    f.flags.unknownBeforeUpload=true;const s=await submit(f);await drive(f,s.jobId,0,7);
    const before=(await rows(f.db,'shared_recognition_reservations'))[0]!;
    assert.equal((await send(f,'/v1/reservations/cancel',await wire(f,s.jobId,0,'intent_cancel'))).status,409);
    f.restart();const after=(await rows(f.db,'shared_recognition_reservations'))[0]!;
    assert.equal(after.state,before.state);assert.equal(after.recording_id,before.recording_id);assert.equal(f.counts.deletes,0);
  }finally{await f.dispose();}
});
test('the bind endpoint rejects changed nonce, operation, hash and signed bytes from the exact durable posting',async()=>{
  const f=await reservationFixture();try {
    const s=await submit(f);f.flags.loseBindAck=true;
    let row:Record<string,unknown>|undefined;
    for(let i=0;i<18;i++){await drive(f,s.jobId,0,1);row=(await rows(f.db,'shared_recognition_reservations'))[0];if(row?.posting_json)break;}
    assert.ok(row?.posting_json);assert.equal(s.app.f.posts.broadcasts(),0);
    const posting=JSON.parse(String(row.posting_json)),base=await wire(f,s.jobId,0,'intent_bind');
    for(const mutation of [{nonce:posting.nonce+1},{operationId:publicId()},{transactionHash:publicId()},{signedTransaction:'0x01'}]) {
      const changed=await signRecognitionRequest(s.app.f.ports.managed.publisher,{...base.authorization,nonce:publicId()},{jobId:s.jobId,posting:{...posting,...mutation}});
      assert.equal((await send(f,'/v1/reservations/bind',changed)).status,409);
    }
    assert.equal(s.app.f.posts.broadcasts(),0);assert.equal((await rows(f.db,'shared_recognition_reservations'))[0]!.posting_json,row.posting_json);
    let successor:string|null=null;
    f.beforeSign(async()=>{successor=(await leaseJob(s.app.f.community.db,s.jobId,Date.now()+180001))?.lease_token??null;assert.ok(successor);});
    await s.app.deliver(s.jobId);
    assert.equal(s.app.f.posts.broadcasts(),0,'original worker cannot adopt the successor lease after asynchronous binding');
    assert.equal((await s.app.f.community.db.prepare('SELECT lease_token FROM publication_jobs WHERE job_id=?').bind(s.jobId).first<{lease_token:string}>())?.lease_token,successor);
  }finally{await f.dispose();}
});
test('sealed private media changed during async signing cannot produce a ready proof',async()=>{
  const f=await reservationFixture();try {
    const s=await submit(f);await readyReservation(f,s);
    f.beforeSign(async()=>{const changed=new Uint8Array(s.audio);changed[4]=99;await s.app.f.community.media.put(s.intent.audioObjectKey,changed,{customMetadata:{sha256:s.intent.audioSha256}});});
    const response=await send(f,'/v1/reservations/status',await wire(f,s.jobId));assert.equal(response.status,409);
    assert.equal(s.app.f.posts.broadcasts(),0);
  }finally{await f.dispose();}
});

test('private media outage during async signing retains its distinct 503 response',async()=>{
  const f=await reservationFixture(),ports=f.apps[0]!.f.canonicalPorts,media=ports.media;
  try {
    const s=await submit(f);await readyReservation(f,s);
    f.beforeSign(async()=>{ports.media=new Proxy(media,{get(target,key,receiver){
      if(key==='head')return async()=>{throw new CommunityError('private_media_unavailable',503);};
      return Reflect.get(target,key,receiver);
    }});});
    const response=await send(f,'/v1/reservations/status',await wire(f,s.jobId));
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'private_media_unavailable'});
    assert.equal(s.app.f.posts.broadcasts(),0);
  }finally{ports.media=media;await f.dispose();}
});
