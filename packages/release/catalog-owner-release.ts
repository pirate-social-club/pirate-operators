import { sha256 } from "viem";
import { canonical, hashJson, insist } from "../community/common.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { catalogObligation } from "../community/catalog-outbox.ts";
import { readCanonicalIntent, type CanonicalIntentPorts } from "../recognition/canonical-intent.ts";
import { reservationId } from "../recognition/intent.ts";
import type { ReservationClient } from "../recognition/reservation-client.ts";
import type { AdmittedRelease, ReleaseContext } from "./authority.ts";
import { ownerBudgetKey, reserveOwnerBudget, type OwnerBudgetGrant } from "./owner-grant.ts";

/** Reviewed private composition only. No JSON factory or health substitute. */
export interface CatalogOwnerReleaseInputs {
  canonical(communityId:string):Promise<CanonicalIntentPorts>;
  recognition(communityId:string):Promise<ReservationClient>;
}
export async function establishCatalogOwnerRelease(db:D1Database,context:ReleaseContext,grant:OwnerBudgetGrant,config:CommunityConfig,
  inputs:CatalogOwnerReleaseInputs,now:number,mode:'execute'|'reconcile'):Promise<AdmittedRelease|null> {
  const ports=await inputs.canonical(config.communityId),{intent:p,input,config:fresh}=await readCanonicalIntent(ports,context.jobId);
  insist(canonical(fresh)===canonical(config)&&context.recipient===grant.ownerWallet&&
    context.postId===p.postId&&context.authorId===input.row.author_id&&context.admissionId===input.context.admissionId&&
    canonical(context)===canonical(input.context),"catalog_release_context_changed",409);
  const obligation=await catalogObligation(ports.db,p.jobId), client=await inputs.recognition(config.communityId),ready=await client.ready(p);
  insist(ready.intentSha256===hashJson(p)&&ready.reservationId===reservationId(p)&&ready.recordingId,"catalog_pending",503);
  const scope=ownerBudgetKey(grant,'songs').scope,key=hashJson({owner:scope,jobId:p.jobId}),
    requestHash=hashJson({context,scope,period:ownerBudgetKey(grant,'songs').period,configuration:hashJson(config)}),evidence=hashJson(p);
  const prior=await db.withSession('first-primary').prepare('SELECT * FROM owner_releases WHERE job_id=?').bind(p.jobId)
    .first<{release_key:string;request_hash:string;context_json:string;admission_sha256:string;created_at:number}>();
  if(mode==='reconcile'&&!prior)return null;
  if(mode==='execute') {
    await reserveOwnerBudget(db,grant,'songs',`owner-song:${p.jobId}`,requestHash,'1',now);
    await db.prepare(`INSERT INTO owner_releases(job_id,release_key,owner_scope,request_hash,context_json,admission_sha256,created_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(p.jobId,key,scope,requestHash,canonical(context),evidence,Math.floor(p.acceptedAt/1000)).run();
  }
  const saved=await db.withSession('first-primary').prepare('SELECT * FROM owner_releases WHERE job_id=?').bind(p.jobId)
    .first<{release_key:string;request_hash:string;context_json:string;admission_sha256:string;created_at:number}>();
  insist(saved?.release_key===key&&saved.request_hash===requestHash&&saved.context_json===canonical(context)&&saved.admission_sha256===evidence,
    'owner_release_already_bound',409);
  const media=await ports.media.get(p.audioObjectKey);
  insist(media,'catalog_private_media_missing',503);
  const bytes=new Uint8Array(await media.arrayBuffer());
  insist(bytes.byteLength===p.audioBytes&&sha256(bytes)===p.audioSha256,'catalog_private_media_changed',409);
  // Both private inputs and readiness were awaited; re-anchor canonical authority.
  insist(canonical((await readCanonicalIntent(ports,p.jobId)).intent)===canonical(p)&&obligation.intent_sha256===evidence,'catalog_release_changed',409);
  return {context,grant:{sha256:key,contentSha256:p.audioSha256},unregistered:true,config,
    prepared:{title:input.metadata.title,lyrics:input.metadata.lyrics.sourceText},
    decision:{decision:'publish',rating:context.rating==='adult'?'adult_18':'general',coverDisplayed:false,
      used:[evidence],missing:[],reasons:['owner_declaration_automated_content_deferred']},
    evidenceSha256:evidence,createdAt:saved.created_at,audioObjectKey:p.audioObjectKey,
    catalog:{intent:p,recordingId:ready.recordingId}};
}
