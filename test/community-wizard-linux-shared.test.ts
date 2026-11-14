// UNRUN source. Actual codecs/controllers and filesystem journal, controlled
// Directory/Naming/backend ports. No compiled ABI, service, VPS or device pass.
import test from "node:test";
import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {linuxDraftFrom,linuxProfileFrom} from "../packages/community-setup/shared-linux-profile.ts";
import {mappingFrom,validateProfileConfiguration,sameSharedInstallation} from "../packages/community-setup/shared-linux-infrastructure.ts";
import {sharedNamespaceProofFrom} from "../packages/community-setup/shared-namespace-proof.ts";
import {operatorPolicyFrom} from "../packages/community-setup/shared-operator-policy.ts";
import {configurationState,advanceConfiguration} from "../packages/community/config-manifest.ts";
import {directoryInstanceId} from "../packages/community/shared-identity.ts";
import {bindingKey,selectionKey,namespaceChallengeMessage,type NamespaceChallenge} from "../packages/community-names/namespace-import.ts";
import {createSharedWizardNamespacePort} from "../apps/community-wizard/server/shared-namespace-port.ts";
import {linuxFixture,fixtureDraft,fixtureProfile,fixtureHash,deferred} from "./community-wizard-linux-fixture.ts";
import type {Hex} from "viem";
test("explicit shared selection uses core opaque identity and independent hosting; legacy selection is refused",()=>{
  const d=fixtureDraft();d.origin="https://theyownthis.butnotthis";d.namespace.tld="issuance";
  const p=linuxProfileFrom(fixtureProfile(d));
  assert.equal(p.infrastructure.directory.communityId,directoryInstanceId(p.infrastructure.directory.chainId,p.infrastructure.directory.communityKey));
  assert.equal(p.infrastructure.directory.hostingOrigin,d.origin);
  assert.equal(p.namespace.binding.issuanceTld,"issuance");
  assert.equal(p.namespace.memberIssuance,"separate_authorization_required");
  assert.throws(()=>linuxDraftFrom({...d,version:1}),/explicit|version|shared/);
  assert.throws(()=>linuxProfileFrom({...p,schema:"pirate.community-linux-profile/1"}),/V1|cutover/);
});
test("explicit mapping is required and cannot turn an old string installation into a Directory ID",()=>{
  const p=fixtureProfile(), m=p.infrastructure.mapping;
  assert.throws(()=>mappingFrom({...m,origin:"existing-v1"}),/V1|cutover/);
  assert.throws(()=>linuxProfileFrom({...p,infrastructure:{...p.infrastructure,mapping:{...m,directoryInstallationId:fixtureHash("replacement-install")}}}),/installation|mapping|binding/);
  assert.throws(()=>mappingFrom({...m,origin:"retained-shared",originalProfileSha256:null}),/original/);
  assert.equal(mappingFrom(m).linuxInstallationId,m.linuxInstallationId);
});
test("restored key, mapping, original resources and source remain separate and stable",()=>{
  const p=linuxProfileFrom(fixtureProfile()), copy=linuxProfileFrom(JSON.parse(JSON.stringify(p)));
  assert.ok(sameSharedInstallation(p.infrastructure,copy.infrastructure));
  copy.infrastructure.mapping.mappingId="different-mapping";
  assert.equal(sameSharedInstallation(p.infrastructure,copy.infrastructure),false);
  assert.deepEqual(p.identity,fixtureProfile().identity);
});
test("configuration JSON cannot certify a later revision using invented empty history",()=>{
  const p=fixtureProfile(), next=structuredClone(p.infrastructure);
  next.configuration.configurationRevision=2;
  assert.throws(()=>validateProfileConfiguration(next,configurationState(),2n),/history/);
  const actualState=configurationState();
  advanceConfiguration(actualState,p.infrastructure.configuration,1n);
  assert.equal(validateProfileConfiguration(next,actualState,2n).configurationRevision,2);
});
test("Directory, source, namespace and every proof role/revision stay bound",()=>{
  const p=fixtureProfile();
  for(const field of ["onChainAuthorityRevision","onChainPolicyRevision","onChainScopeRevision"] as const){
    const changed=structuredClone(p);changed.namespace[field]="99";
    // Parsing is observation only; live revalidation below must refuse changed revisions.
    assert.equal(sharedNamespaceProofFrom(changed.namespace)[field],"99");
  }
  assert.throws(()=>sharedNamespaceProofFrom({...p.namespace,authorityKind:"registry_admin"}),/HNS|namespace_role/);
  assert.throws(()=>sharedNamespaceProofFrom({...p.namespace,memberIssuance:"allowed"}),/member|purpose/);
  assert.throws(()=>linuxProfileFrom({...p,infrastructure:{...p.infrastructure,sourceSha256:"ee".repeat(32)}}),/source|pin/);
});
test("missing real namespace ports remain unavailable and do not return a verified proof",async()=>{
  const d=fixtureDraft(),p=fixtureProfile(d);
  const port=createSharedWizardNamespacePort({authority:undefined,bindings:undefined,requests:undefined,originals:undefined});
  const result=await port.inspect({requestId:"fixture-request",tld:d.namespace.tld,hostingOrigin:d.origin,identity:p.identity});
  assert.equal(result.status,"unavailable");
  assert.throws(()=>port.assertWritable(),/actual|unavailable/);
});
test("actual v3 join rejects live changed binding and keeps permission roles separate",async()=>{
  const p=fixtureProfile();let binding=structuredClone(p.infrastructure.binding);
  const source=createSharedWizardNamespacePort({
    bindings:{async currentBinding(){return binding;}},
    authority:{version:3,async begin(){throw Error("unsupported fixture collector");},async complete(){return p.namespace;},
      async inspect(){return p.namespace;},async revalidate(){binding={...binding,revision:binding.revision+1};return p.namespace;}},
    requests:undefined,originals:{async requireOriginal(){return p.infrastructure.mapping;}}});
  const proof=await source.inspect({requestId:"fixture-read",tld:p.settings.namespace.tld,hostingOrigin:p.settings.origin,identity:p.identity});
  assert.equal(proof.status,"verified");
  assert.equal(p.namespace.memberIssuance,"separate_authorization_required");
  if(proof.status==="verified")await assert.rejects(source.revalidate({proof,profile:p}),/binding|changed/);
});
function challenge(p=fixtureProfile()):NamespaceChallenge {
  const selection={...p.infrastructure.binding,principalId:"fixture-operator"};
  const base={id:fixtureHash("challenge") as Hex,selectionKey:selectionKey(selection),selection,purpose:"bind_community_namespace" as const,
    authorityId:fixtureHash("authority") as Hex,issuedAt:2_000_000_000,expiresAt:2_000_000_030,grantExpiresAt:2_000_000_060,policyId:"fixture-policy"};
  return {...base,message:namespaceChallengeMessage(base)};
}
test("lost begin ACK survives actual journal restart and cannot automatically begin again",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure();
  let begins=0;
  f.naming.begin=async()=>{begins++;throw Error("lost response");};
  await assert.rejects(f.setup.namespaceBegin());
  const original=f.setup.snapshot().namespaceRequest!;
  assert.equal(begins,1);
  const resumed=await f.open();
  await assert.rejects(resumed.namespaceBegin(),/Reconcile/);
  assert.equal(begins,1);
  f.naming.recover=async()=>({state:"completed",result:challenge(fixtureProfile(f.draft))});
  await resumed.namespaceRecover();
  assert.equal(resumed.snapshot().namespaceChallenge?.id,challenge().id);
  assert.equal(resumed.snapshot().namespaceRequest,null);
  assert.equal(f.facts.nativeIntents.length,0);
  assert.ok((await f.disk()).includes(original.id),"Retain original request ID locally as well as in the real Root caller journal");
  assert.equal(resumed.snapshot().namespaceHistory.at(-1)?.requestId,original.id);
});
test("lost complete ACK keeps a body-free marker and does not publish stale authority",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure();
  f.naming.begin=async()=>challenge(fixtureProfile(f.draft));
  await f.setup.namespaceBegin();
  f.naming.complete=async()=>{throw Error("proof processing reply lost");};
  await assert.rejects(f.setup.namespaceComplete({challengeId:challenge().id,proof:"fixture-private-proof-body"}));
  const marker=f.setup.snapshot().namespaceRequest!;
  assert.equal(marker.kind,"complete");assert.ok(!(await f.disk()).includes("fixture-private-proof-body"));
  const resumed=await f.open();
  assert.deepEqual(resumed.snapshot().namespaceRequest,marker);
  await assert.rejects(resumed.configure({revision:resumed.snapshot().revision,draft:f.draft}),/Reconcile/);
  assert.equal(f.facts.nativeIntents.length,0);
});
test("new protocol refuses an existing V1 journal without altering or overlooking its original bytes",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);
  const original='{"version":1,"originalReceipt":"retained-unknown"}';
  const path=join(f.directory,"linux-setup-v1.json");
  await writeFile(path,original,{mode:0o600});
  await assert.rejects(f.open(),/V1|migration|cutover/);
  assert.equal(await readFile(path,"utf8"),original);
});
test("cancellation retains original native intent and uncertain custody; no automatic replay",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure();await f.review();
  const entered=deferred<void>();let sends=0;
  f.backend.operator.deploy=async(intent,signal)=>{
    sends++;entered.resolve();
    return await new Promise(resolve=>signal.addEventListener("abort",()=>resolve({...f.result(intent.operationId),outcome:"interrupted"}),{once:true}));
  };
  await f.deploy();await entered.promise;
  const original=structuredClone(f.setup.snapshot().operation!.intent);
  f.setup.cancel();await f.setup.settled();
  assert.deepEqual(f.setup.snapshot().operation!.intent,original);
  assert.equal(f.setup.snapshot().operation!.state,"unknown");
  assert.equal(f.setup.snapshot().operation!.custody,"held");
  await f.deploy();assert.equal(sends,1);
});
test("budget proposals and member free policy never imply provider caps, paid fallback or free gas",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);const view=structuredClone(f.capabilities.policy!);
  view.providerBudget.enforcement="unverified";view.providerBudget.evidenceRef=null;
  assert.equal(operatorPolicyFrom(view)!.providerBudget.enforcement,"unverified");
  const free={minimumCharacters:8,requiredEffectiveQuote:"0",maxCost:"0",paidFallback:false,approval:"none",termSeconds:31536000,renewal:"Actual locked renewal terms required",gasFunding:"Separately authorized payer and finite limits required",evidenceRef:"fixture-policy-evidence"};
  assert.throws(()=>operatorPolicyFrom({...view,freeNames:{...free,maxCost:"1"}}),/zero|policy|fallback/);
  assert.throws(()=>operatorPolicyFrom({...view,freeNames:{...free,paidFallback:true}}),/zero|policy|fallback/);
});

