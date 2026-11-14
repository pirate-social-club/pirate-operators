import assert from "node:assert/strict";
export const CAPACITY_POLICY="pirate.linux-journal-capacity/1" as const;
export const INTENT_MAX_BYTES=262144 as const,RESULT_MAX_BYTES=524288 as const;
type Shape={kind:"string";max:number;pattern?:RegExp}|{kind:"number";min:number}|{kind:"enum";values:readonly unknown[]}|
 {kind:"nullable";item:Shape}|{kind:"array";max:number;item:Shape}|{kind:"object";fields:Record<string,Shape>;optional?:readonly string[]};
const text=(max:number):Shape=>({kind:"string",max});
const ascii=(max:number,pattern:RegExp):Shape=>({kind:"string",max,pattern});
const number=(min=0):Shape=>({kind:"number",min});
const object=(fields:Record<string,Shape>,optional:readonly string[]=[]):Shape=>({kind:"object",fields,optional});
const array=(max:number,item:Shape):Shape=>({kind:"array",max,item});
const choices=(...values:unknown[]):Shape=>({kind:"enum",values});
const digest=ascii(64,/^[a-f0-9]{64}$/),sha1=ascii(40,/^[a-f0-9]{40}$/);
const evidence=object({relativePath:ascii(200,/^[A-Za-z0-9_.\/-]+$/),sha256:digest});
const secret=object({storeId:text(200),keyId:text(200),generation:number()});
const target=object({endpointRef:text(200),endpointIdentityDigest:digest,stateNamespace:text(200),deploymentId:text(200)});
const release=object({sourceHead:sha1,sourceTree:sha1,manifest:evidence,selectedProfileDigest:digest,requiredServices:array(32,text(128))});
const deploy=object({operationId:text(200),journalRevision:number(),target,planDigest:digest,draftRevision:number(),release,
 appOrigin:text(512),importedAuthorityRefs:array(32,evidence),desiredConfiguration:evidence,serviceSecretRefs:array(32,secret),
 resourceKeys:array(32,text(200)),executionBoundSeconds:number(1)});
const restore=object({operationId:text(200),journalRevision:number(),freshTarget:target,encryptedCohortManifest:evidence,
 transportConfiguration:evidence,transportCredentialRef:secret,recoveryKeyRef:secret,compatibleRelease:release,
 revocationPolicyDigest:digest,executionBoundSeconds:number(1)});
const resource=object({resourceKey:text(200),intentId:text(200),targetIdentityDigest:digest,
 disposition:choices("owned-present","confirmed-absent","conflict","unknown"),observedConfigurationDigest:digest,evidence},["observedConfigurationDigest"]);
const processShape=object({hostPid:number(1),hostStartTicks:ascii(64,/^[0-9]+$/),hostGroup:number(),hostSession:number(),
 networkNamespace:text(64),pidNamespace:text(64),containerId:text(128)},["containerId"]);
const RESULT_SHAPE=object({operationId:text(200),outcome:choices("completed","failed","interrupted","custody-uncertain"),
 lastCompletedPhase:{kind:"nullable",item:text(128)},unrunPhases:array(32,text(128)),resources:array(32,resource),ownedProcesses:array(64,processShape),
 rawReceipt:evidence,postguard:evidence,cleanup:evidence});
