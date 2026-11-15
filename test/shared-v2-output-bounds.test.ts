import assert from "node:assert/strict";
import {test} from "node:test";
import {boundedIntent,boundedResult,encodedBytes,requireNativeEnvelope,PROVED_INTENT_MAX,PROVED_RESULT_MAX,
 INTENT_MAX_BYTES,RESULT_MAX_BYTES} from "../deploy/linux/shared-v2-output-bounds.ts";
const wide=(n:number)=>"\ud800".repeat(n),sha="a".repeat(64),id=(i:number,n=200)=>String(i).padEnd(n,"x");
const evidence=()=>({relativePath:"r".repeat(200),sha256:sha});
const target=()=>({endpointRef:wide(200),endpointIdentityDigest:sha,stateNamespace:wide(200),deploymentId:wide(200)});
const release=()=>({sourceHead:"a".repeat(40),sourceTree:"b".repeat(40),manifest:evidence(),selectedProfileDigest:sha,
 requiredServices:Array.from({length:32},(_,i)=>id(i,128))});
function result(){return {operationId:wide(200),outcome:"custody-uncertain",lastCompletedPhase:wide(128),
 unrunPhases:Array.from({length:32},()=>wide(128)),resources:Array.from({length:32},(_,i)=>({
 resourceKey:id(i),intentId:wide(200),targetIdentityDigest:sha,disposition:"unknown",observedConfigurationDigest:sha,evidence:evidence()})),
 ownedProcesses:Array.from({length:64},()=>({hostPid:Number.MAX_SAFE_INTEGER,hostStartTicks:"1".repeat(64),
 hostGroup:Number.MAX_SAFE_INTEGER,hostSession:Number.MAX_SAFE_INTEGER,networkNamespace:wide(64),pidNamespace:wide(64),containerId:wide(128)})),
 rawReceipt:evidence(),postguard:evidence(),cleanup:evidence()};}
function deploy(){return {kind:"deploy",intent:{operationId:wide(200),journalRevision:Number.MAX_SAFE_INTEGER,target:target(),planDigest:sha,
 draftRevision:Number.MAX_SAFE_INTEGER,release:release(),appOrigin:wide(512),importedAuthorityRefs:Array.from({length:32},evidence),
 desiredConfiguration:evidence(),serviceSecretRefs:Array.from({length:32},()=>({storeId:wide(200),keyId:wide(200),generation:Number.MAX_SAFE_INTEGER})),
 resourceKeys:Array.from({length:32},(_,i)=>id(i)),executionBoundSeconds:Number.MAX_SAFE_INTEGER}};}
function restore(){return {kind:"restore",intent:{operationId:wide(200),journalRevision:Number.MAX_SAFE_INTEGER,freshTarget:target(),
 encryptedCohortManifest:evidence(),transportConfiguration:evidence(),transportCredentialRef:{storeId:wide(200),keyId:wide(200),generation:Number.MAX_SAFE_INTEGER},
 recoveryKeyRef:{storeId:wide(200),keyId:wide(200),generation:Number.MAX_SAFE_INTEGER},compatibleRelease:release(),revocationPolicyDigest:sha,executionBoundSeconds:Number.MAX_SAFE_INTEGER}};}
test("full maximum intent and result field sets include escaping optional fields and newline",()=>{
 for(const value of [deploy(),restore()]){assert.deepEqual(boundedIntent(value),value);assert(encodedBytes(value)<=PROVED_INTENT_MAX);}
 const value=result();assert.deepEqual(boundedResult(value),value);assert(encodedBytes(value)<=PROVED_RESULT_MAX);
 assert(PROVED_INTENT_MAX<=INTENT_MAX_BYTES && PROVED_RESULT_MAX<=RESULT_MAX_BYTES);
});
test("over-count or over-string cannot cross the pre-effect boundary",()=>{
 let effects=0;const dispatch=(value:unknown)=>{boundedResult(value);effects++;};
 const many=result();many.resources.push(many.resources[0]!);assert.throws(()=>dispatch(many));
 const process=result();process.ownedProcesses.push(process.ownedProcesses[0]!);assert.throws(()=>dispatch(process));
 const phase=result();phase.lastCompletedPhase=wide(129);assert.throws(()=>dispatch(phase));
 const identifier=deploy();identifier.intent.operationId=wide(201);assert.throws(()=>{boundedIntent(identifier);effects++;});
 assert.equal(effects,0);
});
test("unknown symbol nonenumerable accessor and custom serializer are refused without invocation",()=>{
 let called=0;
 for(const key of ["foreign",Symbol("foreign"),"toJSON"]){
  const value=result();Object.defineProperty(value,key,{get(){called++;return ()=>({});}});
  assert.throws(()=>boundedResult(value));assert.equal(called,0);
 }
 const field=result();Object.defineProperty(field,"lastCompletedPhase",{get(){called++;return null;}});
 assert.throws(()=>boundedResult(field));assert.equal(called,0);
 const intent=deploy();Object.defineProperty(intent,"kind",{get(){called++;return "deploy";}});
 assert.throws(()=>boundedIntent(intent));assert.equal(called,0);
});
test("sparse or augmented arrays cannot bypass the whole shape",()=>{
 const sparse=result();delete sparse.resources[0];assert.throws(()=>boundedResult(sparse));
 const augmented=result();Object.defineProperty(augmented.ownedProcesses,"toJSON",{value:()=>[]});
 assert.throws(()=>boundedResult(augmented));
});
test("invalid numbers unknown result variants and deeply oversized returns never become valid terminal",()=>{
 for(const n of [NaN,Infinity,Number.MAX_SAFE_INTEGER+1,-1]){
  const value=result();value.ownedProcesses[0]!.hostGroup=n;assert.throws(()=>boundedResult(value));
 }
 const value=result();value.rawReceipt.relativePath="x".repeat(RESULT_MAX_BYTES+1);assert.throws(()=>boundedResult(value));
 assert.throws(()=>boundedResult({...result(),outcome:"ready"}));
});
test("actual envelope requires finite original resources and selected configuration digests",()=>{
 const envelope={resourceKeys:Array.from({length:32},(_,i)=>id(i)),requiredServices:release().requiredServices,credentialCount:32,
 containers:Array.from({length:32},(_,i)=>({key:id(i),configurationDigest:sha}))};
 assert.equal(requireNativeEnvelope(envelope).provedResultBytes,PROVED_RESULT_MAX);
 assert.throws(()=>requireNativeEnvelope({...envelope,credentialCount:33}));
 assert.throws(()=>requireNativeEnvelope({...envelope,containers:[...envelope.containers,{key:"foreign",configurationDigest:sha}]}));
 assert.throws(()=>requireNativeEnvelope({...envelope,resourceKeys:[...envelope.resourceKeys.slice(1),envelope.resourceKeys[1]!]}));
});
// These finite schema negatives are protocol tests, not native handler, physical
// host, bootstrap, private-service, terminal-restart or release acceptance.
