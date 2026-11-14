// UNRUN: actual authenticated HTTP/controller/private journal with controlled
// ports; no native, provider, browser or real authority qualification.
import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {createWizardServer} from "../apps/community-wizard/server/http.ts";
import {LinuxInputError,record,text} from "../packages/community-setup/shared-linux-profile.ts";
import {linuxFixture,fixtureProfile,fixtureCiphertext,deferred} from "./community-wizard-linux-fixture.ts";
import {selectionKey,namespaceChallengeMessage,type NamespaceChallenge} from "../packages/community-names/namespace-import.ts";
import {fixtureHash} from "./community-wizard-linux-fixture.ts";
import type {Hex} from "viem";
function challenge(p=fixtureProfile()):NamespaceChallenge {
  const selection={...p.infrastructure.binding,principalId:"fixture-operator"};
  const body={id:fixtureHash("admission-challenge") as Hex,selectionKey:selectionKey(selection),selection,
    purpose:"bind_community_namespace" as const,authorityId:fixtureHash("authority") as Hex,
    issuedAt:2_000_000_000,expiresAt:2_000_000_030,grantExpiresAt:2_000_000_060,policyId:"fixture-policy"};
  return {...body,message:namespaceChallengeMessage(body)};
}
async function* ciphertext(){yield fixtureCiphertext;}
test("authenticated empty namespace begin refuses inside queued admission with zero Naming I/O and unchanged journal",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);let calls=0;
  f.naming.assertWritable=()=>{calls++;};f.naming.begin=async()=>{calls++;return challenge();};
  const server=createWizardServer(undefined,"/unused-fixture-dist",{infisical:false,cloudflare:false},{
    linux:f.setup,authorizeLinux:async req=>{if(req.headers.cookie!=="fixture_operator=paired")throw new LinuxInputError("operator_pairing_required","Pair this operator.");}});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
  const address=server.address();assert.ok(address&&typeof address!=="string");const origin="http://127.0.0.1:"+address.port;
  const headers={cookie:"fixture_operator=paired"};
  const view=record(await (await fetch(origin+"/api/linux/state",{headers})).json());
  const before=f.setup.snapshot(), path=join(f.directory,"linux-setup-v2.json");
  const disk=await readFile(path,"utf8").catch(e=>{if(e.code==="ENOENT")return null;throw e;});
  const response=await fetch(origin+"/api/linux/namespace/begin",{method:"POST",headers:{...headers,origin,"content-type":"application/json","x-wizard-token":text(view.csrf,64)},body:"{}"});
  assert.equal(response.status,409);assert.match(text(record(await response.json()).error,4096),/Save.*settings/);
  assert.equal(calls,0);assert.deepEqual(f.setup.snapshot(),before);
  assert.equal(await readFile(path,"utf8").catch(e=>{if(e.code==="ENOENT")return null;throw e;}),disk);
  assert.deepEqual((await f.open()).snapshot(),before);
});
test("held restore Naming fences a fresh upload without consuming ciphertext or changing revision; completion and restart remain valid",async(t)=>{
  const f=await linuxFixture({timeoutMs:1000});t.after(f.dispose);
  await f.configure({...f.draft,mode:"restore"});
  const gate=deferred<NamespaceChallenge>(),entered=deferred<void>();let uploads=0,consumed=0;
  f.naming.begin=async()=>{entered.resolve();return gate.promise;};
  const original=f.setup.namespaceBegin();await entered.promise;
  const marker=f.setup.snapshot().namespaceRequest!, revision=f.setup.snapshot().revision, disk=await f.disk();
  const stage=f.backend.stageBackup;f.backend.stageBackup=async input=>{uploads++;return stage(input);};
  async function* bytes(){consumed++;yield fixtureCiphertext;}
  await assert.rejects(f.setup.stageBackup(bytes(),fixtureCiphertext.length),/namespace|original/);
  assert.equal(uploads,0);assert.equal(consumed,0);assert.equal(f.setup.snapshot().revision,revision);
  assert.deepEqual(f.setup.snapshot().namespaceRequest,marker);assert.equal(await f.disk(),disk);
  assert.deepEqual((await f.open()).snapshot().namespaceRequest,marker,"Pending state is already restartable");
  gate.resolve(challenge(fixtureProfile({...f.draft,mode:"restore"})));await original;
  const resumed=await f.open();assert.equal(resumed.snapshot().namespaceRequest,null);
  assert.equal(resumed.snapshot().namespaceHistory.at(-1)?.requestId,marker.id);assert.equal(resumed.snapshot().revision,revision);
  await resumed.stageBackup(ciphertext(),fixtureCiphertext.length);assert.equal(uploads,1);
  assert.equal(f.facts.nativeIntents.length,0);
});
test("an original lost upload keeps its exact request and immutable byte receipt when resumed",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure({...f.draft,mode:"restore"});
  f.facts.lostUpload=true;await assert.rejects(f.setup.stageBackup(ciphertext(),fixtureCiphertext.length));
  const original=f.setup.snapshot().uploadRequest!, before=f.setup.snapshot().revision;let proofs=0;
  f.naming.begin=async()=>{proofs++;return challenge();};
  await assert.rejects(f.setup.namespaceBegin(),/Reconcile/);assert.equal(proofs,0);
  const resumed=await f.open();f.facts.lostUpload=false;
  const seen:string[]=[];const stage=f.backend.stageBackup;f.backend.stageBackup=async input=>{seen.push(input.requestId);return stage(input);};
  await resumed.stageBackup(ciphertext(),fixtureCiphertext.length);
  assert.deepEqual(seen,[original.id]);assert.equal(resumed.snapshot().uploadRequest,null);
  assert.equal(resumed.snapshot().revision,before+1);assert.equal(f.facts.nativeIntents.length,0);
});