test("Root selects the exact shared publication profile; an arbitrary first verified catalogue entry cannot substitute",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure();
  f.capabilities.publicationProfiles.unshift({id:"foreign:profile",label:"Another installation",verified:true});
  f.capabilities.publicationSelection=null;
  await assert.rejects(f.review(),/verified publication|service_profile/);
  assert.equal(f.facts.nativeIntents.length,0);
  f.capabilities.publicationSelection="publication:verified";
  assert.equal((await f.review()).profile.settings.services.publicationProfile,"publication:verified");
});

test("a successful command and app health cannot replace actual shared configuration readback",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure();await f.review();
  f.backend.observeResult=async({operation})=>{
    const success=f.success(operation);
    if(success.state==="succeeded")success.sharedConfiguration.configuration={...success.sharedConfiguration.configuration,configurationRevision:99};
    return success;
  };
  await f.deploy();await f.setup.settled();
  assert.equal(f.setup.snapshot().operation?.state,"unknown");
  assert.equal(f.setup.snapshot().operation?.custody,"held");
});

test("changed actual enforcement or service contract requires a fresh reviewed plan",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure();await f.review();
  f.capabilities.policy!.providerBudget.evidenceRef="new-policy-evidence";
  await assert.rejects(f.deploy(),/Approve the current plan|Review|review/);
  assert.equal(f.facts.nativeIntents.length,0);
});

