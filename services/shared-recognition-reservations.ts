import type { PrivateKeyAccount } from "viem/accounts";
import { canonical, CommunityError, exact, hashJson, insist, integer, jsonBody, object, text } from "../packages/community/common.ts";
import { authorizeRecognitionRequest, recognitionAuthority, type RecognitionAuthority, type RecognitionAction } from "../packages/recognition/authorization.ts";
import { acceptedIntent, recognitionProfile, reservationId, type AcceptedIntent, type PostingBinding, type RecognitionProfile } from "../packages/recognition/intent.ts";
import { RecognitionStore } from "../packages/recognition/store.ts";
import { ReservationStore, type ReservationSnapshot } from "../packages/recognition/reservation-store.ts";
import { signReservation, type ReservationReceipt } from "../packages/recognition/reservation-receipt.ts";
import { originalDisposition, type OriginalIdentification } from "../packages/recognition/original-identification.ts";
import type { VerifiedPublication } from "../packages/recognition/model.ts";

/** Canonical private read ports; never deserialize facts asserted by a publisher.
 * verifyPublication must observe the actual successful receipt and exact post.
 * recover is retained journal access only, never a second paid identification. */
export interface SharedReservationPorts {
  db:D1Database; profile:RecognitionProfile; signer:PrivateKeyAccount;
  loadAuthority(communityId:string):Promise<RecognitionAuthority|null>;
  verifyIntent(authority:RecognitionAuthority,jobId:string):Promise<AcceptedIntent>;
  verifyPosting(authority:RecognitionAuthority,intent:AcceptedIntent,posting:unknown):Promise<PostingBinding>;
  verifyPublication(authority:RecognitionAuthority,intent:AcceptedIntent,posting:PostingBinding):Promise<VerifiedPublication>;
  verifyCancellation(authority:RecognitionAuthority,intent:AcceptedIntent):Promise<string>;
  original:OriginalIdentification;
  quotas:{service:number;community:number};
  wake(reservationId:string):Promise<void>;
  wakeRecording(recordingId:string):Promise<void>;
  now?:()=>number;
}
export function sharedReservationService(ports:SharedReservationPorts) {
  const profile=recognitionProfile(ports.profile), now=ports.now??Date.now,
    store=()=>new ReservationStore(ports.db,profile.namespace);
  insist(ports.signer.address.toLowerCase()===profile.signer,"recognition_signing_pin_mismatch",503);
  integer(ports.quotas.service,1,1000000);integer(ports.quotas.community,1,1000000);
  const authority=async(id:string)=>{
    const loaded=await ports.loadAuthority(id),a=loaded?recognitionAuthority(loaded):null;
    insist(a?.enabled&&a.namespace===profile.namespace&&a.profileSha256===profile.sha256,"recognition_pairing_changed",403);return a;
  };
  const fresh=async(a:RecognitionAuthority,p:AcceptedIntent)=>{
    insist(canonical(await authority(a.communityId))===canonical(a),"recognition_pairing_changed",403);
    insist(canonical(acceptedIntent(await ports.verifyIntent(a,p.jobId)))===canonical(p),"recognition_intent_changed",403);
    insist(canonical(await authority(a.communityId))===canonical(a),"recognition_pairing_changed",403);
  };
  const run=async(id:string,claimedCommunity?:string)=>{
    const owned=await ports.db.withSession("first-primary").prepare("SELECT community_id FROM shared_recognition_reservations WHERE reservation_id=? AND namespace=?").bind(id,profile.namespace).first<{community_id:string}>();
    insist(owned && (!claimedCommunity || claimedCommunity===owned.community_id),"recognition_reservation_not_found",404);
    const community=owned.community_id;
    const s=store(),r=await s.snapshot(id,community);
    insist(r,"recognition_reservation_not_found",404);
    const a=await authority(community),p=acceptedIntent(JSON.parse(r.intent_json));
    await fresh(a,p);
    if(r.state==='queued'||r.state==='identification_unknown') {
      let call=await s.call(id);
      if(!call) {
        const start=await s.begin(p,ports.quotas,now());call=start;
        if(start.created) {
          // The journal is durable before the adapter may send. No catch/retry.
          await ports.original.identify(p,call.operation_id,receipt=>s.received(id,call!.operation_id,receipt),async()=>{
            await fresh(a,p);
            const current=await s.call(id);
            insist(current?.state==='unknown'&&current.operation_id===call!.operation_id,"recognition_original_journal_changed",409);
          });
        }
      }
      if(call.state==='unknown') {
        const recovered=await ports.original.recover(call.operation_id);
        if(recovered) await s.received(id,call.operation_id,recovered);
      }
      call=await s.call(id);
      if(!call?.receipt_json) return "catalog_pending";
      const matched=await originalDisposition(new RecognitionStore(ports.db,profile.namespace,now),p,JSON.parse(call.receipt_json));
      await fresh(a,p);
      const enrolled=await s.disposition(p,call,matched);
      if(enrolled.recording_id) await ports.wakeRecording(enrolled.recording_id);
    }
    await fresh(a,p);
    const current=await s.refreshReady(id,community);
    return current?.state==='ready'?"ready":"catalog_pending";
  };
  return {
    run,
    async fetch(request:Request) {
      const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{"cache-control":"no-store"}});
      try {
        const url=new URL(request.url);
        const actions = new Map<string, RecognitionAction>([
          ["/v1/reservations", "intent_reserve"],
          ["/v1/reservations/status", "intent_status"],
          ["/v1/reservations/bind", "intent_bind"],
          ["/v1/reservations/commit", "intent_commit"],
          ["/v1/reservations/cancel", "intent_cancel"],
        ]);
        const action = actions.get(url.pathname);
        insist(url.origin===profile.origin&&!url.search&&request.method==='POST'&&action,"not_found",404);
        const wire=await jsonBody(request,64*1024), wireHash=hashJson(wire),s=store(),
          auth=await authorizeRecognitionRequest(ports.db.withSession('first-primary'),wire,action,profile.namespace,profile.sha256,profile.origin,ports.loadAuthority,()=>Math.floor(now()/1000)),
          a=auth.authority,body=auth.body;
        exact(body,["jobId",...(action==='intent_bind'||action==='intent_commit'?["posting"]:[])]);
        const p=acceptedIntent(await ports.verifyIntent(a,text(body.jobId,128)));
        insist(p.communityId===a.communityId&&p.communityOrigin===a.communityOrigin&&p.configurationRevision===a.configurationRevision&&
          p.namespace===profile.namespace&&p.profileSha256===profile.sha256,"recognition_intent_scope_mismatch",403);
        await fresh(a,p);
        const id=reservationId(p);
        let r:ReservationSnapshot|null;
        if(action==='intent_reserve') {
          r=await s.accept(p); await ports.wake(id);
        } else r=await s.snapshot(id,a.communityId);
        insist(r?.intent_json===canonical(p),"recognition_reservation_conflict",409);
        if(action==='intent_bind'||action==='intent_commit') {
          const posting=await ports.verifyPosting(a,p,body.posting);
          await fresh(a,p);
          if(action==='intent_bind') r=await s.bind(id,a.communityId,posting);
          else {
            insist(r.posting_json===canonical(posting),"recognition_posting_binding_conflict",409);
            const publication=await ports.verifyPublication(a,p,posting);
            await fresh(a,p);
            // Fresh primary read after receipt/authority awaits, before atomic promotion.
            const fence=await s.snapshot(id,a.communityId);
            insist(fence?.posting_json===canonical(posting)&&fence.recording_state==='ready'&&
              (fence.state==='committing'||fence.state==='committed'),"recognition_promotion_changed",409);
            r=await s.promote(p,posting,publication);
          }
        } else if(action==='intent_cancel') {
          const evidence=await ports.verifyCancellation(a,p);await fresh(a,p);await s.cancel(p,evidence);
          r=await s.snapshot(id,a.communityId);
          if(r?.recording_id) await ports.wakeRecording(r.recording_id);
        } else r=await s.refreshReady(id,a.communityId);
        insist(r,"recognition_reservation_not_found",404);
        const before=canonical(r),issuedAt=Math.floor(now()/1000),
          purpose:ReservationReceipt['purpose']=action==='intent_bind'?'posting_bound':action==='intent_commit'?'publication_promoted':'accepted_intent',
          payload:ReservationReceipt={schema:'pirate.recognition-reservation-receipt/1',purpose,namespace:profile.namespace,profileSha256:profile.sha256,
            communityId:a.communityId,configurationRevision:a.configurationRevision,requestSha256:wireHash,intentSha256:hashJson(p),reservationId:id,
            recordingId:r.recording_id,state:r.state,recordingState:r.recording_state,postingSha256:r.posting_json?hashJson(JSON.parse(r.posting_json)):null,
            publicationSha256:r.publication_json?hashJson(JSON.parse(r.publication_json)):null,issuedAt,expiresAt:Math.min(issuedAt+60,auth.authorization.expiresAt)};
        const receipt=await signReservation(ports.signer,payload);
        if(r.state==='committed') {
          insist(r.posting_json&&r.publication_json,"recognition_chain_receipt_missing",409);
          const publication=await ports.verifyPublication(a,p,JSON.parse(r.posting_json));
          insist(canonical(publication)===r.publication_json,"recognition_published_facts_changed",409);
        }
        await fresh(a,p);
        insist(canonical(await s.snapshot(id,a.communityId))===before&&payload.expiresAt>Math.floor(now()/1000),"recognition_reservation_changed",409);
        return reply({receipt},r.state==='committed'||r.state==='ready'||r.state==='committing'?200:202);
      } catch(error) {return reply({error:error instanceof CommunityError?error.code:'recognition_service_unavailable'},error instanceof CommunityError?error.status:503);}
    },
    async recover() {
      const rows=await ports.db.withSession('first-primary').prepare(`SELECT reservation_id FROM shared_recognition_reservations WHERE namespace=?
        AND state IN ('queued','identification_unknown','enrollment_pending') ORDER BY reservation_id LIMIT 20`).bind(profile.namespace).all<{reservation_id:string}>();
      for(const r of rows.results) await ports.wake(r.reservation_id);
    },
  };
}
