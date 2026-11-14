// One same-origin transport over the actual W6 controller routes. No tokens,
// keys, backend defaults or authority/readiness inference are stored here.
import type {LinuxJournal} from "../server/linux-journal.ts";
import type {LinuxCapabilities} from "../server/linux-contracts.ts";
import type {LinuxDraftV2,LinuxCommunityProfileV2} from "../../../packages/community-setup/shared-linux-profile.ts";
export type LinuxSnapshot=
 |{available:false;csrf:string;legacyAvailable:boolean;correction:string}
 |{available:true;csrf:string;legacyAvailable:boolean;state:LinuxJournal;capabilities:LinuxCapabilities};
export interface LinuxInputs {
 settings:{revision:number;draft:LinuxDraftV2};
 destination:{revision:number;mode:LinuxDraftV2["mode"];target:LinuxDraftV2["target"]};
 inspect:Record<string,never>;namespace:Record<string,never>;
 "namespace/begin":Record<string,never>;"namespace/recover":Record<string,never>;
 "namespace/complete":{challengeId:string;proof:unknown};
 import:{revision:number;profile:LinuxCommunityProfileV2};
 credentials:{revision:number;values:Record<string,string>};
 "credentials/verify":Record<string,never>;"credentials/reconcile":Record<string,never>;
 backup:Record<string,never>;"restore/inspect":{recoveryKey:string};
 plan:Record<string,never>;reconcile:Record<string,never>;cancel:Record<string,never>;
 deploy:{revision:number;planDigest:string;targetFingerprint:string;approved:boolean};
}
export type LinuxAction=keyof LinuxInputs;
export type LinuxCommand={[A in LinuxAction]:{action:A;input:LinuxInputs[A]}&
 (A extends "backup"?{file:File}:{file?:never})}[LinuxAction];
const keys:Record<LinuxAction,readonly string[]>={
 settings:["revision","draft"],destination:["revision","mode","target"],inspect:[],namespace:[],
 "namespace/begin":[],"namespace/recover":[],"namespace/complete":["challengeId","proof"],
 import:["revision","profile"],credentials:["revision","values"],"credentials/verify":[],
 "credentials/reconcile":[],cancel:[],backup:[],"restore/inspect":["recoveryKey"],plan:[],reconcile:[],
 deploy:["revision","planDigest","targetFingerprint","approved"]
};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==="object"&&!Array.isArray(v);
function snapshot(value:unknown):LinuxSnapshot {
 if(!object(value)||typeof value.available!=="boolean"||typeof value.legacyAvailable!=="boolean"||
  typeof value.csrf!=="string"||!/^[a-f0-9]{64}$/.test(value.csrf))throw Error("The runner returned an incompatible setup response. Reconnect to the original runner.");
 if(value.available){
  if(!object(value.state)||value.state.version!==2||value.state.capacityPolicy!=="pirate.linux-journal-capacity/1"||
   !Array.isArray(value.state.history)||!Array.isArray(value.state.requirements)||!object(value.capabilities)||
   value.capabilities.version!==2||!Array.isArray(value.capabilities.operations)||!Array.isArray(value.capabilities.targets)||
   !Array.isArray(value.capabilities.publicationProfiles)||!Array.isArray(value.capabilities.learningProfiles)||
   !Array.isArray(value.capabilities.backupProfiles)||!Array.isArray(value.capabilities.sshConnections)||
   !(value.capabilities.publicationSelection===null||typeof value.capabilities.publicationSelection==="string"))
   throw Error("This runner does not serve the selected shared v2 model. Retain its original journal; do not reset it.");
 }else if(typeof value.correction!=="string")throw Error("The runner did not explain its unavailable backend.");
 // This is a view envelope check, not cryptographic admission. The real server
 // validates every full profile, proof, receipt and request before any effects.
 return value as unknown as LinuxSnapshot;
}
export function createLinuxClient(transport:typeof fetch=(...args)=>globalThis.fetch(...args)){
 async function request(action?:string,input:unknown={},csrf="",backup?:File):Promise<LinuxSnapshot>{
  if(action!==undefined){
   if(!Object.hasOwn(keys,action))throw Error("Unknown Linux setup action.");
   const expected=keys[action as LinuxAction];
   if(!object(input)||Object.keys(input).length!==expected.length||!expected.every(k=>Object.hasOwn(input,k)))
    throw Error("The setup action has missing or unexpected fields.");
   if(!/^[a-f0-9]{64}$/.test(csrf))throw Error("Reload the original paired runner before changing setup.");
   if((action==="backup")!==Boolean(backup))throw Error("Only the original encrypted-backup route accepts file bytes.");
   if(backup&&(!Number.isSafeInteger(backup.size)||backup.size<1))throw Error("Choose the original nonempty encrypted backup.");
  }else if(backup)throw Error("A state read cannot upload bytes.");
  const json=backup?undefined:JSON.stringify(input);
  if(action&&!backup&&new TextEncoder().encode(json).length>196608)throw Error("The selected setup data exceeds the bounded request size.");
  const response=await transport("/api/linux/"+(action??"state"),action?{
   method:"POST",credentials:"same-origin",cache:"no-store",
   headers:{"Content-Type":backup?"application/octet-stream":"application/json","X-Wizard-Token":csrf,
    ...(backup?{"X-Backup-Size":String(backup.size)}:{})},body:backup??json
  }:{credentials:"same-origin",cache:"no-store"});
  let value:unknown;try{value=await response.json();}catch{throw Error("The runner did not return a complete response. Reconcile its original request before retrying.");}
  if(!response.ok)throw Error(object(value)&&typeof value.error==="string"?value.error:"This step did not complete. Reconnect to the original runner and reconcile its retained request.");
  return snapshot(value);
 }
 return {state:()=>request(),send:(command:LinuxCommand,csrf:string)=>request(command.action,command.input,csrf,command.file),request};
}
export const linuxRequest=createLinuxClient().request;
export const sameLinuxSettings=(a:unknown,b:unknown)=>{
 const stable=(v:unknown)=>JSON.stringify(v,(_k,x)=>object(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0)):x);
 return stable(a)===stable(b);
};
export const backupSizeLabel=(bytes:number)=>bytes>=1024**3?(bytes/1024**3).toFixed(2)+" GiB":(bytes/1024**2).toFixed(2)+" MiB";
