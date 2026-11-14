import assert from "node:assert/strict";
import { sha256 } from "viem";
import { CATALOG_OWNER_POLICY_VERSION } from "../packages/community/owner-policy.ts";
import { loadJob } from "../packages/community/publication-store.ts";
import { catalogObligation } from "../packages/community/catalog-outbox.ts";
import type { ReservationFixture } from "./recognition-reservation-fixture.ts";

/** Every accepted intent is produced through actual login/upload/stem/seal handlers. */
export async function submit(f:ReservationFixture,index=0,encoding='master',allowsDerivatives=false) {
  const app=f.apps[index]!,session=await app.signIn(),audio=new Uint8Array(app.f.managed.audio);
  if(encoding==='alternate')for(let i=4;i<audio.length;i+=417)audio[i]=7;
  const response=await session.write('/api/uploads','POST',JSON.stringify({title:`Catalog ${encoding}`,language:'en',lyrics:app.f.managed.lyrics,
    original:true,acceptedPolicy:CATALOG_OWNER_POLICY_VERSION,rating:'general',terms:{revision:1,allowsDerivatives},audioSha256:sha256(audio),audioBytes:audio.length}),
    {'content-type':'application/json','idempotency-key':`catalog-${index}-${encoding}-${crypto.randomUUID()}`});
  assert.equal(response.status,201,await response.clone().text());
  const {submissionId}=await response.json() as {submissionId:string};
  assert.equal((await session.write(`/api/uploads/${submissionId}/audio`,'PUT',audio,{'content-type':'audio/mpeg'})).status,200);
  for(const slot of ['instrumental','vocals']) {
    assert.equal((await session.write(`/api/uploads/${submissionId}/stems/${slot}`,'POST',JSON.stringify({sha256:sha256(audio),byteLength:audio.length}),{'content-type':'application/json'})).status,201);
    assert.equal((await session.write(`/api/uploads/${submissionId}/stems/${slot}`,'PUT',audio,{'content-type':'audio/mpeg'})).status,200);
  }
  const sealed=await session.write(`/api/uploads/${submissionId}/seal`,'POST','{}',{'content-type':'application/json'});
  assert.equal(sealed.status,202,await sealed.clone().text());
  const {jobId}=await sealed.json() as {jobId:string};
  const obligation=await catalogObligation(app.f.community.db,jobId);
  assert.equal(obligation.state,'pending');
  assert.equal((await loadJob(app.f.community.db,jobId)).phase,'catalog_reserve');
  return {jobId,submissionId,session,audio,app,intent:JSON.parse(obligation.intent_json)};
}
/** Real queue/cron entrypoints; no phase/ready seeding or bypassed validation. */
export async function drive(f:ReservationFixture,jobId:string,index=0,rounds=45) {
  const app=f.apps[index]!;
  for(let i=0;i<rounds;i++) {
    await f.recoverShared();for(let n=0;n<6&&f.wakes.length;n++)await f.deliverShared();
    app.f.posts.mine();
    await app.deliver(jobId);
    const job=await loadJob(app.f.community.db,jobId);
    if(['published','held','failed','blocked'].includes(job.phase))return job;
  }
  return loadJob(app.f.community.db,jobId);
}
export async function rows(db:D1Database,table:string) {
  assert.match(table,/^[a-z_]+$/);return (await db.withSession('first-primary').prepare(`SELECT * FROM ${table} ORDER BY rowid`).all<Record<string,unknown>>()).results;
}
