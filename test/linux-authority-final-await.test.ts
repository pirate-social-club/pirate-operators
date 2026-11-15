// UNRUN protocol regressions for the ACTUAL owning production guard and
// release functions. Signed/loopback fixtures are explicit protocol inputs;
// these cases do not qualify installed native/application or backend readiness.
import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {mkdir,writeFile,readFile,rename,lstat} from "node:fs/promises";
import {join,dirname} from "node:path";
import {fixture,gate,absent,waitFor,type GuardDeferral} from "./linux-current-authority-fixture.ts";
import {runCurrentAuthorityCommand} from "../deploy/linux/backend-command.ts";
import {releaseOwnedMaintenance} from "../deploy/linux/maintenance-release.ts";
import {releaseRestoredFences} from "../deploy/linux/restored-fence-release.ts";
import {canonicalDigest,signRecord,type TrustAnchor} from "../deploy/linux/installed-records.ts";
import type {WholeClearance} from "../deploy/linux/independent-clearance.ts";

async function namespaceExpires(t:TestContext,phase:GuardDeferral["phase"]){
 const now=1_800_000_000_000;
 t.mock.timers.enable({apis:["Date"],now});
 const d:GuardDeferral={phase,armed:false,admitted:false,fired:false,entered:gate(),release:gate()};
 const f=await fixture({defer:d,namespaceLifetimeMillis:1000});
 let work:Promise<unknown>|undefined;
 const name=phase==="post-admission-lease"?"ns-post-lease":"ns-final-current",marker=join(f.root,name+"-effect");
 try{
  d.armed=true;d.admitted=false;
  work=runCurrentAuthorityCommand(f.input(name,f.effectArgs(marker)),f.assertCurrent);void work.catch(()=>{});
  await waitFor(async()=>d.fired);await d.entered.promise;
  const admitted=f.admission();assert(admitted);
  assert.equal(admitted.namespace.expiresAt,now+1000);
  assert(admitted.namespace.expiresAt<f.proof.expiresAt && admitted.namespace.expiresAt<f.plan.expiresAt &&
    admitted.namespace.expiresAt<f.policy.expiresAt,"actual_proof_is_shorter_than_stored_limits");
  t.mock.timers.setTime(now+2000);d.release.resolve();
  await assert.rejects(work,/namespace_expired_before_effects/);
  assert(f.plan.expiresAt>Date.now() && f.proof.expiresAt>Date.now() && f.policy.expiresAt>Date.now());
  // The real final signed-current producer still permits the original: only
  // the ACTUAL just-revalidated namespace expired at the suspended boundary.
  d.armed=false;await f.authority.current(f.record.body);
  assert(await absent(marker));assert.equal(await f.launchCount(name),0);
 }finally{d.release.resolve();await Promise.allSettled(work?[work]:[]);await f.close();t.mock.timers.reset();}
}

