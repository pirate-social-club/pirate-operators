// Prepared focused regressions. UNRUN; no host/deployment/provider acceptance.
import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {mkdir,mkdtemp,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fixtureProfile} from "./linux-shared-native-profile-fixture.ts";
import {createProfileFixture,createPlanFixture} from "./linux-create-v3-fixture.ts";
import {linuxProfileFrom,linuxDraftFrom} from "../packages/community-setup/shared-linux-profile.ts";
import {linuxCreateProfileFrom,linuxCreateDraftFrom,originalLinuxProfileFrom,originalLinuxDraftFrom} from "../packages/community-setup/linux-create-profile.ts";
import {planFrom,fullLinuxV2PlanFrom} from "../apps/community-wizard/server/linux-boundaries.ts";
import {digestJson} from "../apps/community-wizard/server/linux-journal.ts";
import {sameOperationalSelection} from "../packages/community-setup/operational-selection.ts";
import {signRecord,canonicalDigest} from "../deploy/linux/installed-records.ts";
import {validateOriginal} from "../deploy/linux/full-profile-authority.ts";
import {readCreateProfileTemplate,readProfileTemplate} from "../deploy/linux/profile-producer.ts";
import {linuxCreateRuntimeProfileFrom} from "../deploy/linux/create-runtime-profile.ts";

function signer(){const pair=generateKeyPairSync("ed25519");return {key:pair.privateKey.export({format:"der",type:"pkcs8"}),
  trust:{keyId:"public-create-v3-test",spki:pair.publicKey.export({format:"der",type:"spki"}).toString("base64")}};}