// Each string code unit costs at most SIX UTF-8 bytes after JSON escaping,
// including lone surrogates. Numbers cost at most16decimal bytes; object keys,
// punctuation, optional fields and the single final newline are all counted.
export function maximum(shape:Shape):number{
 switch(shape.kind){
  case "string":return 2+6*shape.max;
  case "number":return 16;
  case "nullable":return Math.max(4,maximum(shape.item));
  case "enum":return Math.max(...shape.values.map(v=>{const json=JSON.stringify(v);assert(typeof json==="string");return Buffer.byteLength(json);}));
  case "array":return 2+shape.max*maximum(shape.item)+Math.max(0,shape.max-1);
  case "object":return 2+Object.entries(shape.fields).reduce((n,[key,v])=>n+Buffer.byteLength(JSON.stringify(key))+1+maximum(v),0)+Math.max(0,Object.keys(shape.fields).length-1);
 }
}
function validate(v:unknown,s:Shape):void{
 switch(s.kind){
  case "string":assert(typeof v==="string" && v.length<=s.max && !/[\x00-\x1f\x7f]/.test(v) && (!s.pattern||s.pattern.test(v)),"native_output_string_bound");return;
  case "number":assert(typeof v==="number" && Number.isSafeInteger(v) && v>=s.min,"native_output_number_bound");return;
  case "nullable":if(v!==null)validate(v,s.item);return;
  case "enum":assert(s.values.some(x=>Object.is(v,x)),"native_output_enum");return;
  case "array":{
   assert(Array.isArray(v) && Object.getPrototypeOf(v)===Array.prototype && v.length<=s.max,"native_output_count_bound");
   assert(Reflect.ownKeys(v).length===v.length+1,"native_output_sparse_or_extra_array_field");
   for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));assert(d && "value" in d && d.enumerable,"native_output_array_accessor");validate(d.value,s.item);}return;
  }
  case "object":{
   assert(v!==null && typeof v==="object" && Object.getPrototypeOf(v)===Object.prototype,"native_output_plain_object");
   const row=v as Record<string,unknown>;assert(Reflect.ownKeys(row).every(k=>typeof k==="string" && Object.hasOwn(s.fields,k)),"native_output_unknown_field");
   for(const [key,field] of Object.entries(s.fields)){
    if(!Object.hasOwn(row,key)){assert(s.optional?.includes(key),"native_output_missing_field");continue;}
    const d=Object.getOwnPropertyDescriptor(row,key);assert(d && "value" in d && d.enumerable,"native_output_accessor");validate(d.value,field);
   }return;
  }
 }
}
const deployWrapper=object({kind:choices("deploy"),intent:deploy}),restoreWrapper=object({kind:choices("restore"),intent:restore});
export const PROVED_RESULT_MAX=maximum(RESULT_SHAPE)+1;
export const PROVED_INTENT_MAX=Math.max(maximum(deployWrapper),maximum(restoreWrapper))+1;
assert(PROVED_RESULT_MAX<=RESULT_MAX_BYTES && PROVED_INTENT_MAX<=INTENT_MAX_BYTES,"native_output_proof_exceeds_policy");
export const encodedBytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value)+"\n");
export function boundedIntent<T>(value:T):T{
 const descriptor=value!==null && typeof value==="object"?Object.getOwnPropertyDescriptor(value,"kind"):undefined;
 const kind=descriptor && "value" in descriptor?descriptor.value:null;assert(kind==="deploy"||kind==="restore","native_intent_kind");
 validate(value,kind==="deploy"?deployWrapper:restoreWrapper);
 assert(encodedBytes(value)<=INTENT_MAX_BYTES,"native_intent_whole_encoded_bound");return structuredClone(value);
}
export function boundedResult<T>(value:T):T{
 validate(value,RESULT_SHAPE);
 assert(encodedBytes(value)<=RESULT_MAX_BYTES,"native_result_whole_encoded_bound");
 return structuredClone(value);
}
export function requireNativeEnvelope(input:{resourceKeys:readonly string[];requiredServices:readonly string[];credentialCount:number;containers:readonly {key:string;configurationDigest:string}[]}){
 assert(input.resourceKeys.length<=32 && input.requiredServices.length<=32 && input.containers.length<=32 &&
  Number.isSafeInteger(input.credentialCount) && input.credentialCount>=0 && input.credentialCount<=32,"selected_native_envelope_exceeded");
 input.resourceKeys.forEach(v=>validate(v,text(200)));input.requiredServices.forEach(v=>validate(v,text(128)));
 assert(new Set(input.resourceKeys).size===input.resourceKeys.length);
 for(const c of input.containers){assert(input.resourceKeys.includes(c.key),"selected_native_resource_not_original");validate(c.key,text(200));validate(c.configurationDigest,digest);}
 // The actual native finish builder emits one readback per original container,
 // fixed phase codes, and currently no inline processes. Raw native PID/group/
 // namespace evidence stays in original restricted receipts and independent
 // custody proof; an empty inline array never establishes actual absence.
 return {policy:CAPACITY_POLICY,provedIntentBytes:PROVED_INTENT_MAX,provedResultBytes:PROVED_RESULT_MAX};
}
