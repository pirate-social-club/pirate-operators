// UNRUN. Simulated provider/chain transport is explicit; handlers, databases,
// private storage, cryptography, signed bytes and queue/recovery paths are real.
import test from "node:test";
import assert from "node:assert/strict";
import { hashJson } from "../packages/community/common.ts";
import { catalogObligation } from "../packages/community/catalog-outbox.ts";
import { loadJob } from "../packages/community/publication-store.ts";
import { CATALOG_OWNER_POLICY_VERSION } from "../packages/community/owner-policy.ts";
import type { CommunityFeed } from "../packages/community/application-api.ts";
import { reservationFixture, otherOwner } from "./recognition-reservation-fixture.ts";
import { submit,drive,rows } from "./recognition-reservation-helpers.ts";

test('two actual community applications publish restrictive songs into one shared catalog with one upload',async()=>{
  const f=await reservationFixture();try {
    const a=await submit(f),published=await drive(f,a.jobId);
    assert.equal(published.phase,'published');
    const b=await submit(f,1),second=await drive(f,b.jobId,1);
    assert.equal(second.phase,'published');assert.equal(f.counts.uploads,1);
    const records=await rows(f.db,'shared_recognition_recordings'),associations=await rows(f.db,'shared_recognition_publications');
    assert.equal(records.length,1);assert.equal(associations.length,2);
    assert.equal(associations[0]!.recording_id,associations[1]!.recording_id);
    for(const row of associations)assert.equal(JSON.parse(String(row.publication_json)).allowsDerivatives,false);
    for(const [i,song]of [a,b].entries()) {
      const o=await catalogObligation(f.apps[i]!.f.community.db,song.jobId);
      assert.equal(o.state,'complete');assert.ok(o.posting_json&&o.chain_receipt_json&&o.promotion_receipt_json);
      const operations=await rows(f.apps[i]!.f.community.db,'external_operations');
      assert.deepEqual(operations.map(r=>r.step),['catalog_reserve','pin_audio','pin_lyrics','pin_manifest','publication','catalog_confirm']);
      const feed=await f.apps[i]!.call('/api/feed');
      assert.equal(feed.status,200,await feed.clone().text());
      const body:CommunityFeed=await feed.json();
      assert.equal(body.schema,'pirate.community-feed/1');assert.equal(body.communityId,song.intent.communityId);
      assert.equal(body.posts.find(post=>post.manifest.postId===song.intent.postId)?.manifest.schema,'pirate.community-post/4');
      const post=JSON.parse(String((await rows(f.apps[i]!.f.community.db,'public_post_revisions'))[0]!.manifest_json));
      assert.equal(post.schema,'pirate.community-post/4');assert.equal(post.admission.policyVersion,CATALOG_OWNER_POLICY_VERSION);
      assert.equal(post.terms.allowsDerivatives,false);
    }
  }finally{await f.dispose();}
});
test('verified alternate encoding reuses the same creator canonical recording without another upload',async()=>{
  const f=await reservationFixture();try {
    const a=await submit(f);assert.equal((await drive(f,a.jobId)).phase,'published');
    const b=await submit(f,1,'alternate');assert.notEqual(a.intent.audioSha256,b.intent.audioSha256);
    assert.equal((await drive(f,b.jobId,1)).phase,'published');assert.equal(f.counts.uploads,1);
    const refs=await rows(f.db,'shared_recognition_publications');assert.ok(refs[1]!.match_evidence_sha256);
    assert.equal(refs[0]!.recording_id,refs[1]!.recording_id);
  }finally{await f.dispose();}
});
test('owner-only, Origin and explicit terms checks fail before creating catalog obligations',async()=>{
  const f=await reservationFixture();try {
    const app=f.apps[0]!,other=await app.signIn(otherOwner),body=JSON.stringify({original:true,acceptedPolicy:CATALOG_OWNER_POLICY_VERSION});
    assert.equal((await other.write('/api/uploads','POST',body,{'content-type':'application/json','idempotency-key':'not-owner-catalog-0001'})).status,403);
    const owner=await app.signIn();
    assert.equal((await owner.write('/api/uploads','POST',JSON.stringify({title:'Missing terms',language:'en',lyrics:app.f.managed.lyrics,original:true,
      acceptedPolicy:CATALOG_OWNER_POLICY_VERSION,rating:'general',audioSha256:app.f.managed.body.declared.songSha256,audioBytes:app.f.managed.audio.length}),
      {'content-type':'application/json','idempotency-key':'missing-terms-catalog-0001'})).status,400);
    assert.equal((await owner.write('/api/uploads','POST',body,{origin:'https://wrong.example','content-type':'application/json','idempotency-key':'wrong-origin-catalog-0001'})).status,403);
    assert.equal((await rows(app.f.community.db,'publication_catalog_obligations')).length,0);
    assert.equal((await rows(f.db,'shared_recognition_recordings')).length,0);
  }finally{await f.dispose();}
});
test('catalog outage and indexing lag keep real jobs pending and cannot expose published feed rows',async()=>{
  const f=await reservationFixture();try {
    f.flags.indexing=true;const song=await submit(f);await drive(f,song.jobId,0,8);
    assert.notEqual((await loadJob(song.app.f.community.db,song.jobId)).phase,'published');
    assert.equal(song.app.f.posts.broadcasts(),0);assert.equal(f.counts.uploads,1);
    const feed=await song.app.call('/api/feed');assert.equal(feed.status,200);
    assert.equal(JSON.stringify(await feed.json()).includes(song.intent.postId),false);
    f.flags.indexing=false;assert.equal((await drive(f,song.jobId)).phase,'published');
  }finally{await f.dispose();}
});
test('concurrent originals consume one namespace fence and cannot mistake an incomplete catalog for no match',async()=>{
  const f=await reservationFixture();try {
    const [a,b]=await Promise.all([submit(f),submit(f,1)]);
    await Promise.all([a.app.deliver(a.jobId),b.app.deliver(b.jobId)]);
    await f.deliverShared();await f.deliverShared();
    const gate=await rows(f.db,'shared_recognition_original_gate'),calls=await rows(f.db,'shared_recognition_original_calls');
    assert.equal(gate.length,1);assert.equal(calls.length,1);assert.equal(f.counts.uploads,0);
    assert.equal((await drive(f,a.jobId)).phase,'published');assert.equal((await drive(f,b.jobId,1)).phase,'published');
    assert.equal(f.counts.uploads,1);
  }finally{await f.dispose();}
});
test('a restored unknown original journal never purchases another identification or drops its fence',async()=>{
  const f=await reservationFixture();try {
    f.flags.lostIdentify=true;const song=await submit(f);await drive(f,song.jobId,0,4);
    const calls=await rows(f.db,'shared_recognition_original_calls'),charges=await rows(f.db,'shared_recognition_quota_charges');
    assert.equal(calls.length,1);assert.equal(calls[0]!.state,'unknown');const before=f.counts.identifies;
    f.flags.lostIdentify=false;f.restart();await drive(f,song.jobId,0,8);
    assert.equal(f.counts.identifies,before);assert.equal(f.counts.uploads,0);
    assert.deepEqual(await rows(f.db,'shared_recognition_original_calls'),calls);
    assert.deepEqual(await rows(f.db,'shared_recognition_quota_charges'),charges);
    assert.notEqual((await loadJob(song.app.f.community.db,song.jobId)).phase,'published');
  }finally{await f.dispose();}
});
for(const boundary of ['loseReserveAck','loseBindAck','loseCommitAck'] as const)test(`central ${boundary} restart retains one intent, exact signed bytes and one chain effect`,async()=>{
  const f=await reservationFixture();try {
    f.flags[boundary]=true;const song=await submit(f);await drive(f,song.jobId,0,10);f.restart();
    assert.equal((await drive(f,song.jobId)).phase,'published');
    const operation=(await rows(song.app.f.community.db,'external_operations')).find(r=>r.step==='publication')!,o=await catalogObligation(song.app.f.community.db,song.jobId),posting=JSON.parse(o.posting_json!);
    assert.equal(posting.operationId,operation.operation_id);assert.equal(posting.requestHash,operation.request_hash);
    assert.equal(posting.signedTransaction,JSON.parse(String(operation.prepared_json)).replay.signedTransaction);
    assert.equal(f.counts.uploads,1);assert.equal(song.app.f.posts.broadcasts(),1);
    assert.equal((await rows(f.db,'shared_recognition_reservations')).length,1);assert.equal(o.intent_sha256,hashJson(song.intent));
  }finally{await f.dispose();}
});
for(const boundary of ['lostUpload','unknownBeforeUpload'] as const)test(`${boundary} preserves unknown upload identity without another send after restart`,async()=>{
  const f=await reservationFixture();try {
    f.flags[boundary]=true;const song=await submit(f);await drive(f,song.jobId,0,6);
    assert.equal(f.counts.uploads,1);f.flags[boundary]=false;f.restart();await drive(f,song.jobId,0,10);
    assert.equal(f.counts.uploads,1);
    if(boundary==='lostUpload')assert.equal((await drive(f,song.jobId)).phase,'published');
    else assert.notEqual((await loadJob(song.app.f.community.db,song.jobId)).phase,'published');
  }finally{await f.dispose();}
});
test('removing a managed installation identity fails closed before any restored unknown may send',async()=>{
  const f=await reservationFixture();try {
    await f.db.prepare('DELETE FROM shared_recognition_installation').run();f.restart();
    await assert.rejects(f.recoverShared(),/recognition_restore_or_installation_unqualified/);
    assert.equal(f.counts.identifies,0);assert.equal(f.counts.uploads,0);
  }finally{await f.dispose();}
});
test('provider outage remains explicit catalog pending and a lost original result cannot auto-expire into another paid call',async()=>{
  const f=await reservationFixture();try {
    f.flags.outage=true;const s=await submit(f);await drive(f,s.jobId,0,5);
    const calls=await rows(f.db,'shared_recognition_original_calls'),count=f.counts.identifies;
    assert.equal(calls.length,1);assert.equal(count,1);assert.equal(s.app.f.posts.broadcasts(),0);
    f.flags.outage=false;f.restart();await drive(f,s.jobId,0,5);
    assert.equal(f.counts.identifies,count);assert.equal(f.counts.uploads,0);
    const view=await (await s.app.call(`/api/jobs/${encodeURIComponent(s.jobId)}`,{headers:{cookie:s.session.cookie}})).json() as {catalog:{state:string}};
    assert.equal(view.catalog.state,'pending');
  }finally{await f.dispose();}
});
