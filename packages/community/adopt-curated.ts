import { canonical, hashJson, insist, token } from "./common.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import { publicationInput } from "./publication-input.ts";
import {
  validateCuratedAmendment,
  curatedOperationId,
} from "./curated-amendment.ts";

/** Operator-only deployment boundary. Never exposed as a creator write route. */
export async function adoptCuratedPublication(
  db: D1Database,
  media: R2Bucket,
  value: unknown,
  config: CommunityConfig,
  time = Date.now(),
) {
  const signed = await validateCuratedAmendment(value, config),
    a = signed.amendment,
    amendmentHash = hashJson(signed),
    successorId = curatedOperationId(signed);
  insist(
    a.expiresAt > Math.floor(time / 1000),
    "curated_amendment_expired",
    409,
  );
  const saved = await db
    .prepare("SELECT * FROM publication_amendments WHERE job_id=?")
    .bind(a.jobId)
    .first<{
      signed_json: string;
      amendment_sha256: string;
      successor_operation_id: string;
    }>();
  if (saved) {
    insist(
      saved.signed_json === canonical(signed) &&
        saved.amendment_sha256 === amendmentHash &&
        saved.successor_operation_id === successorId,
      "curated_amendment_conflict",
      409,
    );
    return { adopted: true, successorId };
  }
  const input = await publicationInput(
      db,
      media,
      a.jobId,
      a.originalConfiguration,
    ),
    operation = await db
      .prepare(
        "SELECT * FROM external_operations WHERE operation_id=? AND job_id=? AND step='admission'",
      )
      .bind(a.originalOperationId, a.jobId)
      .first<{ status: string; result_json: string; request_hash: string }>();
  insist(
    input.job.phase === "held" &&
      input.row.submission_id === a.submissionId &&
      input.row.post_id === a.postId &&
      input.row.author_id === a.authorId &&
      input.row.captured_wallet === a.ownerWallet &&
      input.context.recipient === a.recipient &&
      input.row.audio_sha256 === a.contentSha256 &&
      input.row.request_hash === a.originalRequestHash &&
      input.job.input_hash === a.originalInputHash &&
      hashJson(input.authority) === a.originalAuthorityHash &&
      operation?.status === "failed" &&
      hashJson(JSON.parse(operation.result_json)) ===
        a.originalOperationReceiptHash,
    "curated_original_publication_changed",
    409,
  );
  const guard = token();
  await db.batch([
    db
      .prepare(
        "INSERT INTO transaction_guards(guard_id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM publication_jobs WHERE job_id=? AND phase='held' AND revision=? AND input_hash=? AND lease_until<=?) AND EXISTS(SELECT 1 FROM external_operations WHERE operation_id=? AND status='failed' AND result_json=?) AND NOT EXISTS(SELECT 1 FROM external_operations WHERE job_id=? AND step!='admission') THEN 1 ELSE 0 END",
      )
      .bind(
        guard,
        a.jobId,
        input.job.revision,
        a.originalInputHash,
        time,
        a.originalOperationId,
        operation.result_json,
        a.jobId,
      ),
    db
      .prepare(
        "INSERT INTO publication_amendments(job_id,amendment_sha256,signed_json,predecessor_operation_id,successor_operation_id,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        a.jobId,
        amendmentHash,
        canonical(signed),
        a.originalOperationId,
        successorId,
        time,
      ),
    db
      .prepare(
        "UPDATE publication_jobs SET phase='admission',error_code=NULL,due_at=?,updated_at=?,revision=revision+1 WHERE job_id=? AND phase='held' AND revision=?",
      )
      .bind(time, time, a.jobId, input.job.revision),
    db.prepare("DELETE FROM transaction_guards WHERE guard_id=?").bind(guard),
  ]);
  return { adopted: true, successorId };
}
