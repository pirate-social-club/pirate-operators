import { canonical, hashJson, insist } from "../community/common.ts";
import { associationId, recordingId, verifiedPublication, type VerifiedPublication } from "./model.ts";
import { acceptedIntent, reservationId, type AcceptedIntent, type PostingBinding } from "./intent.ts";

export interface Reservation {
  reservation_id: string; namespace: string; community_id: string; job_id: string;
  intent_json: string; intent_sha256: string;
  state: "queued" | "identification_unknown" | "enrollment_pending" | "ready" | "committing" | "committed" | "cancelled" | "held";
  recording_id: string | null; posting_json: string | null; publication_json: string | null;
  disposition_sha256: string | null;
}
export interface ReservationSnapshot extends Reservation { recording_state: string | null; catalog_revision: number; }
export interface OriginalCall { operation_id: string; request_sha256: string; catalog_revision: number; state: "unknown" | "received"; receipt_json: string | null; }

export class ReservationStore {
  readonly database: D1Database;
  readonly namespace: string;
  constructor(database: D1Database, namespace: string) {
    this.database = database;
    this.namespace = namespace;
  }
  /** Each snapshot has its own first-primary anchor; one joined atomic observation. */
  async snapshot(id: string, community: string) {
    return this.database.withSession("first-primary").prepare(`SELECT p.*,r.state AS recording_state,c.revision AS catalog_revision
      FROM shared_recognition_reservations p LEFT JOIN shared_recognition_recordings r ON r.recording_id=p.recording_id AND r.namespace=p.namespace
      JOIN shared_recognition_catalog_revision c ON c.namespace=p.namespace WHERE p.reservation_id=? AND p.namespace=? AND p.community_id=?`)
      .bind(id,this.namespace,community).first<ReservationSnapshot>();
  }
  async accept(input: AcceptedIntent) {
    const p=acceptedIntent(input), id=reservationId(p);
    insist(p.namespace===this.namespace,"recognition_namespace_mismatch",403);
    await this.database.batch([
      this.database.prepare("INSERT INTO shared_recognition_catalog_revision(namespace) VALUES(?) ON CONFLICT DO NOTHING").bind(this.namespace),
      this.database.prepare("INSERT INTO shared_recognition_original_gate(namespace) VALUES(?) ON CONFLICT DO NOTHING").bind(this.namespace),
      this.database.prepare(`INSERT INTO shared_recognition_reservations(reservation_id,namespace,community_id,job_id,intent_json,intent_sha256,state)
        VALUES(?,?,?,?,?,?,'queued') ON CONFLICT DO NOTHING`).bind(id,this.namespace,p.communityId,p.jobId,canonical(p),hashJson(p)),
    ]);
    const row=await this.snapshot(id,p.communityId);
    insist(row?.intent_json===canonical(p),"recognition_reservation_conflict",409);
    return row;
  }
  async call(id: string) {
    return this.database.withSession("first-primary").prepare("SELECT * FROM shared_recognition_original_calls WHERE reservation_id=?")
      .bind(id).first<OriginalCall>();
  }
  /** Namespace fence + both non-resetting charges + provider intent are one transaction.
   * A lost response leaves the fence in place forever until exact recovery. */
  async begin(p: AcceptedIntent, limits: {service: number; community: number}, now: number) {
    const id=reservationId(p), operation=hashJson({purpose:"original-identification/1",reservationId:id}),
      scopes=[`recognition:${p.namespace}:original`, `recognition:${p.namespace}:${p.communityId}:original`],
      request=hashJson({intent:hashJson(p),operation});
    const results=await this.database.batch([
      ...scopes.map((scope,i)=>this.database.prepare("INSERT INTO shared_recognition_quota_limits(scope,ceiling) VALUES(?,?) ON CONFLICT DO NOTHING").bind(scope,i===0?limits.service:limits.community)),
      this.database.prepare(`UPDATE shared_recognition_original_gate SET reservation_id=? WHERE namespace=? AND (reservation_id IS NULL
        OR EXISTS(SELECT 1 FROM shared_recognition_reservations old WHERE old.reservation_id=shared_recognition_original_gate.reservation_id AND old.state='cancelled'))
        AND EXISTS(SELECT 1 FROM shared_recognition_reservations WHERE reservation_id=? AND state='queued')
        AND NOT EXISTS(SELECT 1 FROM shared_recognition_recordings WHERE namespace=? AND state NOT IN ('ready','deleted'))`).bind(id,this.namespace,id,this.namespace),
      ...scopes.map(scope=>this.database.prepare(`INSERT INTO shared_recognition_quota_charges(operation_id,scope)
        SELECT ?,? WHERE EXISTS(SELECT 1 FROM shared_recognition_original_gate WHERE namespace=? AND reservation_id=?) ON CONFLICT DO NOTHING`).bind(operation,scope,this.namespace,id)),
      this.database.prepare(`INSERT INTO shared_recognition_original_calls(operation_id,reservation_id,request_sha256,catalog_revision,state,started_at)
        SELECT ?,?,?,revision,'unknown',? FROM shared_recognition_catalog_revision c WHERE namespace=?
        AND EXISTS(SELECT 1 FROM shared_recognition_original_gate WHERE namespace=? AND reservation_id=?) ON CONFLICT DO NOTHING`)
        .bind(operation,id,request,now,this.namespace,this.namespace,id),
      this.database.prepare(`UPDATE shared_recognition_reservations SET state='identification_unknown' WHERE reservation_id=? AND state='queued'
        AND EXISTS(SELECT 1 FROM shared_recognition_original_calls WHERE reservation_id=?)`).bind(id,id),
    ]);
    const ceilings=await this.database.withSession("first-primary").prepare("SELECT scope,ceiling FROM shared_recognition_quota_limits WHERE scope IN (?,?)").bind(...scopes).all<{scope:string;ceiling:number}>();
    insist(scopes.every((s,i)=>ceilings.results.find(r=>r.scope===s)?.ceiling===(i===0?limits.service:limits.community)),"recognition_quota_changed",409);
    const call=await this.call(id);
    insist(call?.request_sha256===request,"recognition_catalog_pending",409);
    return {...call,created:results[5]!.meta.changes===1};
  }
  async received(id: string, operation: string, receipt: unknown) {
    const json=canonical(receipt);
    await this.database.prepare(`UPDATE shared_recognition_original_calls SET state='received',receipt_json=?
      WHERE reservation_id=? AND operation_id=? AND receipt_json IS NULL`).bind(json,id,operation).run();
    insist((await this.call(id))?.receipt_json===json,"recognition_original_receipt_conflict",409);
  }
  async disposition(p: AcceptedIntent, call: OriginalCall, matched: {id:string; evidence:string}|null) {
    const id=reservationId(p), rid=matched?.id??recordingId(p), evidence=matched?.evidence??hashJson(JSON.parse(call.receipt_json!));
    insist(call.state==='received' && call.receipt_json,"recognition_original_unknown",409);
    const guard=`EXISTS(SELECT 1 FROM shared_recognition_original_gate g JOIN shared_recognition_catalog_revision c ON c.namespace=g.namespace
      WHERE g.namespace=? AND g.reservation_id=? AND c.revision=?)`;
    await this.database.batch([
      this.database.prepare(`INSERT INTO shared_recognition_recordings(recording_id,namespace,creator_key,audio_sha256,audio_bytes,state)
        SELECT ?,?,?,?,?,'pending' WHERE ?=0 AND ${guard} ON CONFLICT DO NOTHING`)
        .bind(rid,p.namespace,p.creatorKey,p.audioSha256,p.audioBytes,matched?1:0,p.namespace,id,call.catalog_revision),
      this.database.prepare(`UPDATE shared_recognition_reservations SET recording_id=?,disposition_sha256=?,state='enrollment_pending'
        WHERE reservation_id=? AND state='identification_unknown' AND ${guard}
        AND EXISTS(SELECT 1 FROM shared_recognition_recordings r WHERE r.recording_id=? AND r.namespace=? AND r.creator_key=?
          AND ((?=1 AND r.state='ready' AND (EXISTS(SELECT 1 FROM shared_recognition_publications source WHERE source.recording_id=r.recording_id AND source.state='active')
            OR EXISTS(SELECT 1 FROM shared_recognition_reservations source WHERE source.recording_id=r.recording_id AND source.state IN ('enrollment_pending','ready','committing'))))
            OR (?=0 AND r.state IN ('pending','deleted'))))`) 
        .bind(rid,evidence,id,p.namespace,id,call.catalog_revision,rid,p.namespace,p.creatorKey,matched?1:0,matched?1:0),
      // A terminal confirmed deletion may be enrolled under a NEW accepted intent.
      // Canonical identity, attempts and every prior event remain; unknown states
      // can never take this path. This is not an expiry or a journal reset.
      this.database.prepare(`UPDATE shared_recognition_recordings SET state='pending',provider_file_id=NULL,provider_match_id=NULL
        WHERE recording_id=? AND namespace=? AND state='deleted' AND creator_key=? AND audio_sha256=? AND audio_bytes=?
        AND EXISTS(SELECT 1 FROM shared_recognition_reservations WHERE reservation_id=? AND state='enrollment_pending' AND recording_id=?)`)
        .bind(rid,p.namespace,p.creatorKey,p.audioSha256,p.audioBytes,id,rid),
      this.database.prepare(`UPDATE shared_recognition_catalog_revision SET revision=revision+1 WHERE namespace=? AND EXISTS(
        SELECT 1 FROM shared_recognition_reservations WHERE reservation_id=? AND state='enrollment_pending' AND recording_id=?)`)
        .bind(p.namespace,id,rid),
    ]);
    const row=await this.snapshot(id,p.communityId);
    insist(row?.recording_id===rid,"recognition_catalog_changed_or_creator_conflict",409);
    return row;
  }
  async refreshReady(id: string, community: string) {
    await this.database.batch([
      this.database.prepare(`UPDATE shared_recognition_reservations SET state='ready' WHERE reservation_id=? AND namespace=? AND community_id=? AND state='enrollment_pending'
        AND EXISTS(SELECT 1 FROM shared_recognition_recordings r WHERE r.recording_id=shared_recognition_reservations.recording_id AND r.state='ready')`).bind(id,this.namespace,community),
      this.database.prepare(`UPDATE shared_recognition_original_gate SET reservation_id=NULL WHERE namespace=? AND reservation_id=?
        AND EXISTS(SELECT 1 FROM shared_recognition_reservations WHERE reservation_id=? AND state IN ('ready','committing','committed'))`).bind(this.namespace,id,id),
    ]);
    return this.snapshot(id,community);
  }
  async bind(id: string, community: string, posting: PostingBinding) {
    const json=canonical(posting);
    await this.database.prepare(`UPDATE shared_recognition_reservations SET state='committing',posting_json=?
      WHERE reservation_id=? AND namespace=? AND community_id=? AND state IN ('ready','committing') AND (posting_json IS NULL OR posting_json=?)
      AND EXISTS(SELECT 1 FROM shared_recognition_recordings r WHERE r.recording_id=shared_recognition_reservations.recording_id AND r.state='ready')`)
      .bind(json,id,this.namespace,community,json).run();
    const row=await this.snapshot(id,community);
    insist(row?.state==='committing' && row.posting_json===json,"recognition_posting_binding_conflict",409);
    return row;
  }
  /** Actual canonical chain receipt is verified by the caller. Promotion and
   * dropping provisional ownership are atomic; no last-reference gap. */
  async promote(p: AcceptedIntent, posting: PostingBinding, input: VerifiedPublication) {
    const publication=verifiedPublication(input), id=reservationId(p), json=canonical(publication);
    insist(publication.namespace===p.namespace && publication.communityId===p.communityId && publication.postId===p.postId &&
      publication.publicationRevision===p.publicationRevision && publication.configurationRevision===p.configurationRevision &&
      publication.creatorKey===p.creatorKey && publication.audioSha256===p.audioSha256 && publication.audioBytes===p.audioBytes &&
      publication.termsSha256===p.termsSha256 && publication.termsRevision===p.termsRevision && publication.allowsDerivatives===p.allowsDerivatives,
      "recognition_promotion_facts_changed",409);
    await this.database.batch([
      this.database.prepare(`INSERT INTO shared_recognition_publications(association_id,recording_id,namespace,community_id,post_id,publication_revision,publication_json,match_evidence_sha256,state)
        SELECT ?,recording_id,namespace,community_id,?,?,?,CASE WHEN json_extract(intent_json,'$.audioSha256')<>(SELECT audio_sha256 FROM shared_recognition_recordings WHERE recording_id=p.recording_id) THEN disposition_sha256 ELSE NULL END,'active'
        FROM shared_recognition_reservations p WHERE reservation_id=? AND posting_json=? AND state IN ('committing','committed') ON CONFLICT DO NOTHING`)
        .bind(associationId(publication),p.postId,p.publicationRevision,json,id,canonical(posting)),
      this.database.prepare(`UPDATE shared_recognition_reservations SET state='committed',publication_json=? WHERE reservation_id=? AND posting_json=? AND state IN ('committing','committed')
        AND EXISTS(SELECT 1 FROM shared_recognition_publications WHERE association_id=? AND publication_json=? AND state='active')`)
        .bind(json,id,canonical(posting),associationId(publication),json),
    ]);
    const row=await this.snapshot(id,p.communityId);
    insist(row?.state==='committed' && row.publication_json===json,"recognition_promotion_pending",409);
    return row;
  }
  async cancel(p: AcceptedIntent, evidence: string) {
    // No expiry path. Canonical verifier must prove no signed/public posting can have effect.
    const id=reservationId(p);
    await this.database.prepare(`UPDATE shared_recognition_reservations SET state='cancelled',disposition_sha256=?
      WHERE reservation_id=? AND posting_json IS NULL AND state IN ('queued','ready','enrollment_pending')
      AND (recording_id IS NULL OR EXISTS(SELECT 1 FROM shared_recognition_recordings r WHERE r.recording_id=shared_recognition_reservations.recording_id
        AND r.state NOT IN ('upload_unknown','verification_unknown')))
      AND NOT EXISTS(SELECT 1 FROM shared_recognition_original_calls WHERE reservation_id=? AND state='unknown')`)
      .bind(evidence,id,id).run();
    insist((await this.snapshot(id,p.communityId))?.state==='cancelled',"recognition_effect_unresolved",409);
  }
}
