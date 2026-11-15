import { recoverTypedDataAddress, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { bytes32, exact, hashJson, insist, integer, object, text } from "../community/common.ts";
import { type RecognitionProfile, recognitionProfile } from "./intent.ts";
const domain={name:"Pirate Accepted Intent Reservation",version:"1"} as const;
const types={Reservation:[{name:"payloadSha256",type:"bytes32"}]} as const;
export interface ReservationReceipt {
  schema:"pirate.recognition-reservation-receipt/1";
  purpose:"accepted_intent" | "posting_bound" | "publication_promoted";
  namespace:string; profileSha256:string; communityId:string; configurationRevision:number;
  requestSha256:string; intentSha256:string; reservationId:string; recordingId:string | null;
  state:string; recordingState:string|null; postingSha256:string | null; publicationSha256:string | null;
  issuedAt:number; expiresAt:number;
}
export function reservationReceipt(input:unknown):ReservationReceipt {
  const p=object(input);
  exact(p,["schema","purpose","namespace","profileSha256","communityId","configurationRevision","requestSha256",
    "intentSha256","reservationId","recordingId","state","recordingState","postingSha256","publicationSha256","issuedAt","expiresAt"]);
  insist(p.schema==='pirate.recognition-reservation-receipt/1' &&
    (p.purpose==='accepted_intent'||p.purpose==='posting_bound'||p.purpose==='publication_promoted'),"recognition_reservation_receipt_invalid",503);
  return {schema:p.schema,purpose:p.purpose,namespace:bytes32(p.namespace),profileSha256:bytes32(p.profileSha256),
    communityId:bytes32(p.communityId),configurationRevision:integer(p.configurationRevision,1,2147483647),
    requestSha256:bytes32(p.requestSha256),intentSha256:bytes32(p.intentSha256),reservationId:bytes32(p.reservationId),
    recordingId:p.recordingId===null?null:bytes32(p.recordingId),state:text(p.state,40),recordingState:p.recordingState===null?null:text(p.recordingState,40),
    postingSha256:p.postingSha256===null?null:bytes32(p.postingSha256),publicationSha256:p.publicationSha256===null?null:bytes32(p.publicationSha256),
    issuedAt:integer(p.issuedAt,1,Number.MAX_SAFE_INTEGER),expiresAt:integer(p.expiresAt,1,Number.MAX_SAFE_INTEGER)};
}
export async function signReservation(signer:PrivateKeyAccount,payload:ReservationReceipt) {
  const p=reservationReceipt(payload);
  return {payload:p,signature:await signer.signTypedData({domain,types,primaryType:"Reservation",message:{payloadSha256:hashJson(p)}})};
}
export async function verifyReservation(input:unknown,profileInput:RecognitionProfile,expected:Partial<ReservationReceipt>,now:number) {
  const v=object(input);exact(v,["payload","signature"]);
  const p=reservationReceipt(v.payload), profile=recognitionProfile(profileInput), signature=text(v.signature,132);
  insist(/^0x[0-9a-f]{130}$/.test(signature) && p.namespace===profile.namespace && p.profileSha256===profile.sha256 &&
    p.issuedAt<=now && p.issuedAt>=now-60 && p.expiresAt>now && p.expiresAt<=p.issuedAt+60 &&
    Object.entries(expected).every(([key,value])=>p[key as keyof ReservationReceipt]===value),"recognition_reservation_scope_mismatch",403);
  const signer=await recoverTypedDataAddress({domain,types,primaryType:"Reservation",message:{payloadSha256:hashJson(p)},signature:signature as Hex});
  insist(signer.toLowerCase()===profile.signer,"recognition_reservation_signer_invalid",403);
  insist(p.expiresAt>now,"recognition_reservation_expired",403);
  return p;
}
