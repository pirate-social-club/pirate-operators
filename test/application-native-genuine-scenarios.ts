/** Four UNRUN genuine-host scenarios. These call the existing managed channel,
 * actual TLS application routes and the SAME native factory's observation and
 * restart/reconciliation paths. No fake DB, ready row or successful fallback. */
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {actualHTTPS} from "../deploy/linux/actual-service-readback.ts";
import {hash} from "../deploy/linux/backend-state.ts";
import {createLocalTargetImplementation,type LocalTargetInputs} from "../deploy/linux/local-target-services.ts";
import type {LinuxOperation,LinuxOperationResult} from "../apps/community-wizard/server/linux-contracts.ts";
import {runGenuineSharedNativeScenario,runGenuineSharedNativeRefusal} from "./linux-shared-native-genuine-scenarios.ts";
type RequestInput={body:Record<string,unknown>;headers:Record<string,string>;sourceFile?:string;sourceSha256?:string};
type Scenario=
 {kind:"media"|"learning";operation:LinuxOperation;requestFile:string;requestSha256:string}|
 {kind:"restart";operationId:string}|
 {kind:"revoked-readback";operation:LinuxOperation;result:LinuxOperationResult;expectedCode:string};
export async function runGenuineApplicationProducer(input:LocalTargetInputs,scenario:Scenario){
 if(scenario.kind==="restart")return runGenuineSharedNativeScenario(input,scenario,{recoveryKey:""});
 if(scenario.kind==="revoked-readback")return runGenuineSharedNativeRefusal(input,
   {kind:"observe",operation:scenario.operation,result:scenario.result},scenario.expectedCode);
 const originalBytes=await readFile(scenario.requestFile);assert.equal(hash(originalBytes),scenario.requestSha256);
 const intent:RequestInput=JSON.parse(originalBytes.toString("utf8"));
 const requestId=scenario.kind==="media"?intent.headers["Idempotency-Key"]:intent.body.requestId;
 assert(typeof requestId==="string" && requestId.length>=16);
 assert(Object.keys(intent.headers).every(k=>["Idempotency-Key"].includes(k)),"no_client_identity_or_permission_headers");
 const profile=scenario.operation.plan.profile,signal=AbortSignal.timeout(900000);
 assert(input.installationId===profile.infrastructure.mapping.linuxInstallationId);
 const actual=await createLocalTargetImplementation(input);
 try{
  const checked=await actual.applicationBusinessReadback({operationId:scenario.operation.id,role:"application",path:"/api/session",
    requestId:"actual-login",outcome:"authenticated",signal});
  const login=checked.session;
  const session=await actualHTTPS({url:profile.settings.origin+"/api/session",method:"GET",headers:{Cookie:login.cookie},seconds:15,signal});
  let csrf:string;
  try{assert.equal(session.status,200);const saved=JSON.parse(session.bytes.toString("utf8"));
    assert(saved.authenticated===true && typeof saved.csrf==="string");csrf=saved.csrf;}
  finally{session.bytes.fill(0);}
  // The account and cookie come from the same actual factory's managed
  // login plus persisted native session proof, not a browser/body account echo.
  const headers={Cookie:login.cookie,Origin:profile.settings.origin,"X-CSRF-Token":csrf,
    "X-Study-Account":login.wallet,"X-Dance-Account":checked.accountId,"Content-Type":"application/json",...intent.headers};
  const route=scenario.kind==="media"?"/api/uploads":"/api/study/lessons";
  const requestBody=Buffer.from(JSON.stringify(intent.body));
  let response:Awaited<ReturnType<typeof actualHTTPS>>;
  try{response=await actualHTTPS({url:profile.settings.origin+route,method:"POST",headers,body:requestBody,seconds:15,signal});}
  finally{requestBody.fill(0);}
  let id:string,outcome:string;
  try{assert.equal(response.status,scenario.kind==="media"?201:200);const saved=JSON.parse(response.bytes.toString("utf8"));
    id=scenario.kind==="media"?saved.submissionId:saved.lessonId;outcome=scenario.kind==="media"?saved.state:saved.status;
    assert(typeof id==="string" && typeof outcome==="string");}
  finally{response.bytes.fill(0);}
  if(scenario.kind==="media"){
    assert(intent.sourceFile && intent.sourceSha256,"actual_original_media_bytes_required");
    const source=await readFile(intent.sourceFile);assert.equal(hash(source),intent.sourceSha256);
    const uploaded=await actualHTTPS({url:profile.settings.origin+route+"/"+id+"/audio",method:"PUT",
      headers:{...headers,"Content-Type":"audio/mpeg"},body:source,seconds:15,signal});
    try{assert.equal(uploaded.status,200);}finally{source.fill(0);uploaded.bytes.fill(0);}
    // Existing checksum-validated R2 PUT and the real persisted upload lease.
    // This is private uploaded-media evidence, never a publication/catalog PASS.
    const current=await actualHTTPS({url:profile.settings.origin+route+"/"+id,method:"GET",headers,seconds:15,signal});
    try{assert.equal(current.status,200);outcome=JSON.parse(current.bytes.toString("utf8")).state;}
    finally{current.bytes.fill(0);}
    assert.equal(outcome,"uploaded","genuine_upload_not_persisted");
  }
  const proof=await actual.applicationBusinessReadback({operationId:scenario.operation.id,role:scenario.kind,
    path:route+"/"+id,requestId,outcome,signal});
  const saved=proof.observations.find(x=>x.role===scenario.kind);
  assert(saved && saved.observed.requestId===requestId && saved.observed.outcome===outcome,
    "genuine_business_record_not_accepted");
  return {kind:scenario.kind,requestId,recordId:id,outcome,sourceSha256:scenario.requestSha256,evidence:proof.evidence};

 }finally{originalBytes.fill(0);}
}
