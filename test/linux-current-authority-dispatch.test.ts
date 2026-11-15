// Prepared protocol regressions, UNRUN. These SAME six assertions now invoke
// the actual extracted production guard, including its post-admission awaits.
import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {runCurrentAuthorityCommand} from "../deploy/linux/backend-command.ts";
import {createManagedKeyClient,startManagedKeyAgent} from "../deploy/linux/managed-key-channel.ts";
import {fixture,gate,absent,waitFor,type Change} from "./linux-current-authority-fixture.ts";
async function afterKey(change:Change){
 const f=await fixture(),entered=gate(),release=gate(),auth=randomBytes(32),secret=randomBytes(32);
 let agent:Awaited<ReturnType<typeof startManagedKeyAgent>>|undefined;
 let client:Awaited<ReturnType<typeof createManagedKeyClient>>|undefined;
 let work:Promise<unknown>|undefined;let ready=false;
 const marker=join(f.root,"initialization-effect");
 try{
  const signing=join(f.root,"agent","profile-key"),secretFile=join(f.root,"agent","fixture-key");
  await writeFile(signing,f.key,{mode:0o600,flag:"wx"});await writeFile(secretFile,secret,{mode:0o600,flag:"wx"});
  const pausedLease={...f.lease,async assertHeld(){
   await f.lease.assertHeld();if(!ready){ready=true;entered.resolve();await release.promise;}
  }};
  const socket=join(f.root,"agent","keys.sock");
  agent=await startManagedKeyAgent({socket,directory:join(f.root,"agent"),installationId:f.installationId,
   authenticationKey:auth,lease:pausedLease,keys:[{ref:"public-fixture",generation:1,path:secretFile,bytes:32}],
   signingKeyFile:signing,trust:f.trust,permittedProfileDigests:new Set(),capturedRoots:[join(f.root,"configuration")]});
  client=await createManagedKeyClient({socket,installationId:f.installationId,authenticationKey:auth,lease:f.lease});
  work=client.withKey("public-fixture",1,async bytes=>{
   assert.deepEqual(bytes,secret);
   // The actual same guarded runner used for native initialization must refuse.
   return runCurrentAuthorityCommand(f.input("later-initialize",f.effectArgs(marker)),f.assertCurrent);
  });
  void work.catch(()=>{});
  await waitFor(async()=>ready);await entered.promise;await f.change(change);release.resolve();
  await assert.rejects(work,f.expected(change));
  assert(await absent(marker),"no_initialization_after_invalid_deferred_key");
  assert.equal(await f.launchCount("later-initialize"),0,"zero_real_initialization_launch_records");
 }finally{release.resolve();await Promise.allSettled(work?[work]:[]);client?.dispose();await agent?.close();
  auth.fill(0);secret.fill(0);await f.close();}
}
async function afterInitializer(change:Change){
 const f=await fixture(),entered=join(f.root,"initializer-entered"),release=join(f.root,"initializer-release");
 let running:Promise<unknown>|undefined;
 try{
  const script='const fs=require("node:fs");const [entered,release]=process.argv.slice(1);'+
   'fs.writeFileSync(entered,"entered",{flag:"wx",mode:384});const end=Date.now()+6000;'+
   'function poll(){if(fs.existsSync(release))return process.exit(0);if(Date.now()>=end)return process.exit(19);setTimeout(poll,10)}poll()';
  running=runCurrentAuthorityCommand(f.input("actual-initializer",["--input-type=commonjs","-e",script,entered,release]),f.assertCurrent);
  void running.catch(()=>{});
  await waitFor(async()=>!await absent(entered));
  // The child stays running at its real await boundary. The initializer is
  // allowed to finish, but neither later create nor start may launch.
  await f.change(change);
  await writeFile(release,"release",{mode:0o600,flag:"wx"});
  if(change==="cancel")await assert.rejects(running,/backend_command_failed_or_custody_uncertain/);
  else await running; // Genuine owned raw zero status, not a substituted result.
  for(const phase of ["create","start"]){
   const marker=join(f.root,phase+"-effect");
   await assert.rejects(runCurrentAuthorityCommand(f.input("later-"+phase,f.effectArgs(marker)),f.assertCurrent),f.expected(change));
   assert(await absent(marker),"zero_subsequent_"+phase+"_effects");
   assert.equal(await f.launchCount("later-"+phase),0,"zero_real_"+phase+"_launch_records");
  }
 }finally{f.controller.abort();await Promise.allSettled(running?[running]:[]);await f.close();}
 // Complete raw stdout/stderr, real original lease and any failure are retained.
}
test("current authority revoked while actual key acquisition is suspended prevents initialization",{timeout:20000},()=>afterKey("revoke"));
test("current authority expired while actual key acquisition is suspended prevents initialization",{timeout:20000},()=>afterKey("expire"));
test("cancellation while actual key acquisition is suspended prevents initialization",{timeout:20000},()=>afterKey("cancel"));
test("revocation during actual owned initializer await prevents later create and start",{timeout:20000},()=>afterInitializer("revoke"));
test("expiry during actual owned initializer await prevents later create and start",{timeout:20000},()=>afterInitializer("expire"));
test("cancellation during actual owned initializer await prevents later create and start",{timeout:20000},()=>afterInitializer("cancel"));
