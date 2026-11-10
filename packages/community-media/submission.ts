import type { MediaRepository } from "./repository.ts";
import type {
  MediaSubmissionReceipt,
  MediaSubmissionWitness,
} from "./contracts.ts";
import {
  PRIVATE_RETENTION_MS,
  digest,
  mediaText,
  requireMedia,
} from "./validation.ts";

export const MEDIA_SUBMISSION_DB_NOW =
  "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
/** Trusted adapter SQL, never browser input. Must prove the actual accepted
 * Dance submission matches this media receipt's identity, binding and times. */
export interface AcceptedDanceSubmissionFence {
  sql: string;
  values: (string | number | null)[];
}
export interface MediaSubmissionPlan {
  beforeAcceptance: D1PreparedStatement[];
  afterAcceptance: D1PreparedStatement[];
}
/** Compose both halves around Dance's accepted submission in ONE db.batch.
 * No standalone retain API exists. The mandatory final assertion rolls back
 * retention unless the actual Dance receipt exists in that same transaction.
 */
export function prepareMediaSubmission(
  repository: MediaRepository,
  witness: MediaSubmissionWitness,
  submissionId: string,
  bindingCommitment: string,
  accepted: AcceptedDanceSubmissionFence,
): MediaSubmissionPlan {
  mediaText(submissionId, 128);
  // The on-chain commitment has an explicit 0x prefix. Preserve its exact
  // representation for the consumer's atomic accepted-receipt predicate.
  digest(
    bindingCommitment.startsWith("0x")
      ? bindingCommitment.slice(2)
      : bindingCommitment,
  );
  requireMedia(
    witness.communityId === repository.communityId && accepted.sql.length > 0,
    "media_submission_invalid",
  );
  const db = repository.db,
    now = MEDIA_SUBMISSION_DB_NOW,
    guardId = crypto.randomUUID();
  const receiptValues = [
    repository.communityId,
    submissionId,
    witness.id,
    witness.accountId,
    bindingCommitment,
  ];
  const matchingReceipt = `EXISTS(SELECT 1 FROM community_media_submissions s
    JOIN community_media m ON m.id=s.media_id AND m.community_id=s.community_id
    WHERE s.community_id=? AND s.submission_id=? AND s.media_id=? AND s.account_id=? AND s.binding_commitment=?
    AND m.state='ready' AND m.revision=s.media_revision AND m.expires_at=s.deadline_ms
    AND json_extract(m.body,'$.submissionId')=s.submission_id
    AND json_extract(m.body,'$.recordingSha256')=?)`;
  return {
    beforeAcceptance: [
      db
        .prepare(
          `INSERT INTO community_media_submissions
        SELECT community_id,?,id,account_id,?,${now},${now}+${PRIVATE_RETENTION_MS},revision+1
        FROM community_media WHERE id=? AND community_id=? AND account_id=? AND revision=?
        AND state='ready' AND purpose='private-review' AND expires_at>${now}
        AND json_extract(body,'$.recordingSha256')=? AND json_extract(body,'$.submissionId') IS NULL
        ON CONFLICT DO NOTHING`,
        )
        .bind(
          submissionId,
          bindingCommitment,
          witness.id,
          witness.communityId,
          witness.accountId,
          witness.revision,
          witness.recordingSha256,
        ),
      db
        .prepare(
          `UPDATE community_media SET
        revision=revision+1,
        expires_at=(SELECT deadline_ms FROM community_media_submissions WHERE community_id=? AND submission_id=?),
        body=json_set(body,'$.revision',revision+1,'$.submissionId',?,'$.submissionBindingCommitment',?,
          '$.trustedSubmittedAtMs',(SELECT submitted_at_ms FROM community_media_submissions WHERE community_id=? AND submission_id=?),
          '$.reviewDeadlineMs',(SELECT deadline_ms FROM community_media_submissions WHERE community_id=? AND submission_id=?),
          '$.expiresAt',(SELECT deadline_ms FROM community_media_submissions WHERE community_id=? AND submission_id=?))
        WHERE id=? AND community_id=? AND account_id=? AND revision=? AND state='ready' AND expires_at>${now}
        AND EXISTS(SELECT 1 FROM community_media_submissions WHERE community_id=? AND submission_id=?
          AND media_id=? AND account_id=? AND binding_commitment=? AND media_revision=community_media.revision+1)`,
        )
        .bind(
          witness.communityId,
          submissionId,
          submissionId,
          bindingCommitment,
          witness.communityId,
          submissionId,
          witness.communityId,
          submissionId,
          witness.communityId,
          submissionId,
          witness.id,
          witness.communityId,
          witness.accountId,
          witness.revision,
          ...receiptValues,
        ),
    ],
    afterAcceptance: [
      db
        .prepare(
          `INSERT INTO community_media_submission_guards VALUES(?,CASE WHEN (${matchingReceipt}) AND (${accepted.sql}) THEN 1 ELSE 0 END)`,
        )
        .bind(
          guardId,
          ...receiptValues,
          witness.recordingSha256,
          ...accepted.values,
        ),
      db
        .prepare("DELETE FROM community_media_submission_guards WHERE id=?")
        .bind(guardId),
    ],
  };
}
/** Reconcile this canonical receipt after any lost batch response; never mint
 * a replacement submission/time to recover an uncertain acceptance. */
export async function mediaSubmissionReceipt(
  repository: MediaRepository,
  submissionId: string,
): Promise<MediaSubmissionReceipt> {
  const row = await repository.db
    .prepare(
      `SELECT submission_id AS submissionId,community_id AS communityId,
    account_id AS accountId,media_id AS mediaId,binding_commitment AS bindingCommitment,
    submitted_at_ms AS trustedSubmittedAtMs,deadline_ms AS reviewDeadlineMs,media_revision AS mediaRevision
    FROM community_media_submissions WHERE community_id=? AND submission_id=?`,
    )
    .bind(repository.communityId, submissionId)
    .first<MediaSubmissionReceipt>();
  requireMedia(row, "media_submission_not_found", 404);
  return row;
}
