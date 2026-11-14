import { canonical, hashJson, insist, object } from "./common.ts";
import { acceptedIntent, recognitionProfile, reservationId, type AcceptedIntent } from "../recognition/intent.ts";
import type { Submission, OwnerSongMetadata, SongMetadata } from "./submissions.ts";

export interface CatalogObligation {
  job_id:string; intent_json:string; intent_sha256:string; reservation_id:string;
  state:"pending" | "reserved" | "posting" | "receipt" | "complete";
  posting_json:string|null; chain_receipt_json:string|null; promotion_receipt_json:string|null;
}
/** Pure construction from already sealed canonical fields, never browser facts. */
export function intentFromSealed(value:{jobId:string;inputHash:string;authority:Record<string,unknown>;
  row:Submission;metadata:OwnerSongMetadata|SongMetadata;acceptedAt:number}):AcceptedIntent {
  const {row,authority,metadata}=value,profile=recognitionProfile(authority.recognition);
  insist('terms' in metadata && metadata.terms && row.object_etag,"publication_terms_required",409);
  return acceptedIntent({schema:"pirate.recognition-accepted-intent/1",namespace:profile.namespace,profileSha256:profile.sha256,
    communityId:authority.communityId,communityOrigin:authority.communityOrigin,configurationRevision:authority.configurationRevision,
    jobId:value.jobId,submissionId:row.submission_id,inputHash:value.inputHash,authoritySha256:hashJson(authority),
    ownerAuthorizationSha256:authority.ownerAuthorizationSha256,creatorKey:`eip155:6343:${row.captured_wallet.toLowerCase()}`,
    postId:row.post_id,publicationRevision:1,audioSha256:row.audio_sha256,audioBytes:row.audio_bytes,audioObjectKey:row.object_key,
    audioRevision:1,audioEtag:row.object_etag,metadataSha256:hashJson(metadata),termsRevision:metadata.terms.revision,
    termsSha256:hashJson(metadata.terms),allowsDerivatives:metadata.terms.allowsDerivatives,acceptedAt:value.acceptedAt});
}
/** Included in sealSubmission's admission transaction. A rollback guard rejects a
 * missing or mismatched obligation before that transaction can commit. */
export function catalogObligationStatement(db:D1Database,p:AcceptedIntent) {
  return db.prepare(`INSERT INTO publication_catalog_obligations(job_id,intent_json,intent_sha256,reservation_id,state)
    SELECT ?,?,?,?,'pending' WHERE EXISTS(SELECT 1 FROM publication_jobs WHERE job_id=? AND input_hash=?) ON CONFLICT DO NOTHING`)
    .bind(p.jobId,canonical(p),hashJson(p),reservationId(p),p.jobId,p.inputHash);
}
export async function catalogObligation(db:D1Database,jobId:string) {
  const row=await db.withSession('first-primary').prepare(`SELECT o.* FROM publication_catalog_obligations o
    JOIN publication_jobs j ON j.job_id=o.job_id WHERE o.job_id=? AND json_extract(o.intent_json,'$.inputHash')=j.input_hash`)
    .bind(jobId).first<CatalogObligation>();
  insist(row,"catalog_obligation_missing",503);return row;
}
export async function retainCatalogPosting(db:D1Database,p:AcceptedIntent,posting:unknown) {
  const json=canonical(posting);
  await db.prepare(`UPDATE publication_catalog_obligations SET state='posting',posting_json=?
    WHERE job_id=? AND intent_sha256=? AND state IN ('reserved','posting') AND (posting_json IS NULL OR posting_json=?)
    AND EXISTS(SELECT 1 FROM external_operations e WHERE e.job_id=publication_catalog_obligations.job_id
      AND e.operation_id=json_extract(?,'$.operationId') AND e.request_hash=json_extract(?,'$.requestHash') AND e.prepared_json IS NOT NULL)`)
    .bind(json,p.jobId,hashJson(p),json,json,json).run();
  const row=await catalogObligation(db,p.jobId);
  insist(row.posting_json===json,"catalog_posting_binding_changed",409);
}
export async function retainCatalogChainReceipt(db:D1Database,p:AcceptedIntent) {
  // Join the actual confirmed durable operation. No publisher success assertion.
  await db.prepare(`UPDATE publication_catalog_obligations SET state='receipt',chain_receipt_json=(
      SELECT result_json FROM external_operations e WHERE e.job_id=publication_catalog_obligations.job_id AND e.step='publication' AND e.status='confirmed'
      AND e.operation_id=json_extract(posting_json,'$.operationId') AND e.provider_id=json_extract(posting_json,'$.transactionHash'))
    WHERE job_id=? AND intent_sha256=? AND state IN ('posting','receipt') AND EXISTS(SELECT 1 FROM external_operations e
      WHERE e.job_id=publication_catalog_obligations.job_id AND e.step='publication' AND e.status='confirmed'
      AND e.operation_id=json_extract(posting_json,'$.operationId') AND e.provider_id=json_extract(posting_json,'$.transactionHash'))`)
    .bind(p.jobId,hashJson(p)).run();
  const row=await catalogObligation(db,p.jobId);insist(row.chain_receipt_json,"catalog_chain_receipt_pending",409);return object(JSON.parse(row.chain_receipt_json));
}
