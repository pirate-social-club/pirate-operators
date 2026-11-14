// UNRUN: real controller/FS + result validator, controlled original-result port.
// No actual native/Storage producer, device, disk-space or readiness acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import {readFile,writeFile,lstat} from "node:fs/promises";
import {join} from "node:path";
import {createLinuxSetup} from "../apps/community-wizard/server/linux-setup.ts";
import {linuxFixture,fixtureProfile,fixtureHash,fixtureCiphertext} from "./community-wizard-linux-fixture.ts";
import {selectionKey,namespaceChallengeMessage,type NamespaceChallenge} from "../packages/community-names/namespace-import.ts";
import type {Hex} from "viem";
import {digestJson} from "../apps/community-wizard/server/linux-journal.ts";
import {RESULT_MAX_BYTES,INTENT_MAX_BYTES,JOURNAL_MAX_BYTES,JOURNAL_CAPACITY_POLICY,
  encodedBytes,reservedBytes,canReadNormally} from "../apps/community-wizard/server/linux-journal-capacity.ts";
import {resultFrom} from "../apps/community-wizard/server/linux-operator-boundary.ts";
import type {LinuxDeploymentPort,LinuxOperationResult} from "../apps/community-wizard/server/linux-contracts.ts";
function sizedResult(f:Awaited<ReturnType<typeof linuxFixture>>,id:string,bytes:number,tag:string) {
  const r=f.result(id);r.lastCompletedPhase=tag;
  // Exercise every full result byte, not a small terminal assumption. Native
  // process-rich profiles also remain subject to this whole-encoding bound.
  const padding=bytes-encodedBytes(r);assert.ok(padding>=0);
  r.lastCompletedPhase+= "r".repeat(padding);assert.equal(encodedBytes(r),bytes);
  return r;
}
test("near byte cap distinct pending results preserve the largest admitted terminal, survive interrupted observation/restart and refuse a new effect",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure();await f.review();
  const outcomes:LinuxOperationResult[]=[];let ordinary=0,terminalReads=0,observedTerminal=false;
  f.backend.operator.deploy=async intent=>{f.facts.nativeIntents.push(structuredClone(intent));const r=sizedResult(f,intent.operationId,440_000,"first");outcomes.push(r);return r;};
  f.backend.operator.reconcile=async request=>{ordinary++;const r=sizedResult(f,request.operationId,440_000,"pending:"+ordinary);outcomes.push(r);return r;};
  f.backend.observeResult=async ({operation})=>({state:"pending",custody:"held",revision:++f.facts.revision,receiptRef:"pending:"+operation.id,correction:"Controlled unresolved readback"});
  await f.deploy();await f.setup.settled();
  for(let i=0;i<8&&canReadNormally(f.setup.snapshot());i++)await f.setup.reconcile();
  assert.ok(outcomes.length>=2);assert.equal(canReadNormally(f.setup.snapshot()),false);
  const originalIntent=structuredClone(f.setup.snapshot().operation!.intent), hashes=outcomes.map(digestJson);
  // A valid private journal at the policy's upper budget, retaining every old
  // byte/value. This simulates other preserved metadata; no fake resource rows.
  const state=f.setup.snapshot();state.message="p".repeat(20_000);
  let free=JOURNAL_MAX_BYTES-encodedBytes(state)-reservedBytes(state)-1_024;
  assert.ok(free>0);state.message+="p".repeat(free);
  assert.ok(encodedBytes(state)+reservedBytes(state)<=JOURNAL_MAX_BYTES);
  await writeFile(join(f.directory,"linux-setup-v2.json"),JSON.stringify(state)+"\n");
  const resumed=await f.open(), op=resumed.snapshot().operation!;
  const full=sizedResult(f,op.id,RESULT_MAX_BYTES,"terminal");
  resultFrom(full,op);assert.equal(encodedBytes(full),RESULT_MAX_BYTES);
  f.backend.journalRecovery.terminal=async input=>{
    terminalReads++;assert.deepEqual(input.retainedIntent,originalIntent);assert.equal(input.operation.id,op.id);
    return {state:"result",result:full};
  };
  f.backend.observeResult=async ({result})=>{
    const stored=JSON.parse(await f.disk()).operation;
    assert.deepEqual(stored.results.map(digestJson),[...hashes,digestJson(full)]);
    assert.equal(stored.recoveryResultDigest,digestJson(result));observedTerminal=true;
    throw Error("Controlled interruption after terminal fsync");
  };
  const ordinaryBefore=ordinary;await resumed.reconcile();
  assert.equal(terminalReads,1);assert.equal(ordinary,ordinaryBefore);assert.equal(observedTerminal,true);
  assert.equal(resumed.snapshot().operation!.capacityPhase,"terminal");
  assert.deepEqual(resumed.snapshot().operation!.intent,originalIntent);
  const restarted=await f.open();
  f.backend.journalRecovery.terminal=async()=>{throw Error("The original terminal must not be fetched/replaced again");};
  f.backend.observeResult=async({operation,result})=>{assert.deepEqual(result,full);return f.success(operation);};
  await restarted.reconcile();
  assert.equal(restarted.snapshot().operation!.state,"succeeded");
  assert.deepEqual(restarted.snapshot().operation!.results.map(digestJson),[...hashes,digestJson(full)]);
  assert.deepEqual(restarted.snapshot().operation!.intent,originalIntent);
  assert.ok(Buffer.byteLength(await f.disk())<=JOURNAL_MAX_BYTES);
  let binds=0;const bind=f.backend.bindOperation;f.backend.bindOperation=async operation=>{binds++;return bind(operation);};
  await restarted.configure({revision:restarted.snapshot().revision,draft:{...f.draft,name:"Corrected name"}});
  await restarted.review();const approved=restarted.snapshot().plan!, before=await f.disk();
  await assert.rejects(restarted.deploy({revision:restarted.snapshot().revision,planDigest:approved.digest,targetFingerprint:approved.targetFingerprint,approved:true}),/Reserved|reserved|evidence|capacity/);
  assert.equal(binds,0);assert.equal(f.facts.nativeIntents.length,1);assert.equal(await f.disk(),before);
});
test("terminal-only pending is bounded and cannot fall back to another arbitrary result or reset original evidence",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure();await f.review();
  f.backend.observeResult=async({operation})=>({state:"pending",custody:"held",revision:++f.facts.revision,receiptRef:"pending:"+operation.id,correction:"Still unresolved"});
  await f.deploy();await f.setup.settled();
  const state=f.setup.snapshot();state.message="p".repeat(20_000);
  state.message+="p".repeat(JOURNAL_MAX_BYTES-encodedBytes(state)-reservedBytes(state)-1_024);
  await writeFile(join(f.directory,"linux-setup-v2.json"),JSON.stringify(state)+"\n");
  const resumed=await f.open();let reads=0,native=0;
  const before=resumed.snapshot().operation!;
  f.backend.operator.reconcile=async()=>{native++;throw Error("No ordinary fallback");};
  f.backend.journalRecovery.terminal=async({operation})=>{reads++;return {state:"pending",operationId:operation.id};};
  await resumed.reconcile();await resumed.reconcile();assert.equal(reads,2);assert.equal(native,0);
  assert.deepEqual(resumed.snapshot().operation,before);assert.equal(canReadNormally(resumed.snapshot()),false);
});
test("unsupported producers and historical full journals are refused unchanged; no implicit policy adoption",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);
  let calls=0;f.backend.bindOperation=async()=>{calls++;throw Error("Must not bind");};
  const missing={...f.backend,journalRecovery:undefined} as unknown as LinuxDeploymentPort;
  await assert.rejects(createLinuxSetup(f.directory,missing,f.naming),/actual.*producer|unavailable|legacy/i);
  const oversized={...f.backend,journalRecovery:{...f.backend.journalRecovery,resultMaxBytes:32*1024*1024}} as unknown as LinuxDeploymentPort;
  await assert.rejects(createLinuxSetup(f.directory,oversized,f.naming),/actual.*producer|unavailable|legacy/i);
  const old=f.setup.snapshot() as unknown as Record<string,unknown>;delete old.capacityPolicy;
  // Exact pre-capacity shared-v2 emptyJournal producer (retained W6 before).
  assert.deepEqual(old,{version:2,revision:0,draft:null,destination:null,target:null,namespace:null,imported:null,
    backupId:null,backupDigest:null,restore:null,plan:null,identity:null,requirements:[],secretRequest:null,
    uploadRequest:null,namespaceRequest:null,namespaceChallenge:null,namespaceHistory:[],operation:null,
    history:[],message:"Choose create, import or restore to begin."});
  old.message="h".repeat(JOURNAL_MAX_BYTES-encodedBytes(old)-128);
  const bytes=JSON.stringify(old)+"\n",path=join(f.directory,"linux-setup-v2.json");
  // This fixture has never saved a journal. Create the historical bytes as
  // an owned private original, so privacy validation reaches capacity cutover.
  await writeFile(path,bytes,{mode:0o600,flag:"wx"});
  const retained=await lstat(path);
  assert(retained.isFile() && !retained.isSymbolicLink() && retained.nlink===1);
  assert.equal(retained.uid,process.getuid!());assert.equal(retained.mode&0o777,0o600);
  assert(retained.size<=JOURNAL_MAX_BYTES);
  await assert.rejects(f.open(),/old journal|capacity|cutover/);
  await assert.rejects(f.open(),error=>{
    assert(error instanceof Error && "code" in error);
    assert.equal(error.code,"journal_capacity_upgrade_required");return true;
  });
  assert.equal(await readFile(path,"utf8"),bytes);assert.equal(calls,0);
});
test("encoding bounds cover complete results and intents rather than dropping evidence fields",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure();await f.review();await f.deploy();await f.setup.settled();
  const op=f.setup.snapshot().operation!;
  const full=sizedResult(f,op.id,RESULT_MAX_BYTES,"maximum");
  assert.deepEqual(resultFrom(full,op),full);
  const bigger=structuredClone(full);bigger.lastCompletedPhase+="x";assert.throws(()=>resultFrom(bigger,op),/exceeds|outcome/);
  assert.equal(RESULT_MAX_BYTES,524_288);assert.equal(INTENT_MAX_BYTES,262_144);assert.equal(JOURNAL_MAX_BYTES,2_097_152);
  assert.equal(f.setup.snapshot().capacityPolicy,JOURNAL_CAPACITY_POLICY);
});

