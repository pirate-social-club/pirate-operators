// UNRUN: real queue/database recovery across durable boundaries, explicit faults.
import test from "node:test";
import assert from "node:assert/strict";
import { loadJob } from "../packages/community/publication-store.ts";
import { catalogObligation } from "../packages/community/catalog-outbox.ts";
import { reservationFixture } from "./recognition-reservation-fixture.ts";
import { submit,drive,rows } from "./recognition-reservation-helpers.ts";
import { journalFault } from "./recognition-journal-fault.ts";

for(const boundary of [
  {name:'provider response retained before disposition',sql:/UPDATE shared_recognition_original_calls SET state='received'/},
  {name:'upload intent before provider send',sql:(sql:string,values:unknown[])=>/INSERT INTO shared_recognition_events/.test(sql)&&/UPDATE shared_recognition_recordings SET state=\?/.test(sql)&&values[0]==='upload_unknown'&&values[1]==='{"reason":"upload_intent"}'},
  {name:'verification receipt before ready transition',sql:(sql:string,values:unknown[])=>/INSERT INTO shared_recognition_events/.test(sql)&&values[0]==='receipt:verify'},
] as const)test(`shared process death: ${boundary.name}`,async()=>{
  let fault:ReturnType<typeof journalFault>|undefined;
  const f=await reservationFixture({serviceDatabase:db=>{fault??=journalFault(db,boundary.sql);return fault.database;}});try {
    const s=await submit(f);await drive(f,s.jobId,0,8);assert.ok(fault?.fired());
    if(boundary.name==='upload intent before provider send') {
      const recording=(await rows(f.db,'shared_recognition_recordings'))[0]!;
      assert.equal(recording.state,'upload_unknown');assert.equal(f.counts.uploads,0);
      const events=await rows(f.db,'shared_recognition_events');
      assert.ok(events.some(row=>row.recording_id===recording.recording_id&&row.kind==='upload_unknown'&&row.evidence_json==='{"reason":"upload_intent"}'));
    }
    const calls=await rows(f.db,'shared_recognition_original_calls'),before=f.counts.identifies;
    f.restart();await drive(f,s.jobId,0,15);
    assert.equal((await rows(f.db,'shared_recognition_original_calls')).length,1);
    assert.equal((await rows(f.db,'shared_recognition_original_calls'))[0]!.operation_id,calls[0]!.operation_id);
    assert.ok(f.counts.identifies>=before);assert.ok(f.counts.uploads<=1);
    // An intent-only unknown cannot be replayed merely because the worker restarted.
    if(boundary.name==='upload intent before provider send')assert.notEqual((await loadJob(s.app.f.community.db,s.jobId)).phase,'published');
    else {assert.equal((await drive(f,s.jobId)).phase,'published');assert.equal(f.counts.identifies,2);}
  }finally{await f.dispose();}
});
for(const boundary of [
  {name:'prepared posting bytes',sql:/UPDATE external_operations SET status='prepared'/},
  {name:'chain receipt durably confirmed',sql:/UPDATE external_operations SET status='confirmed'/},
  {name:'promotion ack saved before local completion',sql:/UPDATE publication_catalog_obligations SET state='complete'/},
] as const)test(`community process death: ${boundary.name}`,async()=>{
  const f=await reservationFixture();try {
    const s=await submit(f),target=boundary.name==='promotion ack saved before local completion'?'catalog_confirm':'publication';
    for(let i=0;i<18&&(await loadJob(s.app.f.community.db,s.jobId)).phase!==target;i++)await drive(f,s.jobId,0,1);
    assert.equal((await loadJob(s.app.f.community.db,s.jobId)).phase,target);
    const fault=journalFault(s.app.f.community.db,boundary.sql);
    s.app.f.ports.db=fault.database;
    assert.ok(s.app.f.ports.catalog);
    s.app.f.ports.catalog.db=fault.database;
    let offset=0;s.app.f.ports.clock={now:()=>Date.now()+offset};
    for(let i=0;i<12;i++){await drive(f,s.jobId,0,1);if(fault.fired())break;}
    assert.ok(fault.fired());
    const before=(await rows(s.app.f.community.db,'external_operations')).filter(r=>r.step==='publication'),obligation=await catalogObligation(s.app.f.community.db,s.jobId);
    // Simulated elapsed lease time at restart; neither phase nor effect is seeded.
    offset+=180001;f.restart();assert.equal((await drive(f,s.jobId)).phase,'published');
    const after=(await rows(s.app.f.community.db,'external_operations')).find(r=>r.step==='publication')!;
    if(before[0])assert.equal(after.prepared_json,before[0].prepared_json);
    if(obligation.posting_json)assert.equal((await catalogObligation(s.app.f.community.db,s.jobId)).posting_json,obligation.posting_json);
    assert.equal(f.counts.uploads,1);assert.equal(s.app.f.posts.broadcasts(),1);
  }finally{await f.dispose();}
});
test('a lost chain broadcast reply retains exact bytes and reconciles the actual receipt before promotion',async()=>{
  const f=await reservationFixture();try {
    const s=await submit(f),client=s.app.f.posts.client,actual=client.sendRawTransaction.bind(client);let lost=true;
    client.sendRawTransaction=async args=>{const hash=await actual(args);if(lost){lost=false;throw Error('simulated process loss after public send');}return hash;};
    assert.equal((await drive(f,s.jobId)).phase,'published');
    const o=await catalogObligation(s.app.f.community.db,s.jobId),posting=JSON.parse(o.posting_json!),receipt=JSON.parse(o.chain_receipt_json!);
    assert.equal(receipt.transactionHash,posting.transactionHash);assert.equal(s.app.f.posts.broadcasts(),1);
    assert.equal((await rows(f.db,'shared_recognition_reservations'))[0]!.state,'committed');
  }finally{await f.dispose();}
});
test('an unresolved signed posting cannot expire into provisional-reference cancellation',async()=>{
  const f=await reservationFixture();try {
    f.flags.loseBindAck=true;const s=await submit(f);await drive(f,s.jobId,0,9);
    const reservations=await rows(f.db,'shared_recognition_reservations'),r=reservations[0]!;
    assert.ok(r.posting_json);assert.ok(['committing','committed'].includes(String(r.state)));
    // The immutable posting identity survives recreation; no timestamp releases it.
    f.restart();const restored=(await rows(f.db,'shared_recognition_reservations'))[0]!;
    assert.equal(restored.posting_json,r.posting_json);assert.notEqual(restored.state,'cancelled');
    assert.equal(f.counts.deletes,0);
  }finally{await f.dispose();}
});
