// Failure plan BEFORE production gate code: a stale async precheck can permit
// spending after revocation; replacing the owner-window condition can replenish
// or bypass the old window; eager suppliers strand authenticated replays; a
// post-response refusal does not prevent a paid provider effect. These exercise
// actual HTTP handlers, D1 transactions and the retained local authority fixture.
import test from "node:test";
import assert from "node:assert/strict";
import {web2FirstSongFixture} from "./fixtures/web2-first-song.ts";

for(const boundary of ["reservation","dispatch"] as const) test(`managed ${boundary} admission fences the actual paid HTTP boundary`,{timeout:180000},async(t)=>{
  const f=await web2FirstSongFixture({http:true,authorizationVersion:2,managedGate:true});t.after(f.close);
  const owner=await f.login();f.managedAdmission.arm(boundary,"songs");
  const song=await f.publish(owner,{stopWhenHeld:true});
  assert.equal(f.managedAdmission.revoked,true);
  assert.equal(f.effects.pinAdds,0);assert.equal(f.effects.broadcasts,0);
  const reservations=await f.managedReservations();
  if(boundary==="reservation") assert.equal(reservations.length,0);
  else assert(reservations.length>0,"prior authorized reservations are retained");
  await f.writeRecoveryArtifact(`gate-${boundary}`,{calls:f.managedAdmission.calls,reservations,effects:f.effects,jobId:song.jobId});
});

test("fresh managed health is scoped to the exact community and grant and is not an admission substitute",async(t)=>{
  const f=await web2FirstSongFixture({http:true,authorizationVersion:2,managedGate:true});t.after(f.close);
  assert.equal((await f.managedHealth()).status,200);
  assert.equal((await f.managedHealth({community:"0x"+"aa".repeat(32)})).status,403);
  assert.equal((await f.managedHealth({grant:"0x"+"bb".repeat(32)})).status,403);
  const owner=await f.login();assert.equal(owner.session.publisher,true);
  assert.equal((await f.reserve(owner)).status,201);
  assert(f.healthRequests.some(r=>r.community===f.communityId && r.grant===f.ownerGrantDigest));
  await f.managedAdmission.revoke();
  const response=await f.reserve(owner);
  // Upload eligibility does not itself purchase managed service. The first
  // managed reservation/dispatch must still deny a revoked admitted profile.
  assert.equal(response.status,201);
  assert.equal((await f.managedHealth()).status,200);
  assert.equal(f.effects.pinAdds,0);
  await f.writeRecoveryArtifact("scoped-health",{healthRequests:f.healthRequests,effects:f.effects});
});

test("lazy admission condition commits with the original owner window and replay bypasses neither identity nor receipts",async(t)=>{
  const {Miniflare}=await import("miniflare");const {migrateOwnerDatabase}=await import("./owner-publishing-migration-fixture.ts");
  const {managedMigrations}=await import("../harness/package-migrations.ts");
  const {ownerGrantDigest,validateOwnerGrant,reserveOwnerBudget,settleOwnerBudget}=await import("../packages/release/owner-grant.ts");
  const {UNREGISTERED_OWNER_POLICY_VERSION,UNREGISTERED_OWNER_POLICY_HASH}=await import("../packages/community/owner-policy.ts");
  const {hashText}=await import("../packages/community/common.ts");
  const {managedAdmissionFixture}=await import("./fixtures/managed-admission-gate.ts");
  const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('fixture')}}",compatibilityDate:"2026-08-06",d1Databases:["DB"]});t.after(()=>mf.dispose());
  const db=await mf.getD1Database("DB");await migrateOwnerDatabase(db,managedMigrations(true).map(n=>"apps/managed-moderation/migrations/"+n));
  const now=Math.floor(Date.now()/1000),scope={schema:"pirate.owner-publishing-grant/1" as const,communityId:hashText("atomic managed gate"),communityOrigin:"https://community.example",ownerWallet:"0x"+"22".repeat(20),
    policy:{version:UNREGISTERED_OWNER_POLICY_VERSION,sha256:UNREGISTERED_OWNER_POLICY_HASH},destination:{chainId:6343,postsContract:"0x"+"33".repeat(20),publisher:"0x"+"44".repeat(20)},
    validFrom:now-60,expiresAt:now+5,limits:{songs:3,pinAdds:9,pinBytes:"4096",recognitionRequests:5,postFeeWei:"10000"}};
  const grant=validateOwnerGrant({...scope,sha256:ownerGrantDigest(scope as never)}),authority=await managedAdmissionFixture(db as unknown as D1Database,grant),requestHash=hashText("same original request");
  authority.arm("reservation","songs");
  await assert.rejects(reserveOwnerBudget(db as unknown as D1Database,grant,"songs","revoked-original",requestHash,"1",undefined,
    ()=>authority.gate.reservationCondition(grant,{operationId:"revoked-original",requestHash,asset:"songs",requested:"1"})),/managed_admission_not_current/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM spending_reservations").first<{n:number}>())!.n,0);
  await db.prepare("UPDATE fixture_managed_admission SET active=1,revision=1").run();
  // Changing the old owner-window original during the lazy authority await
  // must also refuse, even though the new authority condition itself is true.
  await assert.rejects(reserveOwnerBudget(db as unknown as D1Database,grant,"songs","changed-window",requestHash,"1",undefined,async()=>{
    const condition=await authority.gate.reservationCondition(grant,{operationId:"changed-window",requestHash,asset:"songs",requested:"1"});
    await db.prepare("UPDATE owner_budget_windows SET valid_from=valid_from-1").run();
    return condition;
  }),/managed_admission_not_current/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM spending_reservations").first<{n:number}>())!.n,0);
  await db.prepare("UPDATE owner_budget_windows SET valid_from=?").bind(grant.validFrom).run();
  let calls=0;
  await reserveOwnerBudget(db as unknown as D1Database,grant,"songs","paid-original",requestHash,"1",undefined,async()=>{calls++;return authority.gate.reservationCondition(grant,{operationId:"paid-original",requestHash,asset:"songs",requested:"1"});});
  await authority.revoke();await new Promise(resolve=>setTimeout(resolve,Math.max(0,grant.expiresAt*1000-Date.now()+30)));
  await reserveOwnerBudget(db as unknown as D1Database,grant,"songs","paid-original",requestHash,"1",undefined,async()=>{throw Error("replay must not ask for new admission");});
  await settleOwnerBudget(db as unknown as D1Database,grant,"songs","paid-original","1");
  assert.equal(calls,1);
  await assert.rejects(reserveOwnerBudget(db as unknown as D1Database,grant,"songs","paid-original",hashText("changed request"),"1"),/reservation_conflict/);
  await assert.rejects(reserveOwnerBudget(db as unknown as D1Database,grant,"songs","fresh-after-expiry",requestHash,"1"),/owner_grant_outside_window/);
  const {mkdir,writeFile}=await import("node:fs/promises");
  await mkdir(".local/web2-owner-signing-implementation/completion/recovery",{recursive:true});
  await writeFile(`.local/web2-owner-signing-implementation/completion/recovery/atomic-managed-gate-${Date.now()}.json`,JSON.stringify({grantDigest:grant.sha256,requestHash,calls,reservations:(await db.prepare("SELECT * FROM spending_reservations").all()).results},null,2));
});