function nearBudget(state:import("../apps/community-wizard/server/linux-journal.ts").LinuxJournal){
  state.message="p".repeat(20_000);
  const remaining=JOURNAL_MAX_BYTES-encodedBytes(state)-reservedBytes(state)-1_024;
  assert.ok(remaining>0);state.message+="p".repeat(remaining);
  assert.ok(encodedBytes(state)+reservedBytes(state)<=JOURNAL_MAX_BYTES);return JSON.stringify(state)+"\n";
}
function recoveryChallenge():NamespaceChallenge {
  const selection={...fixtureProfile().infrastructure.binding,principalId:"fixture-operator"};
  const value={id:fixtureHash("capacity-challenge") as Hex,selectionKey:selectionKey(selection),selection,purpose:"bind_community_namespace" as const,
    authorityId:fixtureHash("authority") as Hex,issuedAt:2_000_000_000,expiresAt:2_000_000_030,grantExpiresAt:2_000_000_060,policyId:"fixture-policy"};
  return {...value,message:namespaceChallengeMessage(value)};
}
test("pending namespace completion owns its byte reserve through near-cap restart",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure();
  f.naming.begin=async()=>{throw Error("Controlled original reply lost");};await assert.rejects(f.setup.namespaceBegin());
  const marker=structuredClone(f.setup.snapshot().namespaceRequest!);
  await writeFile(join(f.directory,"linux-setup-v2.json"),nearBudget(f.setup.snapshot()));
  const resumed=await f.open();f.naming.recover=async()=>({state:"completed",result:recoveryChallenge()});
  await resumed.namespaceRecover();assert.equal(resumed.snapshot().namespaceRequest,null);
  assert.equal(resumed.snapshot().namespaceHistory.at(-1)?.requestId,marker.id);
  assert.ok(Buffer.byteLength(await f.disk())<=JOURNAL_MAX_BYTES);assert.equal((await f.open()).snapshot().namespaceRequest,null);
});
test("pending credential reconciliation spends only its replacement growth reserve and keeps the original secret marker until saved",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);
  await f.configure({...f.draft,features:{...f.draft.features,learning:true},services:{...f.draft.services,learningProfile:"learning:verified"}});
  f.facts.lostSave=true;
  await assert.rejects(f.setup.saveCredentials({revision:f.setup.snapshot().revision,values:{ELEVENLABS_API_KEY:"fixture-private-transient"}}));
  const marker=structuredClone(f.setup.snapshot().secretRequest!), revision=f.setup.snapshot().revision;
  await writeFile(join(f.directory,"linux-setup-v2.json"),nearBudget(f.setup.snapshot()));
  const resumed=await f.open();const requirements=structuredClone(resumed.snapshot().requirements);
  for(const r of requirements)r.state="saved";let status:"pending"|"saved"="pending";
  f.backend.reconcileCredentials=async({requestId})=>{assert.equal(requestId,marker.id);return {state:status,requirements};};
  await resumed.reconcileCredentials();assert.deepEqual(resumed.snapshot().secretRequest,marker);assert.equal(resumed.snapshot().revision,revision);
  status="saved";await resumed.reconcileCredentials();assert.equal(resumed.snapshot().secretRequest,null);
  assert.equal(resumed.snapshot().revision,revision+1);assert.ok(!(await f.disk()).includes("fixture-private-transient"));
  assert.ok(Buffer.byteLength(await f.disk())<=JOURNAL_MAX_BYTES);assert.equal((await f.open()).snapshot().secretRequest,null);
});
test("original upload receipt has completion capacity at the byte cap without changing its request or ciphertext",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure({...f.draft,mode:"restore"});
  async function* bytes(){yield fixtureCiphertext;}
  f.facts.lostUpload=true;await assert.rejects(f.setup.stageBackup(bytes(),fixtureCiphertext.length));
  const marker=structuredClone(f.setup.snapshot().uploadRequest!);
  await writeFile(join(f.directory,"linux-setup-v2.json"),nearBudget(f.setup.snapshot()));
  const resumed=await f.open();f.facts.lostUpload=false;const stage=f.backend.stageBackup;const ids:string[]=[];
  f.backend.stageBackup=async input=>{ids.push(input.requestId);return stage(input);};
  await resumed.stageBackup(bytes(),fixtureCiphertext.length);assert.deepEqual(ids,[marker.id]);
  assert.equal(resumed.snapshot().uploadRequest,null);assert.ok(resumed.snapshot().backupDigest);
  assert.ok(Buffer.byteLength(await f.disk())<=JOURNAL_MAX_BYTES);assert.equal((await f.open()).snapshot().uploadRequest,null);
  assert.equal(f.facts.nativeIntents.length,0);
});
