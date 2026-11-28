// Adapted protocol invariants from the qualified HTTPS-window/late-callback
// recovery described in docs/self-hosting/web2-operator-signing.md. No runtime
// dependency on old probes, consent policy, login or public operator APIs.
import {hashJson,canonical,insist,object,exact} from "../../../packages/community/common.ts";
import type {Address,Hex,TypedDataDefinition} from "viem";
import type {Web2Wallet} from "../../../deploy/linux/web2-operator-inputs.ts";
export const MOSS_WINDOW_PROTOCOL="pirate.web2-moss-window/1";
export type SigningPurpose="connect"|"enrollment"|"installation-plan"|"owner-authorization";
export interface MossWindowRequest {
  protocol:typeof MOSS_WINDOW_PROTOCOL;kind:"request";channel:Hex;requestDigest:Hex;
  purpose:SigningPurpose;expectedController:Address|null;network:"testnet";data:unknown;
}
export type MossWindowResponse={protocol:typeof MOSS_WINDOW_PROTOCOL;kind:"response";channel:Hex;requestDigest:Hex;purpose:SigningPurpose;network:"testnet"} &
  ({status:"connected";address:Address}|{status:"signed";address:Address;signature:Hex}|{status:"cancelled"}|{status:"error";code:string});
const hex32=(v:unknown):v is Hex=>typeof v==="string"&&/^0x[0-9a-f]{64}(?![\s\S])/.test(v);
const account=(v:unknown):v is Address=>typeof v==="string"&&/^0x[0-9a-f]{40}(?![\s\S])/.test(v)&&!/^0x0+$/.test(v);
export const signingWire=(value:unknown):unknown=>JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==="bigint"?String(v):v));
export function loopbackSigningOpener(value:string) {
  const url=new URL(value);
  insist(url.origin===value&&url.protocol==="http:"&&url.hostname==="127.0.0.1"&&/^[1-9][0-9]{0,4}$/.test(url.port)&&Number(url.port)<=65535,"web2_wallet_opener_invalid");
  return url.origin;
}
export function mossSigningOrigin(value:string) {
  const url=new URL(value);
  insist(url.origin===value&&url.protocol==="https:"&&!url.username&&!url.password,"web2_wallet_signing_origin_invalid");
  return url.origin;
}
const enrollmentFields="enrollmentId:bytes32,inviteId:bytes32,allowanceId:bytes32,communityKey:bytes32,installationId:bytes32,controller:address,publisher:address,origin:string,configurationUri:string,registrationCommitment:bytes32,policyHash:bytes32,noticeSha256:bytes32,expiresAt:uint64";
const ownerFields="schema:string,communityId:bytes32,ownerWallet:address,policyVersion:string,policySha256:bytes32,validFrom:uint64,expiresAt:uint64";
const installationFields="enrollmentId:bytes32,communityId:bytes32,installationId:bytes32,generation:uint64,planId:string,durableScope:bytes32,releaseArtifactDigest:bytes32,releaseSourceDigest:bytes32,targetDigest:bytes32,hostFingerprint:string";
export function mossSigningPurpose(data:unknown,expected:Address):Exclude<SigningPurpose,"connect"> {
  const d=object(data);exact(d,["domain","primaryType","types","message"]);
  const domain=object(d.domain),types=object(d.types),message=object(d.message);
  exact(domain,["name","version","chainId","verifyingContract"]);
  insist(domain.chainId===6343&&account(domain.verifyingContract),"web2_wallet_request_invalid");
  const enrollment=d.primaryType==="HostedEnrollment",installation=d.primaryType==="InstallationPlan",owner=d.primaryType==="OwnerPublishingAuthorization";
  insist((enrollment&&domain.name==="Pirate Hosted Enrollment"&&domain.version==="1") ||
    (installation&&domain.name==="Pirate Web2 Installation Plan"&&domain.version==="1") ||
    (owner&&domain.name==="Pirate Owner Publishing Authorization"&&domain.version==="2"),"web2_wallet_signing_purpose_invalid");
  exact(types,[String(d.primaryType)]);
  const fields=(enrollment?enrollmentFields:installation?installationFields:ownerFields).split(",").map(field=>{const [name,type]=field.split(":");return {name,type};});
  insist(canonical(types[String(d.primaryType)])===canonical(fields),"web2_wallet_request_invalid");
  exact(message,fields.map(f=>f.name!));
  insist(enrollment ? message.controller===expected : installation ? true : message.schema==="pirate.owner-publishing-authorization/2","web2_wallet_request_invalid");
  return enrollment ? "enrollment" : installation ? "installation-plan" : "owner-authorization";
}
export function checkedMossWindowRequest(value:unknown,openerOrigin:string,signingOrigin:string):MossWindowRequest {
  const r=object(value);exact(r,["protocol","kind","channel","requestDigest","purpose","expectedController","network","data"]);
  insist(r.protocol===MOSS_WINDOW_PROTOCOL&&r.kind==="request"&&hex32(r.channel)&&hex32(r.requestDigest)&&r.network==="testnet","web2_wallet_request_invalid");
  insist(JSON.stringify(signingWire(r)).length<=196608,"web2_wallet_request_invalid");
  if(r.purpose==="connect") {
    insist(r.expectedController===null&&r.data===null&&r.requestDigest===hashJson({purpose:"connect",network:"testnet",channel:r.channel,openerOrigin,signingOrigin}),"web2_wallet_request_invalid");
  } else {
    insist(account(r.expectedController)&&mossSigningPurpose(r.data,r.expectedController)===r.purpose&&hashJson(signingWire(r.data))===r.requestDigest,"web2_wallet_request_invalid");
  }
  return structuredClone(r) as unknown as MossWindowRequest;
}
/** Each call opens its owned top-level window synchronously, before any await.
 * Config comes exclusively from the authenticated host/setup snapshot. */
