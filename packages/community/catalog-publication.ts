import { canonical, hashJson, insist, object } from "./common.ts";
import { catalogObligation, retainCatalogChainReceipt, retainCatalogPosting } from "./catalog-outbox.ts";
import { canonicalPosting, readCanonicalIntent, type CanonicalIntentPorts } from "../recognition/canonical-intent.ts";
import { reservationClient } from "../recognition/reservation-client.ts";
import { preparedOperation, type OperationResult, type Reconciliation } from "./publication.ts";
import { parseTransaction } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { ExternalOperation } from "./publication-store.ts";
import { reservationId, type PostingBinding } from "../recognition/intent.ts";
export interface CatalogPublicationPorts extends CanonicalIntentPorts {
  publisher:PrivateKeyAccount;
  transport?:(request:Request)=>Promise<Response>;
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
  const client=reservationClient({profile:config.policies.recognition,publisher:ports.publisher,transport:ports.transport,
    current:async()=>{insist(canonical((await readCanonicalIntent(ports,p.jobId)).intent)===canonical(p),"recognition_intent_changed",409);},
    beforeSend:fence});
  const result=(recordingId:string,state:string,publicationSha256:string|null=null):OperationResult=>({kind:'confirmed',providerId:hashJson({intent:hashJson(p),state}),
    value:{reservationId:reservationId(p),
      intentSha256:hashJson(p),recordingId,state,publicationSha256,
      decision:{decision:'publish',rating:'rating' in input.metadata&&input.metadata.rating==='adult'?'adult_18':'general'},evidenceSha256:hashJson(p)}});
  // Stable operation values exclude per-request nonce, issue time and signature.
  const stable=(r:{reservationId:string;recordingId:string|null;state:string;publicationSha256:string|null})=>{
    insist(r.recordingId,"catalog_pending",503);
    const v=result(r.recordingId,r.state==='committed'?'committed':'ready',r.publicationSha256);
    v.value.reservationId=r.reservationId;return v;
  };
  return {
    async reserve(mode:'execute'|'reconcile'):Promise<Reconciliation> {
      const r=mode==='execute'?await client.reserve(p):await client.status(p);
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
      const r=mode==='execute'?await client.commit(p,posting):{payload:await client.status(p),receipt:null};
      if(r.payload.state!=='committed') return r.payload.state==='committing'&&mode==='reconcile' ? {kind:'absent',proof:canonical({reservationId:r.payload.reservationId,postingSha256:r.payload.postingSha256,state:r.payload.state})} : {kind:'unknown'};
      insist(r.payload.recordingState==='ready'&&r.payload.postingSha256===hashJson(posting)&&r.payload.publicationSha256,"catalog_promotion_pending",503);
      if(mode==='execute') await ports.db.prepare(`UPDATE publication_catalog_obligations SET state='complete',promotion_receipt_json=?
        WHERE job_id=? AND intent_sha256=? AND chain_receipt_json IS NOT NULL AND posting_json=? AND state='receipt' AND promotion_receipt_json IS NULL`)
        .bind(canonical(r.receipt),p.jobId,hashJson(p),canonical(posting)).run();
      // A lost commit reply is recovered through the same commit operation on execute;
      // read-only reconciliation cannot manufacture a missing local promotion receipt.
      if((await catalogObligation(ports.db,p.jobId)).state!=='complete') return {kind:'absent',proof:'central_committed_local_ack_pending'};
      return stable(r.payload);
    },
  };
}
