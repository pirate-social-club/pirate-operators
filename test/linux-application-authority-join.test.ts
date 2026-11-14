// Prepared/UNRUN. Exact selected reader/signature/current/lease guard protocols.
// Public local fixture keys and controlled loopback bytes are not native host facts.
import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {join} from "node:path";
import {fixture,gate,absent,waitFor,type Change} from "./linux-current-authority-fixture.ts";
import {createApplicationReadbackAuthority} from "../deploy/linux/application-readback-authority.ts";
import {runCurrentAuthorityCommand} from "../deploy/linux/backend-command.ts";

type Phase="original"|"current";
async function withdraw(t:TestContext,phase:Phase,change:Change|"namespace"){
 const now=1_800_000_000_000;
 t.mock.timers.enable({apis:["Date"],now});
 const f=await fixture(),entered=gate(),release=gate();
 let armed=false,fired=false,work:Promise<unknown>|undefined;
 const current=await f.authority.current(f.record.body),captured=f.record.body;
 if(change==="namespace")f.proof.expiresAt=now+1000;
 const pause=async()=>{if(armed && !fired){fired=true;entered.resolve();await release.promise;}};
 const authorize=createApplicationReadbackAuthority({captured,capturedCurrent:current,signal:f.signal,
  original:async()=>{const actual=(await f.authority.admitCurrent(f.record,f.proof)).original;
    if(phase==="original")await pause();return actual;},
  current:async original=>{const actual=await f.authority.current(original);
    if(phase==="current")await pause();return actual;},
  assertCurrent:f.assertCurrent});
 const name="application-join-"+phase+"-"+change,marker=join(f.root,name+"-effect");
 try{
  await authorize();armed=true;
  work=runCurrentAuthorityCommand(f.input(name,f.effectArgs(marker)),authorize);void work.catch(()=>{});
  await waitFor(async()=>fired);await entered.promise;
  if(change==="namespace")t.mock.timers.setTime(now+2000);else await f.change(change);
  release.resolve();
  await assert.rejects(work,change==="namespace"?/namespace_binding_required/:change==="cancel"?/native_readback_cancelled/:f.expected(change));
  assert(await absent(marker));assert.equal(await f.launchCount(name),0);
  if(change==="namespace"){
   assert(f.policy.expiresAt>Date.now() && f.plan.expiresAt>Date.now());
   await f.authority.current(f.record.body); // real policy is still valid
  }
 }finally{release.resolve();await Promise.allSettled(work?[work]:[]);await f.close();t.mock.timers.reset();}
}
test("joined actual application original-profile await cannot dispatch after revocation",{timeout:20000},t=>withdraw(t,"original","revoke"));
test("joined actual application original-profile await cannot dispatch after expiry",{timeout:20000},t=>withdraw(t,"original","expire"));
test("joined actual application original-profile await cannot dispatch after cancellation",{timeout:20000},t=>withdraw(t,"original","cancel"));
test("joined actual application signed-current preparation cannot dispatch after revocation",{timeout:20000},t=>withdraw(t,"current","revoke"));
test("joined actual application signed-current preparation cannot dispatch after expiry",{timeout:20000},t=>withdraw(t,"current","expire"));
test("joined actual application signed-current preparation cannot dispatch after cancellation",{timeout:20000},t=>withdraw(t,"current","cancel"));
test("joined actual application preparation cannot reuse a genuinely expired namespace under a live policy",{timeout:20000},t=>withdraw(t,"current","namespace"));
test("joined unchanged signed application preparation reaches the actual current guard",{timeout:20000},async()=>{
 const f=await fixture();
 try{
  const capturedCurrent=await f.authority.current(f.record.body);let finalCalls=0;
  const authorize=createApplicationReadbackAuthority({captured:f.record.body,capturedCurrent,signal:f.signal,
   original:async()=>(await f.authority.admitCurrent(f.record,f.proof)).original,
   current:original=>f.authority.current(original),
   assertCurrent:async()=>{await f.assertCurrent();finalCalls++;}});
  await authorize();assert.equal(finalCalls,1);
 }finally{await f.close();}
});
test("actual shared reader consumes exact selected original CID and configuration bytes over local transport",{timeout:20000},async()=>{
 const f=await fixture();
 try{
  const begin=f.reader.requests.length;
  const value=await f.reader.shared.read(f.record.body.profile,f.lease,f.signal);
  assert.deepEqual(value.configuration,f.record.body.profile.infrastructure.configuration);
  const seen=f.reader.requests.slice(begin);assert(seen.length>0,"configured_transport_must_really_run");
  for(const row of seen){
   assert.equal(row.method,"GET");
   const original=f.reader.expectedRecords.find(r=>r.path===row.path);assert(original,"unexpected_configuration_CID");
   assert.equal(row.sha256,original.sha256);assert.equal(row.bytes,original.bytes);
  }
  assert(f.reader.expectedRecords.every(r=>seen.some(x=>x.path===r.path)));
 }finally{await f.close();}
});
test("actual shared reader refuses corrupted local configuration bytes without completing readback evidence",{timeout:20000},async()=>{
 const f=await fixture();
 try{
  let completed=0;const begin=f.reader.requests.length;f.reader.corruptContent();
  await assert.rejects(async()=>{
   await f.reader.shared.read(f.record.body.profile,f.lease,f.signal);completed++;
  },error=>{assert(error instanceof Error && "code" in error);assert.equal(error.code,"public_ipfs_unavailable");return true;});
  assert(f.reader.requests.length>begin,"digest_failure_must_follow_actual_local_transport");
  assert.equal(completed,0);
 }finally{await f.close();}
});
