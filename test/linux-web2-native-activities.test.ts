import assert from "node:assert/strict";
import test from "node:test";
import { canonical, hashText } from "../packages/community/common.ts";
import type { LinuxWeb2Draft } from "../packages/community-setup/linux-web2-profile.ts";
import { assertNoBootstrapNativeActivities, composeNativeActivities, offeredPractice, type Web2NativeActivityPolicy } from "../deploy/linux/web2-native-activities.ts";
import type { NativeGraph } from "../deploy/linux/full-native-config.ts";
import type { Web2LocalStudyPolicy } from "../deploy/linux/web2-local-study.ts";

const first = hashText("native-activity-fixture");
const study = { issuer:"0x"+"1".repeat(40),operator:"0x"+"2".repeat(40) } as Web2LocalStudyPolicy;
const native: Web2NativeActivityPolicy = {schema:"pirate.web2-native-activities/1",socket:"/private/native.sock",
  karaoke:{operatorFile:"/private/operator.key",ingressFile:"/private/ingress.auth",community:"0x3333333333333333333333333333333333333333",
    token:"0x4444444444444444444444444444444444444444",modelSha256:first,pythonSha256:first.slice(2),scriptSha256:first.slice(2),
    validFrom:100,validUntil:200,retentionDays:1},
};
const draft = { configuration:{communityId:first,operatorPayments:"0x"+"0".repeat(40)},
 deployment:{rpcUrl:"https://rpc.example"},origin:"https://community.example" } as LinuxWeb2Draft;
function graph():NativeGraph {
  return {durableScope:"6".repeat(64),requiredRoles:["private-study"],actors:[{service:"private-study-operator",bindings:[]}],
    secretBindings:[],applicationBindings:[{name:"STUDY_PRIVATE_V5_PROFILE",text:"profile"},
      {name:"SPEECH_ADMISSION_CONFIG",text:"budget"},
      {name:"SPEECH_BUDGET",durable:{service:"private-study-operator",className:"SpeechBudget"}},
      {name:"COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON",text:canonical({activities:{study:{kind:"private-v5",profileHash:first},karaoke:null,dance:null}})}]
  } as NativeGraph;
}

test("a captured native Karaoke selection shares the retained Study budget and leaves public targets absent",()=>{
  const base = graph();
  assert.equal(composeNativeActivities(base,draft,study,native),base);
  assert.equal(offeredPractice(study,native),"study-karaoke-v5");
  const selected = { ...draft, privatePractice:"study-karaoke-v5" } as const;
  assert.throws(()=>composeNativeActivities(graph(),selected,study),/native_activity_original_changed/);
  const composed=composeNativeActivities(graph(),selected,study,native);
  const karaoke=composed.actors.find(a=>a.role==="private-karaoke")!;
  assert.deepEqual(karaoke.bindings.find(a=>a.name==="SPEECH_BUDGET"),composed.applicationBindings.find(a=>a.name==="SPEECH_BUDGET"));
  assert.deepEqual(karaoke.bindings.find(a=>a.name==="KARAOKE_LOCAL_TRANSCRIBER"),{name:"KARAOKE_LOCAL_TRANSCRIBER",service:"web2-local-activities"});
  assert.deepEqual(karaoke.bindings.find(a=>a.name==="KARAOKE_LOCAL_SESSION_GATE"),{name:"KARAOKE_LOCAL_SESSION_GATE",service:"private-karaoke-session"});
  assert.deepEqual(composed.applicationBindings.find(a=>a.name==="KARAOKE_NATIVE_SESSION_CAPTURE"),
    {name:"KARAOKE_NATIVE_SESSION_CAPTURE",durable:{service:"private-karaoke-session",className:"NativeKaraokeSessions"}});
  assert(!karaoke.bindings.some(a=>a.name==="DB" || a.name==="KARAOKE_NATIVE_SESSION_CAPTURE"));
  assert(!karaoke.bindings.some(a=>a.name.includes("RESULTS") || a.name==="RECORDS_CONTRACT"));
  assert.deepEqual(composeNativeActivities(graph(),structuredClone(selected),study,native),composed);
});

test("the signed bootstrap cannot prebind or replace the native session gate", () => {
  assert.doesNotThrow(() => assertNoBootstrapNativeActivities(graph()));
  const prebound = graph();
  prebound.applicationBindings.push({
    name: "KARAOKE_NATIVE_SESSION_CAPTURE",
    durable: { service: "private-study-operator", className: "SpeechBudget" },
  });
  assert.throws(() => assertNoBootstrapNativeActivities(prebound), /bootstrap_native_activity_prebinding_refused/);
  const scope = graph();
  scope.secretBindings.push({ name: "KARAOKE_NATIVE_SESSION_SCOPE", path: "/private/other-scope.json" });
  assert.throws(() => assertNoBootstrapNativeActivities(scope), /bootstrap_native_activity_prebinding_refused/);
  const replacement = graph();
  replacement.actors[0]!.service = "private-karaoke-session";
  assert.throws(() => assertNoBootstrapNativeActivities(replacement), /bootstrap_native_activity_prebinding_refused/);
  const gateBinding = graph();
  gateBinding.actors[0]!.bindings.push({ name: "KARAOKE_LOCAL_SESSION_GATE", service: "private-study-operator" });
  assert.throws(() => assertNoBootstrapNativeActivities(gateBinding), /bootstrap_native_activity_prebinding_refused/);
});
