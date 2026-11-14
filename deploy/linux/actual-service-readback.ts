import assert from "node:assert/strict";
import {request} from "node:https";
import {performance} from "node:perf_hooks";
import {readPrivateJSON,canonicalDigest} from "./installed-records.ts";
import {type OperationLease} from "./backend-state.ts";
import {actualBusinessPath} from "./readback-path.ts";
import {randomBytes} from "node:crypto";
import {hashText} from "../../packages/community/common.ts";
import {signNativeReadback} from "../../packages/community/native-readback-request.ts";
import type {SignedRecord} from "./installed-records.ts";
import type {CurrentAdmission} from "./full-profile-authority.ts";
export interface ReadbackSpec {
  role:"application"|"login"|"media"|"learning"|"session-revocation"|"external-effects";
  url:string;method:"GET"|"POST";body?:unknown;expectedStatus:number;sourceSHA256:string;
  selectors:Record<"installationId"|"resourceId"|"requestId"|"generation"|"outcome"|"profileDigest",string>;
  expected:{installationId:string;resourceId:string;requestId:string;generation:number;outcome:string;profileDigest:string};
}
export function pointer(value:any,path:string):unknown {
  assert(path.startsWith("/"));for(const k of path.slice(1).split("/")){assert(value!==null && typeof value==="object" && Object.hasOwn(value,k));value=value[k];}return value;
}
export function validateReadback(spec:ReadbackSpec,value:unknown) {
  assert(Number.isSafeInteger(spec.expected.generation) && spec.expected.generation>0);
  const result:any={};for(const [key,path] of Object.entries(spec.selectors))result[key]=pointer(value,path);
  assert.deepEqual(result,spec.expected,"actual_persistent_readback_identity_mismatch");return result;
}
export async function actualHTTPS(input:{
  url:string;method:"GET"|"POST"|"PUT"|"HEAD";headers?:Record<string,string>;body?:Uint8Array;seconds:number;signal:AbortSignal;
}) {
  const url=new URL(input.url);assert(url.protocol==="https:" && !url.username && !url.password && !url.hash && !url.search);
  const end=performance.now()+input.seconds*1000;let timedOut=false;
  const check=()=>{if(timedOut || performance.now()>=end){timedOut=true;throw new Error("readback_true_timeout");}};
  check();
  return await new Promise<{status:number;bytes:Buffer;certificateFingerprint:string;setCookie?:string[]}>((resolve,reject)=>{
    let size=0;const chunks:Buffer[]=[];
    const req=request(url,{method:input.method,headers:input.headers,rejectUnauthorized:true,signal:input.signal},res=>{
      const fingerprint=(res.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256;
      res.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>8*1024**2)req.destroy(new Error("readback_response_limit"));else chunks.push(chunk);});
      res.on("error",reject);res.on("end",()=>{
        clearTimeout(timer);
        try{check();assert(fingerprint);resolve({status:res.statusCode!,bytes:Buffer.concat(chunks),certificateFingerprint:fingerprint,setCookie:res.headers["set-cookie"]});}
        catch(e){reject(e);}
      });
    });
    const timer=setTimeout(()=>{timedOut=true;req.destroy(new Error("readback_true_timeout"));},Math.max(1,end-performance.now()));
    req.on("error",e=>{clearTimeout(timer);reject(e);});
    if(input.body)req.write(input.body);req.end();
  });
}
export async function runActualReadbacks(input:{
  lease:OperationLease;specs:ReadbackSpec[];owningSourceSHA256:string;profileDigest:string;origin:string;
  generation:number;signal:AbortSignal;headers?:Record<string,string>;
  readbackKey:string;authorize():Promise<void>;current:SignedRecord<CurrentAdmission>;
}) {
  const lease=input.lease,authorize=input.authorize,signal=input.signal,key=input.readbackKey;
  const snapshot=structuredClone(input.specs),current=structuredClone(input.current),headers={...input.headers};
  const binding=()=>({specs:input.specs.map(s=>({...s,body:s.body??null,hasBody:s.body!==undefined})),
    current:input.current,headers:input.headers??{},origin:input.origin,generation:input.generation,
    profileDigest:input.profileDigest,owningSourceSHA256:input.owningSourceSHA256});
  const bound=canonicalDigest(binding());
  const assertBinding=()=>{
    assert(input.lease===lease && input.authorize===authorize && input.signal===signal && !signal.aborted,
      "actual_readback_owner_changed");
    assert(input.readbackKey===key && canonicalDigest(binding())===bound,"actual_readback_original_input_changed");
  };
  assertBinding();assert(snapshot.length>0);const observations=[];
  let accountId:string|undefined;
  const ordered=snapshot.sort((a,b)=>Number(b.role==="application"||b.role==="login")-Number(a.role==="application"||a.role==="login"));
  for(const spec of ordered) {
    await authorize();assertBinding();
    await input.lease.assertHeld();
    assertBinding();
    const url=new URL(spec.url);assert(url.origin===input.origin);actualBusinessPath(url.pathname+url.search,input.origin);
    assert(spec.sourceSHA256===input.owningSourceSHA256 && spec.expected.profileDigest===input.profileDigest &&
      spec.expected.installationId===input.lease.installationId && spec.expected.generation===input.generation,"readback_source_or_scope_changed");
    const body=spec.body===undefined?undefined:Buffer.from(JSON.stringify(spec.body));
    assert(["application","login","media","learning"].includes(spec.role) && spec.method==="GET" && body===undefined,
      "actual_persisted_business_read_required");
    assert.deepEqual(spec.selectors,Object.fromEntries(["installationId","resourceId","requestId","generation","outcome","profileDigest"]
      .map(field=>[field,"/nativeReadback/"+field])),"actual_handler_native_selectors_required");
    const issuedAt=Date.now();
    assert(spec.role==="application"||spec.role==="login"||spec.role==="media"||spec.role==="learning");
    const authentication=await signNativeReadback({version:1,role:spec.role,nonce:randomBytes(32).toString("hex"),
      issuedAt,expiresAt:issuedAt+15000,installationId:spec.expected.installationId,profileDigest:spec.expected.profileDigest,
      generation:spec.expected.generation,resourceId:spec.expected.resourceId,method:"GET",path:url.pathname,
      cookieHash:hashText(headers.Cookie??""),current},key);
    assertBinding();await authorize();assertBinding();
    if(spec.role==="media"||spec.role==="learning")assert(accountId,"actual_authenticated_account_readback_required");
    const response=await actualHTTPS({url:spec.url,method:spec.method,body,
      headers:{...headers,...authentication,...(spec.role==="media"?{"X-Dance-Account":accountId!}:{})},seconds:15,signal});
    try {
      await authorize();assertBinding();
      assert(response.status===spec.expectedStatus,"actual_handler_status_failed");
      const bodyValue=JSON.parse(response.bytes.toString("utf8"));
      const observed=validateReadback(spec,bodyValue);
      if(spec.role==="application"||spec.role==="login"){
        const saved=bodyValue.nativeReadback?.accountId;
        assert(typeof saved==="string" && saved.length>0 && (!accountId||accountId===saved),"actual_account_binding_changed");
        accountId=saved;
      }
      observations.push({role:spec.role,observed,responseSHA256:canonicalDigest(response.bytes.toString("base64")),
        certificateFingerprint:response.certificateFingerprint});
    } finally {body?.fill(0);response.bytes.fill(0);}
  }
  const evidence=await input.lease.record("actual-selected-handler-readbacks",{profileDigest:input.profileDigest,generation:input.generation,observations});
  assertBinding();await authorize();assertBinding();
  return {observations,evidence,checkedAt:Date.now(),accountId};
}

