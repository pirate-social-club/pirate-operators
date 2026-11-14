// UNRUN. Actual disk journal and wizard state machine; controlled ports REFUSE
// all effects. This cannot establish native host/readiness acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile} from "node:fs/promises";
import {join} from "node:path";
import {linuxJournalStore,emptyJournal,canonical} from "../apps/community-wizard/server/linux-journal.ts";
import {createLinuxSetup} from "../apps/community-wizard/server/linux-setup.ts";
import {validateLinuxJournal} from "../apps/community-wizard/server/linux-journal-validation.ts";
import {fixtureDraft} from "./linux-shared-native-profile-fixture.ts";
import {createOperationFixture} from "./linux-create-v3-fixture.ts";
import type {OriginalLinuxDeploymentPort as LinuxDeploymentPort,LinuxCapabilities,NamespaceAuthorityPort} from "../apps/community-wizard/server/linux-contracts.ts";
function refusingPorts(){
  const op=createOperationFixture(),calls={deploy:0,prepare:0,bind:0,restore:0,terminal:0};
  const refuse=async()=>{throw Error("unexpected_effect_in_restart_fixture");};
  const capabilities:LinuxCapabilities={version:2,adapterId:"fixture:create-only",sourceDigest:op.plan.profile.runtime.sourceDigest,
    targets:["local-linux"],operations:["create"],features:[],backup:{formats:[],maxBytes:0,sessionPolicies:[]},
    publicationSelection:op.plan.profile.settings.services.publicationProfile,publicationProfiles:[],learningProfiles:[],
    sshConnections:[],backupProfiles:[],limitations:["Controlled refusing ports, not a native backend."],policy:null};
  const backend:LinuxDeploymentPort={version:2,journalRecovery:{policy:"pirate.linux-journal-capacity/1",
    sourceDigest:capabilities.sourceDigest,resultMaxBytes:524288,intentMaxBytes:262144,
    async terminal({operation}){calls.terminal++;return {state:"pending",operationId:operation.id};}},
    operator:{async deploy(){calls.deploy++;return refuse();},async restore(){calls.restore++;return refuse();},reconcile:refuse},
    capabilities:async()=>structuredClone(capabilities),inspectTarget:refuse,credentialRequirements:refuse,verifyCredentials:refuse,
    reconcileCredentials:refuse,saveCredentials:refuse,stageBackup:refuse,inspectBackup:refuse,
    async prepare(){calls.prepare++;return refuse();},async bindOperation(){calls.bind++;return refuse();},
    bindReconciliation:refuse,observeResult:refuse};
  const naming:NamespaceAuthorityPort={version:3,assertWritable(){throw Error("unexpected_namespace_write");},
    begin:refuse,complete:refuse,recover:refuse,inspect:refuse,revalidate:refuse};
  return {op,calls,backend,naming};
}
test("running V3 survives actual journal reopen as unknown with exact original plan and zero automatic replay",async()=>{
  assert(process.env.TMPDIR,"Root must supply owned TMPDIR");const dir=await mkdtemp(join(process.env.TMPDIR,"create-v3-restart-"));
  const f=refusingPorts(),store=await linuxJournalStore(dir),state=emptyJournal();
  state.draft=f.op.plan.profile.settings;state.identity=f.op.plan.profile.identity;state.plan=f.op.plan;state.revision=1;
  state.operation={...f.op,state:"running",intent:null,results:[],capacityPhase:"binding",recoveryResultDigest:null,
    custody:"held",receiptRef:null,observationRevision:0,message:"Controlled interrupted create."};
  await store.save(state);const before=await readFile(join(dir,"linux-setup-v2.json"));
  const setup=await createLinuxSetup(dir,f.backend,f.naming),reopened=setup.snapshot();
  assert.equal(reopened.operation!.state,"unknown");assert.equal(reopened.operation!.id,f.op.id);
  assert.equal(canonical(reopened.operation!.plan),canonical(f.op.plan));
  assert.deepEqual(await readFile(join(dir,"linux-setup-v2.json")),before);
  await setup.deploy({revision:1,planDigest:f.op.plan.digest,targetFingerprint:f.op.plan.targetFingerprint,approved:true});
  await assert.rejects(setup.review());
  assert.deepEqual(f.calls,{deploy:0,prepare:0,bind:0,restore:0,terminal:0});
  assert.equal(setup.snapshot().history.length,0);assert.equal(setup.snapshot().operation!.id,f.op.id);
});
test("reconciled failed V3 original cannot create a retry child or change schema",async()=>{
  assert(process.env.TMPDIR,"Root must supply owned TMPDIR");const dir=await mkdtemp(join(process.env.TMPDIR,"create-v3-failed-"));
  const f=refusingPorts(),store=await linuxJournalStore(dir),state=emptyJournal();
  state.draft=f.op.plan.profile.settings;state.identity=f.op.plan.profile.identity;state.plan=f.op.plan;state.revision=1;
  // Explicit state-machine failure witness only, never actual cleanup authority.
  state.operation={...f.op,state:"failed",intent:null,results:[],capacityPhase:"binding",recoveryResultDigest:null,
    custody:"cleared",receiptRef:"fixture:failure",observationRevision:1,message:"Controlled failed original."};
  await store.save(state);const setup=await createLinuxSetup(dir,f.backend,f.naming);
  await assert.rejects(setup.review());
  assert.deepEqual(f.calls,{deploy:0,prepare:0,bind:0,restore:0,terminal:0});
  assert.equal(setup.snapshot().history.length,0);assert.equal(setup.snapshot().operation!.id,f.op.id);
});
test("V3 journal rejects deferred upload restore and historical retry children without rewriting originals",()=>{
  const f=refusingPorts(),state=emptyJournal();state.draft=f.op.plan.profile.settings;
  for(const extra of [{uploadRequest:{id:"upload:held",byteLength:1}},{backupId:"backup:held",backupDigest:"0x"+"1".repeat(64)},
    {restore:{id:"untrusted"}}])assert.throws(()=>validateLinuxJournal({...structuredClone(state),...extra} as never));
});

test("saving V3 over retained V2 settings refuses without a schema reset or external call",async()=>{
  assert(process.env.TMPDIR,"Root must supply owned TMPDIR");const dir=await mkdtemp(join(process.env.TMPDIR,"create-v3-schema-"));
  const f=refusingPorts(),store=await linuxJournalStore(dir),state=emptyJournal();state.draft=fixtureDraft();state.revision=1;
  await store.save(state);const before=await readFile(join(dir,"linux-setup-v2.json"));
  const setup=await createLinuxSetup(dir,f.backend,f.naming);
  await assert.rejects(setup.configure({revision:1,draft:f.op.plan.profile.settings}),error=>
    error instanceof Error && "code" in error && error.code === "profile_schema_changed");
  assert.deepEqual(await readFile(join(dir,"linux-setup-v2.json")),before);
  assert.deepEqual(f.calls,{deploy:0,prepare:0,bind:0,restore:0,terminal:0});
});