type Family="maintenance"|"restored";
async function fenceFixture(f:Awaited<ReturnType<typeof fixture>>,family:Family){
 const directory=join(f.root,family+"-state");await mkdir(directory,{mode:0o700});
 const target=join(f.root,"restore-target"),role="configuration";
 if(family==="restored"){await mkdir(target,{mode:0o700});await mkdir(join(target,role),{mode:0o700});}
 const path=family==="maintenance"?join(directory,"maintenance-guard.json"):join(target,role,"restore-fence.json");
 const archiveSha256="a".repeat(64),manifestSha256="b".repeat(64);
 const row=family==="maintenance"?{installationId:f.installationId,operationId:f.lease.operationId,
  intent:f.lease.intentRef,holder:f.lease.holder}:
  {schema:"pirate.restore-fence/1",archiveSha256,manifestSha256,identity:f.record.body.profile.identity};
 const bytes=Buffer.from(JSON.stringify(row)+"\n");await writeFile(path,bytes,{mode:0o600,flag:"wx"});
 const pair=generateKeyPairSync("ed25519"),key=pair.privateKey.export({format:"der",type:"pkcs8"});
 const trust:TrustAnchor={keyId:"public-protocol-independent",spki:pair.publicKey.export({format:"der",type:"spki"}).toString("base64")};
 assert.notEqual(trust.spki,f.trust.spki);
 const active=JSON.parse(await readFile(join(f.lease.directory,"active-operation.json"),"utf8"));
 const body:WholeClearance={installationId:f.installationId,operationId:f.lease.operationId,intentDigest:active.intentDigest,
  profileDigest:f.record.body.profileDigest,generation:1,expiresAt:Date.now()+30000,
  observerHostPidNamespace:f.lease.holder.pidNamespace,observerNetworkNamespace:f.lease.holder.networkNamespace,
  ownedUnionDigest:canonicalDigest({protocolLease:f.lease.holder}),unknowns:[],liveUnintended:[],
  resources:f.record.body.profile.identity.resources,domainReadbacksSha256:"c".repeat(64),postguardSha256:"d".repeat(64)};
 // This separately signed public TEST proof exercises strict consumer protocol.
 // It is not an independently observed full production host/domain clearance.
 const proofPath=join(f.root,"clearance.json");
 await writeFile(proofPath,JSON.stringify(signRecord(body,trust,key))+"\n",{mode:0o600,flag:"wx"});
 const entered=gate(),release=gate();let calls=0,armed=false,paused=false;
 const clearanceLease={...f.lease,async assertHeld(){
  await f.lease.assertHeld();
  if(armed && ++calls===2){paused=true;entered.resolve();await release.promise;}
 }};
 const clearance={path:proofPath,trust,lease:clearanceLease,profileDigest:body.profileDigest,generation:1,
  resources:body.resources,domainReadbacksSha256:body.domainReadbacksSha256,postguardSha256:body.postguardSha256};
 return {path,bytes,entered,release,paused:()=>paused,arm(){armed=true;calls=0;},
  run(){return family==="maintenance"?releaseOwnedMaintenance({directory,lease:f.lease,clearance,signal:f.signal,assertCurrent:f.assertCurrent}):
   releaseRestoredFences({target,roles:[role],archiveSha256,manifestSha256,lease:f.lease,clearance,signal:f.signal,assertCurrent:f.assertCurrent});},
  close(){release.resolve();key.fill(0);}};
}
async function withdrawDuringClearance(family:Family,change:"revoke"|"expire"){
 const f=await fixture(),c=await fenceFixture(f,family);let work:Promise<unknown>|undefined;
 try{
  c.arm();work=c.run();void work.catch(()=>{});
  await waitFor(async()=>c.paused());await c.entered.promise;await f.change(change);c.release.resolve();
  await assert.rejects(work,f.expected(change));
  assert.deepEqual(await readFile(c.path),c.bytes,"fence_must_remain_after_withdrawal");
 }finally{c.release.resolve();await Promise.allSettled(work?[work]:[]);c.close();await f.close();}
}
async function identityChangedDuringPreparation(family:Family){
 const f=await fixture(),c=await fenceFixture(f,family);let work:Promise<unknown>|undefined;
 try{
  const before=await lstat(c.path);c.arm();work=c.run();void work.catch(()=>{});
  await waitFor(async()=>c.paused());await c.entered.promise;
  if(family==="maintenance"){
   await rename(c.path,c.path+".original");await writeFile(c.path,c.bytes,{mode:0o600,flag:"wx"});
  }else{
   const parent=dirname(c.path);await rename(parent,parent+".original");await mkdir(parent,{mode:0o700});
   await writeFile(c.path,c.bytes,{mode:0o600,flag:"wx"});
  }
  c.release.resolve();
  await assert.rejects(work,/original_fence_changed|fence_parent_changed/);
  assert.deepEqual(await readFile(c.path),c.bytes,"foreign_replacement_must_not_be_removed");
  const original=family==="maintenance"?c.path+".original":join(dirname(c.path)+".original","restore-fence.json");
  const retained=await lstat(original);
  assert.equal(retained.dev,before.dev);assert.equal(retained.ino,before.ino);
  assert.deepEqual(await readFile(original),c.bytes);
 }finally{c.release.resolve();await Promise.allSettled(work?[work]:[]);c.close();await f.close();}
}
async function validProtocolRelease(family:Family){
 const f=await fixture(),c=await fenceFixture(f,family);
 try{await c.run();assert(await absent(c.path));await f.lease.assertHeld();}
 finally{c.close();await f.close();}
 // A valid protocol removal is not complete native resource/domain acceptance.
}
test("actual production guard rejects short fresh namespace expiry during post-admission operation lease await",{timeout:20000},t=>namespaceExpires(t,"post-admission-lease"));
test("actual production guard rejects short fresh namespace expiry during its final signed-current await",{timeout:20000},t=>namespaceExpires(t,"signed-current"));
test("maintenance fence remains when signed current authority is revoked during clearance preparation",{timeout:20000},()=>withdrawDuringClearance("maintenance","revoke"));
test("maintenance fence remains when signed current authority expires during clearance preparation",{timeout:20000},()=>withdrawDuringClearance("maintenance","expire"));
test("restored fence remains when signed current authority is revoked during clearance preparation",{timeout:20000},()=>withdrawDuringClearance("restored","revoke"));
test("restored fence remains when signed current authority expires during clearance preparation",{timeout:20000},()=>withdrawDuringClearance("restored","expire"));
test("final synchronous maintenance identity check preserves original and replacement fence",{timeout:20000},()=>identityChangedDuringPreparation("maintenance"));
test("final synchronous restored parent check preserves renamed and replacement directories",{timeout:20000},()=>identityChangedDuringPreparation("restored"));
test("current signed protocol permits actual maintenance removal and leaves the original lease held",{timeout:20000},()=>validProtocolRelease("maintenance"));
test("current signed protocol permits actual restored fence removal and leaves the original lease held",{timeout:20000},()=>validProtocolRelease("restored"));
