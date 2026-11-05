import {
  canonical,
  hashJson,
  insist,
  integer,
  text,
  token,
} from "../community/common.ts";
import { admissionInputHash, type AdmissionRequest } from "./capabilities.ts";
import type { ManagedPairing, ServiceAuthorization } from "./pairing.ts";

export interface ManagedAdmission {
  admission_id: string;
  community_id: string;
  submission_id: string;
  job_id: string;
  request_hash: string;
  request_json: string;
  authority_json: string;
  budget_period: string;
  state: "queued" | "running" | "complete" | "held" | "rejected" | "uncertain";
  lease_token: string | null;
  lease_until: number;
  prepared_json: string | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
  error_code: string | null;
}
export function admissionId(communityId: string, jobId: string) {
  return hashJson({ communityId, jobId });
}
export async function getAdmission(
  db: D1Database,
  id: string,
  communityId?: string,
) {
  const row = await db
    .prepare(
      "SELECT * FROM managed_admissions WHERE admission_id=?" +
        (communityId ? " AND community_id=?" : ""),
    )
    .bind(...(communityId ? [id, communityId] : [id]))
    .first<ManagedAdmission>();
  insist(row, "admission_not_found", 404);
  return row;
}
export async function enqueueAdmission(
  db: D1Database,
  request: AdmissionRequest,
  pairing: ManagedPairing,
  authorization: ServiceAuthorization,
  serviceBudget: { period: string; requestCap: number },
  time = Date.now(),
) {
  const id = admissionId(pairing.communityId, request.jobId),
    requestHash = admissionInputHash(request);
  const authority = {
    publisher: authorization.publisher,
    configurationRevision: authorization.configurationRevision,
    controller: pairing.controller,
    registry: pairing.registry,
    directory: pairing.directory,
    communityOrigin: pairing.communityOrigin,
    serviceOrigin: pairing.serviceOrigin,
    communityRequestCap: pairing.requestCap,
    serviceBudget: {
      period: text(serviceBudget.period, 64),
      requestCap: integer(serviceBudget.requestCap, 1, 100),
    },
  };
  await db
    .prepare(
      `INSERT INTO managed_admissions(admission_id,community_id,submission_id,job_id,request_hash,request_json,authority_json,budget_period,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'queued',?,?) ON CONFLICT(community_id,job_id) DO NOTHING`,
    )
    .bind(
      id,
      pairing.communityId,
      request.submissionId,
      request.jobId,
      requestHash,
      canonical(request),
      canonical(authority),
      pairing.budgetPeriod,
      time,
      time,
    )
    .run();
  const row = await getAdmission(db, id, pairing.communityId);
  insist(
    row.request_hash === requestHash &&
      row.authority_json === canonical(authority) &&
      row.budget_period === pairing.budgetPeriod,
    "admission_job_conflict",
    409,
  );
  // Renew only transport capabilities. Existing provider intents, receipts,
  // original authority, quota period and immutable input hashes remain fixed.
  await db
    .prepare(
      "UPDATE managed_admissions SET request_json=? WHERE admission_id=? AND request_hash=?",
    )
    .bind(canonical(request), id, requestHash)
    .run();
  return row;
}
export async function leaseAdmission(
  db: D1Database,
  id: string,
  time = Date.now(),
) {
  return db
    .prepare(
      `UPDATE managed_admissions SET state='running',lease_token=?,lease_until=?,updated_at=?
    WHERE admission_id=? AND (state='queued' OR (state='running' AND lease_until<=?)) RETURNING *`,
    )
    .bind(token(), time + 180000, time, id, time)
    .first<ManagedAdmission>();
}
export async function finishAdmission(
  db: D1Database,
  row: ManagedAdmission,
  state: "complete" | "held" | "rejected" | "uncertain",
  result: unknown,
  errorCode: string | null,
  time = Date.now(),
) {
  insist(
    errorCode === null || /^[a-z0-9_]{1,100}$/.test(errorCode),
    "invalid_admission_error",
  );
  const changed = await db
    .prepare(
      `UPDATE managed_admissions SET state=?,result_json=?,error_code=?,lease_token=NULL,lease_until=0,updated_at=?
    WHERE admission_id=? AND lease_token=? AND lease_until>?`,
    )
    .bind(
      state,
      canonical(result),
      errorCode,
      time,
      row.admission_id,
      row.lease_token,
      time,
    )
    .run();
  insist(changed.meta.changes === 1, "admission_lease_lost", 409);
}
export async function resumeAdmission(
  db: D1Database,
  id: string,
  communityId: string,
) {
  const row = await getAdmission(db, id, communityId);
  insist(
    row.state === "uncertain" ||
      row.state === "held" ||
      row.state === "queued" ||
      row.state === "running",
    "admission_cannot_resume",
    409,
  );
  if (row.state === "uncertain" || row.state === "held")
    await db
      .prepare(
        "UPDATE managed_admissions SET state='queued',error_code=NULL WHERE admission_id=? AND community_id=? AND state IN ('uncertain','held')",
      )
      .bind(id, communityId)
      .run();
  return row;
}
