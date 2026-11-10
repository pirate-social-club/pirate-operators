import { canonical, hashJson } from "../community/common.ts";
import type { DanceStore } from "./store.ts";
import { DANCE_DB_NOW } from "./store.ts";
import type { DanceRepository } from "./repository.ts";
import { decisionEvidencePreimage } from "./intent.ts";
/** Both source3 plan halves surround actual Dance acceptance and receipt. */
export function submissionStatements(
  s: DanceStore,
  i: Parameters<DanceRepository["acceptSubmission"]>[0],
) {
  const c = i.capture,
    id = c.captureId,
    a = c.learner.accountId;
  const accepted = {
    sql: "EXISTS(SELECT 1 FROM dance_reviews r JOIN community_media_submissions m ON m.submission_id=r.review_id AND m.community_id=r.community_id JOIN dance_receipts d ON d.community_id=r.community_id AND d.actor_id=r.account_id WHERE r.review_id=? AND d.command_id=? AND d.request_hash=? AND r.media_id=m.media_id AND json_extract(r.receipt_json,'$.trustedSubmittedAtMs')=m.submitted_at_ms AND json_extract(r.receipt_json,'$.reviewDeadlineMs')=m.deadline_ms AND json_extract(r.receipt_json,'$.mediaRevision')=m.media_revision AND m.binding_commitment=?)",
    values: [id, i.commandId, i.requestHash, i.bindingCommitment],
  };
  const plan = i.mediaPort.prepareMediaSubmission(
    i.witness,
    id,
    i.bindingCommitment,
    accepted,
  );
  return [
    ...plan.beforeAcceptance,
    s.stmt(
      "INSERT INTO dance_reviews(review_id,community_id,account_id,media_id,recording_digest,media_json,receipt_json,state) SELECT ?,?,?,m.media_id,?,?,json_object('submissionId',m.submission_id,'communityId',m.community_id,'accountId',m.account_id,'mediaId',m.media_id,'bindingCommitment',m.binding_commitment,'trustedSubmittedAtMs',m.submitted_at_ms,'reviewDeadlineMs',m.deadline_ms,'mediaRevision',m.media_revision),'awaiting_review' FROM community_media_submissions m WHERE m.submission_id=? AND m.community_id=? AND m.account_id=? AND m.media_id=? AND m.binding_commitment=? AND m.deadline_ms=m.submitted_at_ms+604800000 AND m.submitted_at_ms>=? AND m.submitted_at_ms<? AND m.media_revision=?",
      id,
      c.communityId,
      a,
      i.media.recordingSha256,
      canonical(i.media),
      id,
      c.communityId,
      a,
      i.witness.id,
      i.bindingCommitment,
      c.consent!.acceptedAtMs,
      c.expiresAtMs,
      i.witness.revision + 1,
    ),
    s.changed(),
    s.saveReceipt(c.communityId, a, i.commandId, i.requestHash, id),
    ...plan.afterAcceptance,
  ];
}
export function decisionStatements(
  s: DanceStore,
  i: Parameters<DanceRepository["stageDecision"]>[0],
) {
  const id = i.review.reviewId,
    k = i.intent.commandId,
    c = i.review.capture.communityId;
  const p = decisionEvidencePreimage(i.intent.preimage);
  return [
    s.stmt(
      "UPDATE dance_reviews SET state='decision_pending',revision=revision+1 WHERE review_id=? AND revision=? AND state='awaiting_review' AND local_denied=0 AND " +
        DANCE_DB_NOW +
        "<json_extract(receipt_json,'$.reviewDeadlineMs')",
      id,
      i.review.revision,
    ),
    s.changed(),
    s.stmt(
      "INSERT INTO dance_decision_intents VALUES(?,?,?,?)",
      id,
      k,
      p,
      i.intent.localIntegrityHash,
    ),
    s.stmt(
      "INSERT INTO dance_outbox VALUES(?,?,?,'decision',?,?,'held')",
      k,
      c,
      id,
      p,
      i.intent.localIntegrityHash,
    ),
    s.saveReceipt(c, i.actor, k, i.requestHash, id),
  ];
}
export function withdrawalStatements(
  s: DanceStore,
  i: Parameters<DanceRepository["stageWithdrawal"]>[0],
) {
  const r = i.review,
    c = r.capture.communityId,
    p = canonical({
      operation: "InvalidateSubmission",
      reviewId: r.reviewId,
      captureId: r.capture.captureId,
      learner: r.capture.learner.wallet,
      commandId: i.commandId,
    });
  return [
    s.stmt(
      "UPDATE dance_reviews SET local_denied=1,state='withdrawal_pending',revision=revision+1 WHERE review_id=? AND revision=? AND local_denied=0",
      r.reviewId,
      r.revision,
    ),
    s.changed(),
    s.stmt(
      "UPDATE dance_outbox SET status='canceled' WHERE subject_id=? AND kind IN ('submission','decision') AND status IN ('held','ready')",
      r.reviewId,
    ),
    s.stmt(
      "INSERT INTO dance_outbox VALUES(?,?,?,'withdraw',?,?,'held')",
      i.commandId,
      c,
      r.reviewId,
      p,
      hashJson(JSON.parse(p)),
    ),
    s.saveReceipt(c, i.actor, i.commandId, i.requestHash, r.reviewId),
  ];
}
export function controlStatements(
  s: DanceStore,
  i: Parameters<DanceRepository["control"]>[0],
) {
  const rows: D1PreparedStatement[] = [];
  if (i.operation === "grant")
    rows.push(
      s.stmt(
        "INSERT INTO dance_delegations VALUES(?,?,?,?,?)",
        i.delegationId,
        i.communityId,
        i.accountId,
        i.wallet,
        i.ownerAssignment,
      ),
    );
  rows.push(
    s.stmt(
      "INSERT INTO dance_control_intents VALUES(?,?,?,?,?,?,?,?,?)",
      i.commandId,
      i.communityId,
      i.actorId,
      i.delegationId,
      i.accountId,
      i.wallet,
      i.operation,
      i.localIntegrityHash,
      canonical(i),
    ),
    s.stmt(
      "INSERT INTO dance_outbox VALUES(?,?,?,?,?,?,'held')",
      i.commandId,
      i.communityId,
      i.delegationId,
      i.operation,
      canonical(i),
      i.localIntegrityHash,
    ),
  );
  return rows;
}
