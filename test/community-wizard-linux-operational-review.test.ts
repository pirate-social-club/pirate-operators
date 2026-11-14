// UNRUN model/controller tests only. Genuine native positive is separately
// registered by linux-genuine-factory-acceptance with actual installed inputs.
import test from "node:test";
import assert from "node:assert/strict";
import {sameOperationalSelection,operationActionMatches} from "../packages/community-setup/operational-selection.ts";
import {retainedReview} from "../deploy/linux/retained-review.ts";
import {digestJson} from "../apps/community-wizard/server/linux-journal.ts";
import {linuxFixture,fixtureProfile,fixtureCiphertext,fixtureKey} from "./community-wizard-linux-fixture.ts";
test("signed original profile remains byte-identical across restore operation and explicit destination/policy selection",()=>{
 const profile=fixtureProfile(),before=JSON.stringify(profile);
 const selected={...profile.settings,mode:"restore" as const,target:{kind:"ssh-linux" as const,host:"second.example",port:22,user:"operator",connectionRef:"ssh:owned"}};
 assert.ok(sameOperationalSelection(profile.settings,selected,selected.recovery.sessionPolicy));
 assert.equal(JSON.stringify(profile),before);
 assert.equal(sameOperationalSelection(profile.settings,{...selected,origin:"https://other.example"},selected.recovery.sessionPolicy),false);
 assert.equal(sameOperationalSelection(profile.settings,{...selected,name:"Rebound"},selected.recovery.sessionPolicy),false);
 assert.ok(operationActionMatches("restore","restore"));assert.equal(operationActionMatches("create","restore"),false);
});
test("actual controller captures restore kind while backend retains original signed profile mode",async(t)=>{
 const f=await linuxFixture();t.after(f.dispose);
 await f.setup.destination({revision:0,mode:"restore",target:{kind:"local-linux"}});
 await f.setup.inspect();async function* bytes(){yield fixtureCiphertext;}
 await f.setup.stageBackup(bytes(),fixtureCiphertext.length);await f.setup.inspectBackup({recoveryKey:fixtureKey});await f.setup.namespace();
 const prepare=f.backend.prepare,original=structuredClone(f.facts.restoreProfile),originalBytes=JSON.stringify(original);
 f.backend.prepare=async input=>{
  const plan=await prepare(input),profile=structuredClone(original),profileDigest=digestJson(profile);
  const {digest,...body}=plan;
  const selected={...body,profile,profileDigest,backend:{...plan.backend,release:{...plan.backend.release,selectedProfileDigest:profileDigest}}};
  return {...selected,digest:digestJson(selected)};
 };
 await f.setup.review();const plan=f.setup.snapshot().plan!;
 await f.setup.deploy({revision:f.setup.snapshot().revision,planDigest:plan.digest,targetFingerprint:plan.targetFingerprint,approved:true});
 await f.setup.settled();
 assert.equal(f.setup.snapshot().operation?.kind,"restore");assert.equal(f.setup.snapshot().operation?.intent?.kind,"restore");
 assert.equal(f.setup.snapshot().operation?.plan.profile.settings.mode,original.settings.mode);
 assert.equal(JSON.stringify(original),originalBytes);
 assert.equal((await f.open()).snapshot().operation?.kind,"restore");
});
test("retained successor model rejects forged predecessor, unknown native outcome and changed original resources",async(t)=>{
 const f=await linuxFixture();t.after(f.dispose);await f.configure();await f.review();await f.deploy();await f.setup.settled();
 const state=f.setup.snapshot().operation!;
 const requested={id:state.id,kind:state.kind,draftRevision:state.draftRevision,plan:state.plan,startedAt:state.startedAt};
 const result=f.result(state.id),stored={operation:structuredClone(requested),bound:state.intent!};
 const input={requested,stored,result,retainedIdentity:state.plan.profile.identity,sourceDigest:state.plan.profile.runtime.sourceDigest,
  artifactDigest:state.plan.profile.runtime.artifactDigest,fingerprint:state.plan.targetFingerprint};
 assert.deepEqual(retainedReview(input),requested);
 assert.throws(()=>retainedReview({...input,requested:{...requested,id:"forged"}}),/original_server/);
 assert.throws(()=>retainedReview({...input,result:{...result,outcome:"custody-uncertain"}}),/effects_pending/);
 assert.throws(()=>retainedReview({...input,retainedIdentity:{...state.plan.profile.identity,communityId:"0x"+"ee".repeat(32)}}),/resource_identity/);
 assert.deepEqual(stored.operation,requested);assert.deepEqual(state.intent,stored.bound);
});

test("final namespace revalidation rejects an authority change during retained successor preparation without replacing original evidence",{timeout:5000},async(t)=>{
 const f=await linuxFixture();t.after(f.dispose);await f.configure();await f.review();await f.deploy();await f.setup.settled();
 const before=f.setup.snapshot(),original=JSON.stringify(before.operation),calls=f.facts.nativeIntents.length;
 let entered!:()=>void,release!:()=>void;
 const atPrepare=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r),prepare=f.backend.prepare;
 f.backend.prepare=async input=>{const plan=await prepare(input);entered();await hold;return plan;};
 t.after(()=>release?.());const reviewing=f.setup.review();await atPrepare;f.facts.authority="pending";release();
 await assert.rejects(reviewing,/authority|namespace|rights/i);
 assert.equal(JSON.stringify(f.setup.snapshot().operation),original);
 assert.equal(f.facts.nativeIntents.length,calls);assert.deepEqual(f.setup.snapshot().plan,before.plan);
 assert.equal(JSON.stringify((await f.open()).snapshot().operation),original);
});