test("original resource authentication is required before Naming I/O; public IDs alone cannot authorize a crosswired identity",async()=>{
  const p=fixtureProfile();let observations=0;
  const bindings={async currentBinding(){return p.infrastructure.binding;}};
  const authority={version:3 as const,async begin(){throw Error("unavailable collector");},async complete(){return p.namespace;},
    async inspect(){observations++;return p.namespace;},async revalidate(){observations++;return p.namespace;}};
  const input={requestId:"fixture-read",tld:p.settings.namespace.tld,hostingOrigin:p.settings.origin,identity:p.identity};
  const missing=createSharedWizardNamespacePort({bindings,authority,requests:undefined,originals:undefined});
  assert.equal((await missing.inspect(input)).status,"unavailable");assert.equal(observations,0);
  const original=structuredClone(p.identity);
  const port=createSharedWizardNamespacePort({bindings,authority,requests:undefined,originals:{async requireOriginal({identity}){
    assert.deepEqual(identity,original,"Controlled authenticated original must include the whole resource set");return p.infrastructure.mapping;
  }}});
  const crosswired={...p.identity,resources:{...p.identity.resources,database:"database:other-installation"}};
  await assert.rejects(port.inspect({...input,identity:crosswired}));assert.equal(observations,0);
  assert.equal((await port.inspect(input)).status,"verified");assert.equal(observations,1);
});
test("changed mapping during an original lookup remains unavailable for admission, without changing retained profile",async()=>{
  const p=fixtureProfile(), retained=JSON.stringify(p);let b=structuredClone(p.infrastructure.binding), calls=0;
  const port=createSharedWizardNamespacePort({bindings:{async currentBinding(){return b;}},requests:undefined,
    originals:{async requireOriginal(){b={...b,revision:b.revision+1};return p.infrastructure.mapping;}},
    authority:{version:3,async begin(){throw Error("unavailable");},async complete(){return p.namespace;},
      async inspect(){calls++;return p.namespace;},async revalidate(){calls++;return p.namespace;}}});
  await assert.rejects(port.inspect({requestId:"fixture-read",tld:p.settings.namespace.tld,hostingOrigin:p.settings.origin,identity:p.identity}),/mapping|binding/);
  assert.equal(calls,0);assert.equal(JSON.stringify(p),retained);
});

