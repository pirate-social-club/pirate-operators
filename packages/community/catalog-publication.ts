import { canonical, hashJson, insist, object } from "./common.ts";
import { catalogObligation, retainCatalogChainReceipt, retainCatalogPosting } from "./catalog-outbox.ts";
import { canonicalPosting, readCanonicalIntent, type CanonicalIntentPorts } from "../recognition/canonical-intent.ts";
import { reservationClient } from "../recognition/reservation-client.ts";
import { preparedOperation, type OperationResult, type Reconciliation } from "./publication.ts";
import { parseTransaction } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { ExternalOperation } from "./publication-store.ts";
import { type AcceptedIntent, type PostingBinding } from "../recognition/intent.ts";
import type { ReservationReceipt } from "../recognition/reservation-receipt.ts";
export interface CatalogPublicationPorts extends CanonicalIntentPorts {
  publisher:PrivateKeyAccount;
  transport?:(request:Request)=>Promise<Response>;
  /** Applied at the actual mutating transport boundary; status remains read-only. */
  beforeCatalogDispatch?(operation:ExternalOperation,finalFence:()=>Promise<void>):Promise<void>;
}
/** Stable operation values exclude per-request nonce, issue time and signature. */
export function catalogOperationResult(
  intent: AcceptedIntent,
  metadata: { rating?: string },
  receipt: Pick<ReservationReceipt, "reservationId" | "recordingId" | "state" | "publicationSha256">,
): OperationResult {
  insist(receipt.recordingId, "catalog_pending", 503);
  const state = receipt.state === "committed" ? "committed" : "ready";
  const intentSha256 = hashJson(intent);
  return { kind: "confirmed", providerId: hashJson({ intent: intentSha256, state }), value: {
    reservationId: receipt.reservationId, intentSha256, recordingId: receipt.recordingId, state,
    publicationSha256: receipt.publicationSha256,
    decision: { decision: "publish", rating: metadata.rating === "adult" ? "adult_18" : "general" },
    evidenceSha256: intentSha256,
  } };
}
export async function catalogPublication(ports:CatalogPublicationPorts,operation:ExternalOperation,lease:string|null|undefined) {
  const {intent:p,config,input}=await readCanonicalIntent(ports,operation.job_id);
  insist(config.policies.recognition,"recognition_profile_required",503);
  insist(lease && input.job.lease_token===lease,"publication_lease_lost",409);
  const fence=async()=>{
    const live=await ports.db.withSession('first-primary').prepare(`SELECT e.request_hash,e.prepared_json FROM external_operations e
      JOIN publication_jobs j ON j.job_id=e.job_id WHERE e.operation_id=? AND e.job_id=? AND j.phase=? AND j.lease_token=? AND j.lease_until>?
      AND e.status IN ('prepared','running','uncertain','confirmed')`)
      .bind(operation.operation_id,p.jobId,operation.step,lease,Date.now()).first<{request_hash:string;prepared_json:string|null}>();
    insist(live?.request_hash===operation.request_hash&&live.prepared_json===operation.prepared_json,"publication_lease_lost",409);
  };
  const client=reservationClient({profile:config.policies.recognition,publisher:ports.publisher,transport:async(request)=>{
      if(new URL(request.url).pathname!=="/v1/reservations/status") await ports.beforeCatalogDispatch?.(operation,fence);
      return (ports.transport ?? fetch)(request);
    },
    current:async()=>{insist(canonical((await readCanonicalIntent(ports,p.jobId)).intent)===canonical(p),"recognition_intent_changed",409);},
    beforeSend:fence});
  const stable = (receipt: ReservationReceipt) => catalogOperationResult(
    p, "rating" in input.metadata ? input.metadata : {}, receipt,
  );
  return {
    async reserve(mode:'execute'|'reconcile'):Promise<Reconciliation> {
      let r;
      if(mode==='execute')r=await client.reserve(p);
      else {
        const evidence=await client.statusEvidence(p);
        if(evidence.payload.purpose==='reservation_absent')return {kind:'absent',proof:canonical({request:evidence.request,receipt:evidence.receipt})};
        r=evidence.payload;
      }
      if(!['ready','committing','committed'].includes(r.state)||r.recordingState!=='ready') return {kind:'unknown'};
      await ports.db.prepare("UPDATE publication_catalog_obligations SET state='reserved' WHERE job_id=? AND intent_sha256=? AND state='pending'")
        .bind(p.jobId,hashJson(p)).run();
      // An original admission stays the same even after later commitment.
      return stable({...r,state:'ready',publicationSha256:null});
    },
    async bind() {
      const prepared=preparedOperation(operation);
      insist(prepared.replay.kind==='same_signed_transaction',"recognition_signed_posting_required",409);
      const tx=parseTransaction(prepared.replay.signedTransaction);
      insist(tx.nonce!==undefined,"recognition_signed_posting_required",409);
      const posting:PostingBinding={operationId:operation.operation_id,requestHash:operation.request_hash,
        signedTransaction:prepared.replay.signedTransaction,transactionHash:prepared.replay.transactionHash,nonce:tx.nonce};
      await retainCatalogPosting(ports.db,p,posting);await canonicalPosting(ports,p,posting);
      await client.bind(p,posting);await fence();
    },
    async commit(mode:'execute'|'reconcile'):Promise<Reconciliation> {
      await retainCatalogChainReceipt(ports.db,p);
      const obligation=await catalogObligation(ports.db,p.jobId),posting=await canonicalPosting(ports,p,JSON.parse(obligation.posting_json!));
      const r=mode==='execute'?await client.commit(p,posting):await client.statusEvidence(p);
      const proof=()=>canonical({request:r.request,receipt:r.receipt});
      if(r.payload.state!=='committed') return r.payload.state==='committing'&&mode==='reconcile' ? {kind:'absent',proof:proof()} : {kind:'unknown'};
      insist(r.payload.recordingState==='ready'&&r.payload.postingSha256===hashJson(posting)&&r.payload.publicationSha256,"catalog_promotion_pending",503);
      await ports.db.prepare(`UPDATE publication_catalog_obligations SET state='complete',promotion_receipt_json=?
        WHERE job_id=? AND intent_sha256=? AND chain_receipt_json IS NOT NULL AND posting_json=? AND state='receipt' AND promotion_receipt_json IS NULL`)
        .bind(canonical(r.receipt),p.jobId,hashJson(p),canonical(posting)).run();
      // An authenticated committed status proves the same immutable posting.
      // Retain that actual receipt locally even after the owner's window closes;
      // never send another commit merely to manufacture a missing local receipt.
      if((await catalogObligation(ports.db,p.jobId)).state!=='complete') return {kind:'absent',proof:proof()};
      return stable(r.payload);
    },
  };
}
