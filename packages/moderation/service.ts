import { admissionRecovery } from "./admission-recovery.ts";
import { ownerCurated } from "../community/owner-policy.ts";
import { curatedAdmissionId } from "../community/curated-amendment.ts";
import { selectedAdmission } from "./curated-admission.ts";
import { Effect } from "effect";
import {
  CommunityError,
  exact,
  insist,
  jsonBody,
  text,
} from "../community/common.ts";
import { admissionRequest } from "./capabilities.ts";
import {
  admissionId,
  enqueueAdmission,
  getAdmission,
  resumeAdmission,
} from "./admission-store.ts";
import { authorizeServiceRequest } from "./pairing.ts";
import {
  processAdmission,
  type ManagedProcessing,
} from "./process-admission.ts";
import type { AdmissionMedia } from "./prepare-admission.ts";

export interface ManagedService extends ManagedProcessing {
  serviceOrigin: string;
  wake(admissionId: string): Promise<void>;
}
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

/** Server-to-server only. A browser cookie or a provider key is never an
 * admission capability; every read and mutation requires current publisher
 * authority and the independently configured pairing. */
export async function managedFetch(
  request: Request,
  db: D1Database,
  config: ManagedService,
) {
  try {
    const url = new URL(request.url);
    insist(url.origin === config.serviceOrigin, "wrong_host", 403);
    if (request.method === "GET" && url.pathname === "/health")
      return reply({
        service: "pirate-managed-moderation/1",
        status: "available",
      });
    const action = (
      {
        "/v1/admissions": "admit",
        "/v1/admissions/status": "status",
        "/v1/admissions/resume": "resume",
      } as const
    )[url.pathname as "/v1/admissions"];
    insist(
      request.method === "POST" && action && !url.search,
      "not_found",
      404,
    );
    const { body, pairing, authorization } = await authorizeServiceRequest(
      db,
      await jsonBody(request),
      action,
      config.serviceOrigin,
      config.pairings,
      config.currentConfiguration,
    );
    let id: string;
    const current = await config.currentConfiguration(pairing);
    if (ownerCurated(current.policies.admission)) {
      const jobId = text(body.jobId, 128),
        id = curatedAdmissionId(pairing.communityId, jobId),
        selected = await selectedAdmission(db, id, current),
        a = selected.curation!.amendment;
      if (action === "admit") {
        const parsed = admissionRequest(body, pairing, true);
        insist(
          parsed.submissionId === a.submissionId &&
            parsed.declared.songSha256 === a.contentSha256,
          "curated_admission_scope_mismatch",
          409,
        );
      } else exact(body, ["jobId"]);
      return reply({
        schema: "pirate.managed-admission-status/1",
        admissionId: id,
        jobId,
        submissionId: a.submissionId,
        state: "complete",
        recovery: "none",
        errorCode: null,
        result: JSON.parse(selected.admission.result_json!),
      });
    }
    if (action === "admit") {
      const input = admissionRequest(body, pairing);
      const row = await enqueueAdmission(db, input, pairing, authorization, {
        period: config.serviceBudgetPeriod,
        requestCap: config.serviceRequestCap,
      });
      id = row.admission_id;
      if (row.state === "queued" || row.state === "running")
        await config.wake(id);
    } else {
      exact(body, ["jobId"]);
      const jobId = text(body.jobId, 128);
      insist(
        /^[A-Za-z0-9:_-]{1,128}$/.test(jobId),
        "invalid_admission_identity",
      );
      id = admissionId(pairing.communityId, jobId);
      if (action === "resume") {
        const previous = await getAdmission(db, id, pairing.communityId);
        insist(
          (await admissionRecovery(db, previous)) !== "operator_review",
          "admission_requires_operator_review",
          409,
        );
        await resumeAdmission(db, id, pairing.communityId);
        await config.wake(id);
      }
    }
    const row = await getAdmission(db, id, pairing.communityId);
    return reply(
      {
        schema: "pirate.managed-admission-status/1",
        admissionId: id,
        jobId: row.job_id,
        submissionId: row.submission_id,
        state: row.state,
        recovery: await admissionRecovery(db, row),
        errorCode: row.error_code,
        result: row.result_json ? JSON.parse(row.result_json) : null,
      },
      row.state === "queued" || row.state === "running" ? 202 : 200,
    );
  } catch (error) {
    return reply(
      {
        error:
          error instanceof CommunityError ? error.code : "service_unavailable",
      },
      error instanceof CommunityError ? error.status : 503,
    );
  }
}

export async function recoverAdmissions(
  db: D1Database,
  wake: ManagedService["wake"],
) {
  const rows = await db
    .prepare(
      "SELECT admission_id FROM managed_admissions WHERE state='queued' OR (state='running' AND lease_until<=?) ORDER BY created_at LIMIT 10",
    )
    .bind(Date.now())
    .all<{ admission_id: string }>();
  for (const row of rows.results) await wake(row.admission_id);
}
export async function runAdmission(
  db: D1Database,
  media: AdmissionMedia,
  id: string,
  config: ManagedProcessing,
) {
  insist(/^0x[0-9a-f]{64}$/.test(id), "invalid_admission_identity");
  return Effect.runPromise(processAdmission(db, media, id, config));
}