test("a late original namespace completion cannot clear or overwrite a newer recovered request",async(t)=>{
  const f=await linuxFixture({timeoutMs:1000});t.after(f.dispose);await f.configure();
  const first=deferred<NamespaceChallenge>(),second=deferred<NamespaceChallenge>(),firstEntered=deferred<void>(),secondEntered=deferred<void>();let calls=0;
  f.naming.begin=async()=>{calls++;if(calls===1){firstEntered.resolve();return first.promise;}secondEntered.resolve();return second.promise;};
  const original=f.setup.namespaceBegin();
  // Wait for the real fsync and caller entry, not an arbitrary elapsed timer.
  await firstEntered.promise;
  const firstId=f.setup.snapshot().namespaceRequest!.id;
  f.naming.recover=async()=>({state:"completed",result:challenge(fixtureProfile(f.draft))});
  await f.setup.namespaceRecover();
  const newer=f.setup.namespaceBegin();
  await secondEntered.promise;
  const secondId=f.setup.snapshot().namespaceRequest!.id;assert.notEqual(firstId,secondId);
  first.resolve(challenge(fixtureProfile(f.draft)));await assert.rejects(original,/original|Recover|changed/);
  assert.equal(f.setup.snapshot().namespaceRequest?.id,secondId);
  assert.equal(f.setup.snapshot().namespaceHistory.filter(v=>v.requestId===firstId).length,1);
  second.resolve(challenge(fixtureProfile(f.draft)));await newer;
  assert.equal(f.setup.snapshot().namespaceHistory.at(-1)?.requestId,secondId);
  assert.equal(calls,2);assert.equal(f.facts.nativeIntents.length,0);
});

test("namespace history exhaustion refuses before external proof I/O and never prunes original evidence",async(t)=>{
  const f=await linuxFixture();t.after(f.dispose);await f.configure();let begins=0;
  f.naming.begin=async()=>{begins++;return challenge(fixtureProfile(f.draft));};
  const state=JSON.parse(await f.disk());
  state.namespaceHistory=Array.from({length:1000},(_,i)=>({requestId:"fixture-history:"+i,kind:"begin",challengeId:null,
    bindingRevision:state.revision,outcome:"not-started",evidenceRef:"fixture-not-started:"+i}));
  const bytes=JSON.stringify(state);await writeFile(join(f.directory,"linux-setup-v2.json"),bytes);
  const resumed=await f.open();await assert.rejects(resumed.namespaceBegin(),/Preserve|evidence/);
  assert.equal(begins,0);assert.equal(resumed.snapshot().namespaceHistory.length,1000);
  assert.equal(await f.disk(),bytes);assert.equal(resumed.snapshot().namespaceRequest,null);
});
