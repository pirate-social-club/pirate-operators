import { accountSession, type AuthContext } from "../packages/community/accounts.ts";
import { insist,object } from "../packages/community/common.ts";
import { nativeDigest, nativeOriginal, nativeCurrent } from "../packages/community/native-business-binding.ts";
import { authenticateNativeReadback } from "../packages/community/native-readback-request.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { nativeCanonical } from "../packages/community/native-business-binding.ts";
import {nativeLearningFences,type NativeBusinessFence} from "../packages/community/native-business-fences.ts";
import type {CommunityPrivateDance} from "./community-private-dance.ts";
import {validateAuthority} from "../packages/dance/validation.ts";
import {danceAtomicPredicates} from "../packages/dance/fence.ts";

export interface ApplicationNativeEnv {
  DB: D1Database;
  NATIVE_APPLICATION_ORIGINAL_JSON?: string;
  NATIVE_READBACK_KEY?: string;
}
export async function nativeApplicationOriginal(env: ApplicationNativeEnv) {
  insist(env.NATIVE_APPLICATION_ORIGINAL_JSON,"native_application_original_required",503);
  const original=await nativeOriginal(env.NATIVE_APPLICATION_ORIGINAL_JSON);
  const stored=await env.DB.withSession("first-primary").prepare(
    "SELECT original_digest,original_json FROM native_application_original WHERE singleton=1",
  ).first<{original_digest:string;original_json:string}>();
  insist(stored?.original_digest===nativeDigest(original) &&
    stored.original_json===nativeCanonical(original),"native_application_original_changed",503);
  return original;
}
export async function nativeBusinessResponse(input: {
  request:Request;env:ApplicationNativeEnv;
  configuration():Promise<CommunityConfig>;business():Promise<Response>;
  privateDance?(config:CommunityConfig):CommunityPrivateDance|Promise<CommunityPrivateDance>;
}) {
  if(!input.request.headers.has("X-Pirate-Native-Request"))return input.business();
  insist(input.env.NATIVE_READBACK_KEY,"native_readback_key_required",503);
  const scope=await authenticateNativeReadback(input.request,input.env.NATIVE_READBACK_KEY);
  const original=await nativeApplicationOriginal(input.env),p=original.record.body;
  const current=await nativeCurrent(scope.current,original);
  const resource=p.profile.identity.resources[scope.role==="media"?"privateData":scope.role==="learning"?"learning":"application"];
  insist(typeof resource==="string" && resource.length>0 &&
    (scope.role!=="learning"||p.profile.settings.features.learning) &&
    scope.installationId===p.installationId && scope.profileDigest===p.profileDigest &&
    scope.generation===current.generation && scope.resourceId===resource,"native_original_request_mismatch",403);
  const path=new URL(input.request.url).pathname;
  const submission=scope.role==="media"?/^\/api\/uploads\/([a-f0-9-]{36})$/.exec(path):null;
  const match=submission??(scope.role==="media"?/^\/api\/media\/([a-f0-9-]{36})$/.exec(path):
    scope.role==="learning"?/^\/api\/study\/lessons\/([a-zA-Z0-9_-]{16,128})$/.exec(path):null);
  insist(scope.role==="application"||scope.role==="login"?path==="/api/session":!!match,"native_business_endpoint_required",403);
  const config=await input.configuration();
  insist(nativeCanonical(config)===nativeCanonical(p.profile.infrastructure.configuration),"native_current_directory_changed",409);
  const context:AuthContext={communityId:config.communityId,origin:config.app.origin};
  const beforeSession=await accountSession(input.request,input.env.DB,context);
  const uploadBinding=submission?await input.env.DB.withSession("first-primary").prepare(
    "SELECT object_key FROM media_submissions WHERE submission_id=? AND account_id=?",
  ).bind(submission[1]!,beforeSession.account_id).first<{object_key:string}>():null;
  if(submission)insist(uploadBinding,"submission_not_found",404);
  const fences:NativeBusinessFence[]=[];
  if(scope.role==="media"&&!submission){
    insist(input.privateDance,"native_private_authority_unconfigured",503);
    const runtime=await input.privateDance(config);
    await runtime.current?.();
    const facts=await runtime.dance.authority(config.communityId,beforeSession.account_id,beforeSession.account_id);
    validateAuthority(facts,beforeSession.account_id,beforeSession.account_id);
    fences.push(facts.fence);
  }
  if(scope.role==="learning")fences.push(...await nativeLearningFences(input.env.DB,beforeSession.account_id));
  const response=await input.business();
  if(!response.ok)return response;
  // Original private routes still authenticate roles/consent and execute their
  // own final authority fences. This layer never creates a business result.
  const value:unknown=await response.clone().json();
  insist(value!==null && typeof value==="object"&&!Array.isArray(value),"native_business_json_required",503);
  insist(nativeCanonical(await input.configuration())===nativeCanonical(config),"native_current_directory_changed",409);
  const session=await accountSession(input.request,input.env.DB,context);
  insist(session.session_hash===beforeSession.session_hash,"native_business_session_changed",409);
  const kind=scope.role==="application"||scope.role==="login"?"session":submission?"submission":scope.role;
  const id=kind==="session"?session.session_hash:match![1];
  const upload=submission?object(value):null;
  let uploadArgs:(string|number)[]|undefined;
  if(upload){
    const {state,objectEtag,audioSha256,audioBytes}=upload;
    insist(upload.submissionId===id && (state==="uploaded"||state==="sealed") &&
      typeof objectEtag==="string" && typeof audioSha256==="string" && typeof audioBytes==="number",
      "native_actual_upload_required",409);
    insist(uploadBinding,"native_upload_scope_missing",409);
    uploadArgs=[id,state,objectEtag,audioSha256,audioBytes,uploadBinding.object_key];
  }
  const business=kind==="submission"?
    "SELECT x.idempotency_key AS requestId,x.upload_state AS outcome FROM native_business_bindings b "+
    "JOIN media_submissions x ON x.submission_id=b.submission_id AND x.submission_id=? "+
    "WHERE x.account_id=b.account_id AND x.idempotency_key=b.request_id "+
    "AND x.request_hash=json_extract(b.proof_json,'$.requestHash') "+
    "AND x.upload_state=? AND x.object_etag=? AND x.audio_sha256=? AND x.audio_bytes=? AND x.object_key=?":
    kind==="session"?
    `SELECT b.request_id AS requestId,'authenticated' AS outcome FROM native_business_bindings b
      JOIN community_sessions x ON x.session_hash=b.session_hash AND x.session_hash=?
      JOIN login_challenges c ON c.challenge_id=b.request_id AND c.consumed=1
      JOIN credential_bindings k ON k.binding_id=x.binding_id AND k.account_id=x.account_id AND k.subject=c.subject
      WHERE x.expires_at>? AND x.community_id=? AND x.community_origin=?
      AND json_extract(b.proof_json,'$.message')=c.message`:
    kind==="media"?
    `SELECT x.request_id AS requestId,x.state AS outcome FROM native_business_bindings b
      JOIN community_media x ON x.id=b.media_id AND x.id=?
      WHERE x.expires_at>? AND x.community_id=? AND ?=? AND x.account_id=b.account_id
      AND x.request_id=b.request_id AND x.state NOT IN ('withdrawn','revoked','expired')`:
    `SELECT x.request_id AS requestId,json_extract(x.state_json,'$.status') AS outcome FROM native_business_bindings b
      JOIN study_lessons x ON x.lesson_id=b.lesson_id AND x.lesson_id=?
      WHERE json_extract(x.state_json,'$.expiresAt')>? AND x.community_id=? AND ?=?
      AND x.history_deleted_at IS NULL AND x.account_id=b.account_id AND x.request_id=b.request_id`;
  const now=Date.now(),database=input.env.DB.withSession("first-primary");
  const query=business+` AND b.kind=? AND b.record_id=? AND b.account_id=? AND b.original_digest=?
    AND EXISTS(SELECT 1 FROM community_sessions s JOIN credential_bindings k ON k.binding_id=s.binding_id
      AND k.account_id=s.account_id WHERE s.session_hash=? AND s.expires_at>?
      AND s.community_id=? AND s.community_origin=?)
    AND EXISTS(SELECT 1 FROM native_application_original o WHERE o.singleton=1 AND o.original_digest=?)`;
  const businessArgs=uploadArgs??
    [id,now,context.communityId,context.origin,...(kind==="session"?[]:[context.origin])];
  const args=[...businessArgs,kind,id,session.account_id,nativeDigest(original),
    session.session_hash,now,context.communityId,context.origin,nativeDigest(original)];
  // Same atomic primary batch as the joined result. Reuse the accepted exact
  // predicate recovery; do not rebuild a deep packed fence or exceed D1 binds.
  const guards=fences.flatMap(danceAtomicPredicates).map(f=>{
    insist(f.values.length+1<=100,"native_fence_bind_budget",503);
    return database.prepare(`INSERT INTO native_binding_guards(id,valid) SELECT ?,CASE WHEN (${f.sql}) THEN 1 ELSE 0 END`)
      .bind(crypto.randomUUID(),...f.values);
  });
  const result=await database.batch<{requestId:string;outcome:string;generation:number}>([
    ...guards,
    database.prepare(`INSERT INTO native_readback_nonces(nonce,expires_at,generation,current_json)
      SELECT ?,?,?,? WHERE EXISTS(${query})`).bind(scope.nonce,scope.expiresAt,current.generation,nativeCanonical(scope.current),...args),
    database.prepare(`INSERT INTO native_binding_guards(id,valid) VALUES(?,CASE WHEN changes()=1 AND ?>? THEN 1 ELSE 0 END)`)
      .bind(crypto.randomUUID(),scope.expiresAt,now),
    database.prepare(`SELECT business.requestId,business.outcome,n.generation FROM (${query}) business
      JOIN native_readback_nonces n ON n.nonce=? AND n.current_json=?`).bind(...args,scope.nonce,nativeCanonical(scope.current)),
  ]);
  const rows=result.at(-1)!.results;
  insist(rows.length===1 && typeof rows[0]!.requestId==="string" && typeof rows[0]!.outcome==="string",
    "native_persisted_business_missing",409);
  insist(scope.expiresAt>Date.now()&&current.expiresAt>Date.now(),"native_readback_expired",403);
  const nativeReadback={installationId:p.installationId,resourceId:resource,requestId:rows[0]!.requestId,
    generation:rows[0]!.generation,outcome:rows[0]!.outcome,profileDigest:p.profileDigest,accountId:session.account_id};
  const headers=new Headers(response.headers);headers.delete("content-length");headers.delete("etag");headers.delete("content-encoding");
  headers.set("cache-control","private, no-store");
  return Response.json({...value,nativeReadback},{status:response.status,headers});
}