export function createWeb2MossWindow(config:{signingOrigin:string;timeoutMs?:number}):Web2Wallet {
  const signingOrigin=mossSigningOrigin(config.signingOrigin),openerOrigin=loopbackSigningOpener(window.location.origin),timeout=config.timeoutMs??180000;
  insist(Number.isInteger(timeout)&&timeout>=100&&timeout<=180000,"web2_wallet_timeout_invalid");
  function request(input:{data:TypedDataDefinition;expectedController:Address;requestDigest:Hex}|null):Promise<MossWindowResponse> {
    const channel=("0x"+Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,"0")).join("")) as Hex;
    const purpose:SigningPurpose=input?mossSigningPurpose(signingWire(input.data),input.expectedController):"connect";
    const prepared=checkedMossWindowRequest({protocol:MOSS_WINDOW_PROTOCOL,kind:"request",channel,purpose,network:"testnet",expectedController:input?.expectedController??null,
      data:input?signingWire(input.data):null,requestDigest:input?.requestDigest??hashJson({purpose:"connect",network:"testnet",channel,openerOrigin,signingOrigin})},openerOrigin,signingOrigin);
    let popup:Window|null=null,settled=false,sent=false,finish!:(value:MossWindowResponse)=>void;
    const base={protocol:MOSS_WINDOW_PROTOCOL as typeof MOSS_WINDOW_PROTOCOL,kind:"response" as const,channel,purpose,network:"testnet" as const,requestDigest:prepared.requestDigest};
    const result=new Promise<MossWindowResponse>(resolve=>{finish=value=>{if(settled)return;settled=true;window.removeEventListener("message",receive);clearTimeout(deadline);clearInterval(closed);popup?.close();resolve(value);};});
    const fail=(code:string)=>finish({...base,status:"error",code});
    function receive(event:MessageEvent) {
      if(event.source!==popup||event.origin!==signingOrigin||settled)return;
      const v=event.data;
      if(v?.protocol!==MOSS_WINDOW_PROTOCOL)return;
      if(v.kind==="ready") {if(!sent){sent=true;popup!.postMessage(prepared,signingOrigin);}return;}
      if(v.kind!=="response"||v.channel!==channel)return; // old/late channels cannot complete a new call
      if(v.requestDigest!==prepared.requestDigest||v.purpose!==purpose||v.network!=="testnet")return fail("web2_wallet_window_protocol_changed");
      if(v.status==="cancelled")return finish({...base,status:"cancelled"});
      if(v.status==="error")return fail(typeof v.code==="string"&&/^web2_wallet_[a-z_]{1,80}$/.test(v.code)?v.code:"web2_wallet_unavailable");
      if(purpose==="connect"&&v.status==="connected"&&account(v.address))return finish({...base,status:"connected",address:v.address});
      if(purpose!=="connect"&&v.status==="signed"&&v.address===prepared.expectedController&&account(v.address)&&typeof v.signature==="string"&&/^0x(?:[a-fA-F0-9]{2}){1,16384}(?![\s\S])/.test(v.signature))
        return finish({...base,status:"signed",address:v.address,signature:v.signature});
      fail("web2_wallet_window_protocol_changed");
    }
    window.addEventListener("message",receive);
    const deadline=setTimeout(()=>fail("web2_wallet_window_timeout"),timeout);
    const closed=setInterval(()=>{if(popup?.closed)finish({...base,status:"cancelled"});},100);
    popup=window.open(signingOrigin+"/operator-signing?openerOrigin="+encodeURIComponent(openerOrigin),"_blank","popup,width=520,height=760");
    if(!popup)fail("web2_wallet_popup_blocked_retry");
    return result;
  }
  return {
    connect(){return request(null).then(r=>{if(r.status!=="connected")throw Error(r.status==="cancelled"?"web2_wallet_window_cancelled":r.status==="error"?r.code:"web2_wallet_window_protocol_changed");return {address:r.address,network:"testnet"};});},
    signTypedData(input){
      try{return request(structuredClone(input)).then(r=>r.status==="signed"?{status:"success" as const,signature:r.signature}:r.status==="cancelled"?{status:"cancelled" as const}:{status:"error" as const,code:r.status==="error"?r.code:"web2_wallet_window_protocol_changed"});}
      catch {return Promise.resolve({status:"error",code:"web2_wallet_request_invalid"});}
    },
  };
}