test("V3 exact local create fields omit backup recovery and session placeholders",()=>{
  const p=createProfileFixture(),before=JSON.stringify(p);
  assert.deepEqual(originalLinuxProfileFrom(p),p);assert.deepEqual(originalLinuxDraftFrom(p.settings),p.settings);
  assert(!Object.hasOwn(p.settings,"recovery"));assert(!Object.hasOwn(p.settings.storage,"backup"));
  for(const field of ["backup","recovery","sessionPolicy"]){
    const changed=structuredClone(p.settings) as unknown as Record<string,unknown>;changed[field]=null;
    assert.throws(()=>linuxCreateDraftFrom(changed));
  }
  assert.throws(()=>linuxCreateDraftFrom({...p.settings,storage:{...p.settings.storage,backup:null}}));
  assert.equal(JSON.stringify(p),before);
});
test("V3 rejects import restore upgrade SSH unknown fields and schema relabelling",()=>{
  const p=createProfileFixture();
  for(const mode of ["import","restore","upgrade"])assert.throws(()=>linuxCreateProfileFrom({...p,settings:{...p.settings,mode}}));
  assert.throws(()=>linuxCreateDraftFrom({...p.settings,target:{kind:"ssh-linux",host:"host.example",port:22,user:"operator",connectionRef:"ssh:original"}}));
  for(const schema of ["pirate.community-linux-profile/1","pirate.community-linux-profile/4"])
    assert.throws(()=>originalLinuxProfileFrom({...p,schema}));
  assert.throws(()=>originalLinuxProfileFrom({...p,schema:"pirate.community-linux-profile/2"}));
  assert.throws(()=>originalLinuxProfileFrom({...fixtureProfile(),schema:"pirate.community-linux-profile/3"}));
  assert.throws(()=>originalLinuxDraftFrom({...p.settings,version:2}));
  assert.throws(()=>originalLinuxProfileFrom({...p,extra:true}));
});
test("retained V2 bytes and decoder stay identical and V3 never enters V2 import or restore codec",()=>{
  const p=fixtureProfile(),bytes=JSON.stringify(p),digest=canonicalDigest(p);
  assert.equal(JSON.stringify(linuxProfileFrom(p)),bytes);assert.equal(JSON.stringify(originalLinuxProfileFrom(p)),bytes);
  assert.equal(canonicalDigest(linuxProfileFrom(p)),digest);
  assert.deepEqual(linuxDraftFrom(p.settings),p.settings);
  assert.throws(()=>linuxProfileFrom(createProfileFixture()));
  assert.throws(()=>linuxDraftFrom(createProfileFixture().settings));
  assert.equal(JSON.stringify(p),bytes);
});
test("V3 cannot adopt a retained mapping or replace original installation or namespace binding",()=>{
  const p=createProfileFixture();
  assert.throws(()=>linuxCreateProfileFrom({...p,infrastructure:{...p.infrastructure,mapping:{...p.infrastructure.mapping,
    origin:"retained-shared",originalProfileSha256:"3".repeat(64)}}}));
  const changed=structuredClone(p);changed.infrastructure.mapping.directoryInstallationId="0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  assert.throws(()=>linuxCreateProfileFrom(changed));
  const proof={...p,namespace:{...p.namespace,binding:{...p.namespace.binding,hostingOrigin:"https://another.example"}}};
  assert.throws(()=>linuxCreateProfileFrom(proof));
});
test("V3 plan requires create and all restore predecessor session fields null even when rehashed",()=>{
  const p=createPlanFixture();assert.deepEqual(planFrom(p),p);
  assert.throws(()=>fullLinuxV2PlanFrom(p)); // No V3-to-V2 narrowing by assertion or cast.
  const mutations=[{action:"upgrade"},{action:"restore"},{action:"adopt"},{sessionPolicy:"revoke-existing"},
    {predecessorOperationId:"operation:old"},{restoreInspectionId:"restore:old"},
    {restoreManifestDigest:"0x"+"3".repeat(64)},{restoreCiphertextDigest:"0x"+"4".repeat(64)}];
  for(const mutation of mutations){const {digest:_digest,...body}={...p,...mutation};assert.throws(()=>planFrom({...body,digest:digestJson(body)}));}
  assert(sameOperationalSelection(p.profile.settings,p.profile.settings,null));
  assert(!sameOperationalSelection(p.profile.settings,p.profile.settings,"revoke-existing"));
  assert(!sameOperationalSelection(fixtureProfile().settings,p.profile.settings,null));
});
test("real managed-format signatures bind exact V3 schema digest and independent installation IDs",()=>{
  const s=signer(),profile=createProfileFixture(),now=Date.now();
  const body={installationId:profile.infrastructure.mapping.linuxInstallationId,requestId:"create-request",generation:1,
    recordId:"create-original",issuedAt:now-1000,expiresAt:now+60000,profile,profileDigest:canonicalDigest(profile),outcome:"authorized-profile" as const};
  try{
    assert.deepEqual(validateOriginal(signRecord(body,s.trust,s.key),s.trust,body.installationId),body);
    assert.throws(()=>validateOriginal(signRecord({...body,profileDigest:canonicalDigest(fixtureProfile())},s.trust,s.key),s.trust,body.installationId));
    const signed=signRecord(body,s.trust,s.key);signed.body.profile.settings.name="Changed signed name";
    assert.throws(()=>validateOriginal(signed,s.trust,body.installationId));
    assert.throws(()=>validateOriginal(signRecord(body,s.trust,s.key),s.trust,"different-installation"));
  }finally{s.key.fill(0);}
});
test("signed create template is separately selected with no V2 signature or template promotion",async()=>{
  assert(process.env.TMPDIR,"Root must supply owned TMPDIR");const dir=await mkdtemp(join(process.env.TMPDIR,"create-template-"));
  const s=signer(),profile=createProfileFixture(),now=Date.now(),installationId=profile.infrastructure.mapping.linuxInstallationId;
  const template={schema:"pirate.linux-create-template/1" as const,installationId,generation:1,issuedAt:now-1000,expiresAt:now+60000,
    settings:profile.settings,identity:profile.identity,infrastructure:profile.infrastructure,runtime:profile.runtime,learning:profile.learning};
  const path=join(dir,"create-template.json");
  try{
    await writeFile(path,JSON.stringify(signRecord(template,s.trust,s.key)),{mode:0o600});
    const before=await readFile(path);assert.deepEqual(await readCreateProfileTemplate(path,s.trust,installationId),template);
    await assert.rejects(readProfileTemplate(path,s.trust,installationId));assert.deepEqual(await readFile(path),before);
    await writeFile(path,JSON.stringify(signRecord({...template,schema:"pirate.linux-create-template/2"},s.trust,s.key)),{mode:0o600});
    await assert.rejects(readCreateProfileTemplate(path,s.trust,installationId));
  }finally{s.key.fill(0);}
});
test("unsigned create runtime selection is closed and grants no signed profile authority",()=>{
  const p={schema:"pirate.linux-create-runtime/1",installationId:"fixture-installation",backendConfigurationFile:"/owned/backend.json",
    wizardDirectory:"/owned/wizard",pairingNonceDirectory:"/owned/pairing",frontPort:48001,innerPort:48002};
  assert.deepEqual(linuxCreateRuntimeProfileFrom(p),p);
  for(const value of [{...p,backup:{}},{...p,frontPort:p.innerPort},{...p,backendConfigurationFile:"relative.json"},
    {...p,schema:"pirate.linux-create-runtime/2"}])assert.throws(()=>linuxCreateRuntimeProfileFrom(value));
  assert.throws(()=>originalLinuxProfileFrom(p));
});

test("V3 retains complete selected Learning configuration and all activation and origin bounds",async()=>{
  const data=await import("./community-wizard-linux-fixture.ts"),draft=data.fixtureDraft();
  draft.features.learning=true;draft.services.learningProfile="learning:verified";
  const profile=createProfileFixture(data.fixtureProfile(draft));assert(profile.learning);
  assert.equal(profile.learning.profileId,draft.services.learningProfile);
  assert.equal(profile.learning.communityOrigin,draft.origin);
  const before=JSON.stringify(profile);assert.deepEqual(linuxCreateProfileFrom(profile),profile);
  for(const mutate of [
    (p:typeof profile)=>{p.learning!.communityOrigin="https://another.example";},
    (p:typeof profile)=>{p.learning!.activation.accountWei="1";},
    (p:typeof profile)=>{p.learning!.secretRefs.issuer="";},
    (p:typeof profile)=>{p.learning!.chainId=1 as never;},
  ]){const changed=structuredClone(profile);mutate(changed);assert.throws(()=>linuxCreateProfileFrom(changed));}
  assert.equal(JSON.stringify(profile),before);
});
