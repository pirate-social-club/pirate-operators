import { keccak256, parseTransaction, recoverTransactionAddress, type TransactionSerializedLegacy } from "viem";
import { canonical, hashJson, insist, object } from "../community/common.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { publicationInput } from "../community/publication-input.ts";
import { requireAuthorizedOwner } from "../community/owner-authorization.ts";
import { catalogOwner } from "../community/owner-policy.ts";
import { catalogObligation, intentFromSealed } from "../community/catalog-outbox.ts";
import { preparedOperation } from "../community/publication.ts";
import { publicationData } from "../community/post-chain.ts";
import { reconcilePosting, type PostingPorts } from "../community/publication-posting.ts";
import type { ExternalOperation } from "../community/publication-store.ts";
import { acceptedIntent, type AcceptedIntent, type PostingBinding } from "./intent.ts";
import { verifiedPublication } from "./model.ts";

/** The service selects these private ports from its pinned community registry.
 * A signed publisher request cannot select a database, object, RPC or owner. */
export interface CanonicalIntentPorts {
  db:D1Database; media:R2Bucket;
  currentConfiguration():Promise<CommunityConfig>;
  ownerAuthorization():Promise<unknown>;
  posting:PostingPorts;
  /** Existing linked-account fence, mandatory in connected authority compositions. */
  currentAccount(accountId:string,wallet:string,authorId:string):Promise<void>;
  /** Existing owner recognition allowance; same operation never replenishes it. */
  authorizeRecognition(operationId:string,requestHash:string):Promise<void>;
}
export async function readCanonicalIntent(ports:CanonicalIntentPorts,jobId:string) {
  const snapshot=()=>ports.db.withSession('first-primary').prepare(`SELECT j.input_hash,j.authority_json,j.created_at,s.*,
      o.intent_json,o.intent_sha256 FROM publication_jobs j JOIN media_submissions s ON s.submission_id=j.submission_id
      JOIN publication_catalog_obligations o ON o.job_id=j.job_id JOIN community_accounts a ON a.account_id=s.account_id AND a.author_id=s.author_id
      WHERE j.job_id=? AND s.upload_state='sealed' AND EXISTS(SELECT 1 FROM credential_bindings b WHERE b.account_id=a.account_id AND b.network=6343 AND b.subject=s.captured_wallet)`)
    .bind(jobId).first<Record<string,unknown>>();
  const before=await snapshot(),config=await ports.currentConfiguration();
  insist(before&&catalogOwner(config.policies.admission)&&config.policies.recognition,"recognition_owner_intent_unavailable",403);
  const input=await publicationInput(ports.db,ports.media,jobId,config),
    owner=await requireAuthorizedOwner(await ports.ownerAuthorization(),config,input.row.captured_wallet);
  await ports.currentAccount(input.row.account_id,input.row.captured_wallet,input.row.author_id);
  insist(config.policies.recognition.signer!==owner.ownerWallet,"recognition_signer_role_collision",403);
  insist(hashJson(owner)===input.authority.ownerAuthorizationSha256,"recognition_owner_authority_changed",403);
  const intent=intentFromSealed({jobId,inputHash:input.job.input_hash,authority:input.authority,row:input.row,metadata:input.metadata,acceptedAt:input.createdAt}),
    obligation=await catalogObligation(ports.db,jobId);
  insist(obligation.intent_json===canonical(intent)&&obligation.intent_sha256===hashJson(intent),"recognition_intent_changed",409);
  insist(canonical(await ports.currentConfiguration())===canonical(config),"recognition_authority_changed",403);
  await ports.currentAccount(input.row.account_id,input.row.captured_wallet,input.row.author_id);
  const head=await ports.media.head(intent.audioObjectKey);
  insist(head?.etag===intent.audioEtag&&head.size===intent.audioBytes&&head.customMetadata?.sha256===intent.audioSha256,
    "recognition_sealed_media_changed",409);
  const finalOwner=await requireAuthorizedOwner(await ports.ownerAuthorization(),config,input.row.captured_wallet);
  insist(hashJson(finalOwner)===intent.ownerAuthorizationSha256&&canonical(await ports.currentConfiguration())===canonical(config),
    "recognition_authority_changed",403);
  await ports.currentAccount(input.row.account_id,input.row.captured_wallet,input.row.author_id);
  const after=await snapshot();
  insist(canonical(after)===canonical(before),"recognition_intent_changed",409);
  return {intent:acceptedIntent(intent),input,config};
}
export async function canonicalPosting(ports:CanonicalIntentPorts,p:AcceptedIntent,claimed:unknown):Promise<PostingBinding> {
  const current=await readCanonicalIntent(ports,p.jobId);
  insist(canonical(current.intent)===canonical(p),"recognition_intent_changed",409);
  const operation=await ports.db.withSession('first-primary').prepare("SELECT * FROM external_operations WHERE job_id=? AND step='publication'")
    .bind(p.jobId).first<ExternalOperation>();
  insist(operation,"recognition_posting_not_prepared",409);
  insist(operation.operation_id===hashJson({job:p.jobId,step:'publication'})&&
    hashJson(JSON.parse(operation.request_json))===operation.request_hash,"recognition_posting_operation_changed",409);
  const prepared=preparedOperation(operation);
  insist(prepared.replay.kind==='same_signed_transaction',"recognition_signed_posting_required",409);
  const raw=prepared.replay.signedTransaction,tx=parseTransaction(raw),publication=object(JSON.parse(operation.request_json)).publication,
    post=object(publication),pin=object(object(current.input.progress.pin_manifest).pin),
    expected={communityId:p.communityId as `0x${string}`,postId:p.postId as `0x${string}`,authorId:current.input.row.author_id as `0x${string}`,
      configurationRevision:p.configurationRevision,manifestSha256:String(pin.sha256) as `0x${string}`,manifestURI:String(pin.uri)};
  insist(tx.type==='legacy',"recognition_signed_posting_changed",409);
  insist(canonical(post)===canonical(expected)&&tx.chainId===6343&&tx.to?.toLowerCase()===current.config.postsContract&&
    tx.data===publicationData(expected)&&(tx.value??0n)===0n&&tx.nonce!==undefined&&keccak256(raw)===prepared.replay.transactionHash&&
    (await recoverTransactionAddress({serializedTransaction:raw as TransactionSerializedLegacy})).toLowerCase()===current.config.publisher,"recognition_signed_posting_changed",409);
  const binding:PostingBinding={operationId:operation.operation_id,requestHash:operation.request_hash,signedTransaction:raw,
    transactionHash:prepared.replay.transactionHash,nonce:tx.nonce};
  insist(canonical(binding)===canonical(claimed),"recognition_posting_binding_conflict",409);
  const obligation=await catalogObligation(ports.db,p.jobId);
  insist(obligation.posting_json===canonical(binding),"recognition_local_posting_journal_missing",409);
  insist(canonical((await readCanonicalIntent(ports,p.jobId)).intent)===canonical(p),"recognition_intent_changed",409);
  return binding;
}
export async function canonicalPublication(ports:CanonicalIntentPorts,p:AcceptedIntent,posting:PostingBinding) {
  await canonicalPosting(ports,p,posting);
  const operation=await ports.db.withSession('first-primary').prepare("SELECT * FROM external_operations WHERE operation_id=? AND job_id=? AND step='publication' AND status='confirmed'")
    .bind(posting.operationId,p.jobId).first<ExternalOperation>();
  insist(operation?.result_json&&operation.provider_id===posting.transactionHash,"recognition_chain_receipt_missing",409);
  const result=await reconcilePosting(operation,ports.posting);
  insist(result.kind==='confirmed'&&result.providerId===posting.transactionHash&&canonical(result.value)===operation.result_json,"recognition_chain_receipt_changed",409);
  await canonicalPosting(ports,p,posting);
  return verifiedPublication({namespace:p.namespace,communityId:p.communityId,postId:p.postId,publicationRevision:p.publicationRevision,
    configurationRevision:p.configurationRevision,creatorKey:p.creatorKey,audioSha256:p.audioSha256,audioBytes:p.audioBytes,
    audioObjectKey:p.audioObjectKey,audioRevision:p.audioRevision,termsRevision:p.termsRevision,termsSha256:p.termsSha256,
    allowsDerivatives:p.allowsDerivatives,publicationEvidenceSha256:hashJson(result.value)});
}
