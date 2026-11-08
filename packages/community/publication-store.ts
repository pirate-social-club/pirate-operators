import { canonical, hashJson, insist, object, token } from "./common.ts";
import {
  unregisteredOwner,
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "./owner-policy.ts";

export const publicationSteps = [
  "admission",
  "pin_audio",
  "pin_lyrics",
  "registration",
  "pin_manifest",
  "publication",
] as const;
export type PublicationStep = (typeof publicationSteps)[number];
/** Jobs captured under the unregistered owner policy never register. */
export const unregisteredPublicationSteps: readonly PublicationStep[] =
  publicationSteps.filter((step) => step !== "registration");
/**
 * The sequence comes from the job's own captured authority, never from the
 * current community configuration, so a configuration change cannot move an
 * existing job onto a different sequence.
 */
export function jobSteps(
  job: Pick<PublicationJob, "authority_json">,
): readonly PublicationStep[] {
  const authority = object(JSON.parse(job.authority_json)),
    policy = authority.policy;
  return policy &&
    typeof policy === "object" &&
    unregisteredOwner(policy as { version: string; sha256: string })
    ? unregisteredPublicationSteps
    : publicationSteps;
}
export interface PublicationJob {
  job_id: string;
  submission_id: string;
  input_hash: string;
  authority_json: string;
  phase: string;
  progress_json: string;
  revision: number;
  lease_token: string | null;
  lease_until: number;
}
export interface ExternalOperation {
  operation_id: string;
  job_id: string;
  step: PublicationStep;
  request_hash: string;
  request_json: string;
  status:
    | "planned"
    | "prepared"
    | "running"
    | "uncertain"
    | "confirmed"
    | "failed";
  prepared_json: string | null;
  result_json: string | null;
  provider_id: string | null;
}
export const isPublicationStep = (value: string): value is PublicationStep =>
  publicationSteps.includes(value as PublicationStep);
export async function loadJob(db: D1Database, id: string) {
  const job = await db
    .prepare("SELECT * FROM publication_jobs WHERE job_id=?")
    .bind(id)
    .first<PublicationJob>();
  insist(job, "publication_job_not_found", 404);
  return job;
}
export async function leaseJob(db: D1Database, id: string, time: number) {
  // Refuse a phase outside the job's own captured sequence before any lease,
  // attempt or timestamp changes. The SQL condition repeats the check inside
  // the update so a concurrent phase change cannot slip past it.
  const current = await db
    .prepare("SELECT authority_json,phase FROM publication_jobs WHERE job_id=?")
    .bind(id)
    .first<Pick<PublicationJob, "authority_json" | "phase">>();
  if (
    current &&
    isPublicationStep(current.phase) &&
    !jobSteps(current).includes(current.phase)
  )
    insist(false, "step_outside_job_sequence", 409);
  const lease = token();
  const job = await db
    .prepare(
      `UPDATE publication_jobs SET lease_token=?,lease_until=?,attempts=attempts+1,updated_at=?
    WHERE job_id=? AND lease_until<=? AND due_at<=? AND phase IN ('admission','pin_audio','pin_lyrics','registration','pin_manifest','publication')
    AND NOT (phase='registration' AND COALESCE(json_extract(authority_json,'$.policy.version'),'')=? AND COALESCE(json_extract(authority_json,'$.policy.sha256'),'')=?)
    RETURNING *`,
    )
    .bind(
      lease,
      time + 180_000,
      time,
      id,
      time,
      time,
      UNREGISTERED_OWNER_POLICY_VERSION,
      UNREGISTERED_OWNER_POLICY_HASH,
    )
    .first<PublicationJob>();
  return job;
}
export async function planOperation(
  db: D1Database,
  job: PublicationJob,
  step: PublicationStep,
  request: unknown,
  time: number,
) {
  const requestHash = hashJson(request),
    amendment =
      step === "admission"
        ? await db
            .prepare(
              "SELECT successor_operation_id FROM publication_amendments WHERE job_id=?",
            )
            .bind(job.job_id)
            .first<{ successor_operation_id: string }>()
        : null,
    storedStep = amendment ? "admission:owner-curated:1" : step,
    operationId =
      amendment?.successor_operation_id ?? hashJson({ job: job.job_id, step });
  await db
    .prepare(
      `INSERT INTO external_operations(operation_id,job_id,step,request_hash,request_json,status)
    SELECT ?,?,?,?,?,'planned' WHERE EXISTS(SELECT 1 FROM publication_jobs WHERE job_id=? AND lease_token=? AND lease_until>?)
    ON CONFLICT(job_id,step) DO NOTHING`,
    )
    .bind(
      operationId,
      job.job_id,
      storedStep,
      requestHash,
      canonical(request),
      job.job_id,
      job.lease_token,
      time,
    )
    .run();
  const operation = await db
    .prepare("SELECT * FROM external_operations WHERE job_id=? AND step=?")
    .bind(job.job_id, storedStep)
    .first<ExternalOperation>();
  insist(
    operation && operation.request_hash === requestHash,
    "operation_intent_changed",
    409,
  );
  return { ...operation, step };
}
export async function activeAdmissionOperation(db: D1Database, jobId: string) {
  const row = await db
    .prepare(
      "SELECT o.* FROM external_operations o WHERE o.operation_id=COALESCE((SELECT successor_operation_id FROM publication_amendments WHERE job_id=?),(SELECT operation_id FROM external_operations WHERE job_id=? AND step='admission'))",
    )
    .bind(jobId, jobId)
    .first<ExternalOperation>();
  return row ? { ...row, step: "admission" as const } : null;
}
export async function prepareOperation(
  db: D1Database,
  job: PublicationJob,
  operation: ExternalOperation,
  prepared: unknown,
  time: number,
) {
  const result = await db
    .prepare(
      `UPDATE external_operations SET status='prepared',prepared_json=? WHERE operation_id=? AND status='planned'
    AND EXISTS(SELECT 1 FROM publication_jobs WHERE job_id=? AND lease_token=? AND lease_until>?)`,
    )
    .bind(
      canonical(prepared),
      operation.operation_id,
      job.job_id,
      job.lease_token,
      time,
    )
    .run();
  insist(result.meta.changes === 1, "publication_lease_lost", 409);
  return {
    ...operation,
    status: "prepared" as const,
    prepared_json: canonical(prepared),
  };
}
export async function startOperation(
  db: D1Database,
  job: PublicationJob,
  operation: ExternalOperation,
  time: number,
  reconciledAbsent = false,
) {
  const expected = reconciledAbsent
    ? ["running", "uncertain"]
    : ["prepared", "prepared"];
  const result = await db
    .prepare(
      `UPDATE external_operations SET status='running',started_at=COALESCE(started_at,?)
    WHERE operation_id=? AND status IN (?,?) AND prepared_json IS NOT NULL
    AND EXISTS(SELECT 1 FROM publication_jobs WHERE job_id=? AND lease_token=? AND lease_until>?)`,
    )
    .bind(
      time,
      operation.operation_id,
      ...expected,
      job.job_id,
      job.lease_token,
      time,
    )
    .run();
  insist(result.meta.changes === 1, "publication_lease_lost", 409);
}
// Operation results may arrive after the job lease expires. They can only fill
// the same immutable operation; a different receipt is never accepted silently.
export async function confirmOperation(
  db: D1Database,
  operation: ExternalOperation,
  result: unknown,
  providerId: string,
  time: number,
) {
  insist(
    providerId.length > 0 && providerId.length <= 512,
    "invalid_provider_operation_id",
  );
  const json = canonical(result);
  await db
    .prepare(
      `UPDATE external_operations SET status='confirmed',result_json=?,provider_id=?,completed_at=?,error_code=NULL
    WHERE operation_id=? AND request_hash=? AND status IN ('running','uncertain')`,
    )
    .bind(
      json,
      providerId,
      time,
      operation.operation_id,
      operation.request_hash,
    )
    .run();
  const saved = await db
    .prepare(
      "SELECT status,result_json,provider_id FROM external_operations WHERE operation_id=?",
    )
    .bind(operation.operation_id)
    .first<ExternalOperation>();
  insist(
    saved?.status === "confirmed" &&
      saved.result_json === json &&
      saved.provider_id === providerId,
    "conflicting_operation_result",
    409,
  );
}
export async function parkJob(
  db: D1Database,
  job: PublicationJob,
  phase: "uncertain" | "held" | "failed",
  code: string,
  time: number,
) {
  insist(/^[a-z0-9_]{1,100}$/.test(code), "invalid_public_error_code");
  const progress = object(JSON.parse(job.progress_json));
  await db
    .prepare(
      `UPDATE publication_jobs SET phase=?,error_code=?,progress_json=?,lease_token=NULL,lease_until=0,updated_at=?,revision=revision+1
    WHERE job_id=? AND lease_token=?`,
    )
    .bind(
      phase,
      code,
      canonical({ ...progress, resumePhase: job.phase }),
      time,
      job.job_id,
      job.lease_token,
    )
    .run();
}
export async function advanceJob(
  db: D1Database,
  job: PublicationJob,
  step: PublicationStep,
  result: unknown,
  time: number,
) {
  const steps = jobSteps(job);
  insist(steps.includes(step), "step_outside_job_sequence", 409);
  const next = steps[steps.indexOf(step) + 1] ?? "published";
  const progress = object(JSON.parse(job.progress_json));
  delete progress.resumePhase;
  const updated = await db
    .prepare(
      `UPDATE publication_jobs SET phase=?,progress_json=?,error_code=NULL,due_at=?,lease_token=NULL,lease_until=0,
    updated_at=?,revision=revision+1 WHERE job_id=? AND phase=? AND lease_token=? AND lease_until>?`,
    )
    .bind(
      next,
      canonical({ ...progress, [step]: result }),
      time,
      time,
      job.job_id,
      step,
      job.lease_token,
      time,
    )
    .run();
  insist(updated.meta.changes === 1, "publication_lease_lost", 409);
}
export async function resumeUncertainJob(
  db: D1Database,
  id: string,
  accountId: string,
  time = Date.now(),
) {
  const job = await loadJob(db, id),
    progress = object(JSON.parse(job.progress_json));
  insist(
    job.phase === "uncertain" &&
      typeof progress.resumePhase === "string" &&
      isPublicationStep(progress.resumePhase) &&
      jobSteps(job).includes(progress.resumePhase),
    "job_not_reconcilable",
    409,
  );
  const changed = await db
    .prepare(
      `UPDATE publication_jobs SET phase=?,due_at=?,error_code=NULL,updated_at=?
    WHERE job_id=? AND phase='uncertain' AND revision=? AND EXISTS(
      SELECT 1 FROM media_submissions WHERE submission_id=publication_jobs.submission_id AND account_id=?)`,
    )
    .bind(progress.resumePhase, time, time, id, job.revision, accountId)
    .run();
  insist(changed.meta.changes === 1, "job_not_reconcilable", 409);
}
