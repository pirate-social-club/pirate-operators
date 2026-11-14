import type { PrivateKeyAccount } from "viem/accounts";
import { canonical, hashJson, insist, object, token } from "../community/common.ts";
import { signRecognitionRequest, type RecognitionAction } from "./authorization.ts";
import { recognitionProfile, reservationId, type AcceptedIntent, type PostingBinding, type RecognitionProfile } from "./intent.ts";
import { verifyReservation, type ReservationReceipt } from "./reservation-receipt.ts";
export interface ReservationClientPorts {
  profile:RecognitionProfile; publisher:PrivateKeyAccount;
  current(intent:AcceptedIntent):Promise<void>;
  /** Lease, exact operation and local journal checked at the actual transport boundary. */
  beforeSend(intent:AcceptedIntent):Promise<void>;
  transport?:(request:Request)=>Promise<Response>;
  now?:()=>number;
}
export function reservationClient(ports:ReservationClientPorts) {
  const profile=recognitionProfile(ports.profile),now=ports.now??Date.now;
  const request=async(p:AcceptedIntent,path:string,action:RecognitionAction,posting?:PostingBinding)=>{
    await ports.current(p);
    insist(p.profileSha256===profile.sha256&&p.namespace===profile.namespace,"recognition_profile_changed",409);
    const issuedAt=Math.floor(now()/1000), wire=await signRecognitionRequest(ports.publisher,{
      namespace:profile.namespace as `0x${string}`,profileSha256:profile.sha256 as `0x${string}`,action,
      communityId:p.communityId as `0x${string}`,communityOrigin:p.communityOrigin,serviceOrigin:profile.origin,
      configurationRevision:p.configurationRevision,nonce:hashJson({nonce:token()}),issuedAt,expiresAt:issuedAt+120,
    },{jobId:p.jobId,...(posting?{posting}:{})});
    await ports.current(p);await ports.beforeSend(p);
    const response=await (ports.transport??fetch)(new Request(profile.origin+path,{method:'POST',redirect:'error',
      signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json'},body:canonical(wire)}));
    insist(response.ok,"recognition_catalog_pending",503);
    const receipt=object(await response.json()).receipt;
    const payload=await verifyReservation(receipt,profile,{communityId:p.communityId,configurationRevision:p.configurationRevision,
      intentSha256:hashJson(p),reservationId:reservationId(p),requestSha256:hashJson(wire),
      purpose:action==='intent_bind'?'posting_bound':action==='intent_commit'?'publication_promoted':'accepted_intent'},Math.floor(now()/1000));
    await ports.current(p);await ports.beforeSend(p);
    insist(payload.expiresAt>Math.floor(now()/1000),"recognition_reservation_expired",403);
    return {payload,receipt};
  };
  const ready=(p:ReservationReceipt)=>{
    insist((p.state==='ready'||p.state==='committing'||p.state==='committed')&&p.recordingId&&p.recordingState==='ready',"catalog_pending",503);return p;
  };
  return {
    async reserve(p:AcceptedIntent) { return ready((await request(p,'/v1/reservations','intent_reserve')).payload); },
    async status(p:AcceptedIntent) {return (await request(p,'/v1/reservations/status','intent_status')).payload;},
    async ready(p:AcceptedIntent) {return ready((await request(p,'/v1/reservations/status','intent_status')).payload);},
    async bind(p:AcceptedIntent,posting:PostingBinding) {
      const result=await request(p,'/v1/reservations/bind','intent_bind',posting);
      insist(result.payload.state==='committing'&&result.payload.recordingState==='ready'&&result.payload.postingSha256===hashJson(posting),"catalog_posting_binding_changed",409);return result;
    },
    async commit(p:AcceptedIntent,posting:PostingBinding) {
      const result=await request(p,'/v1/reservations/commit','intent_commit',posting);
      insist(result.payload.state==='committed'&&result.payload.recordingState==='ready'&&result.payload.postingSha256===hashJson(posting)&&result.payload.publicationSha256,
        "catalog_promotion_pending",503);return result;
    },
  };
}
export type ReservationClient=ReturnType<typeof reservationClient>;
