import { canonical, hashJson, hashText, insist, object } from "./common.ts";
import { createInputCapabilities } from "./input-capabilities.ts";
import { managedRequest, type ManagedClient } from "./managed-client.ts";
import type { PublicationInput } from "./publication-input.ts";
import type { OperationResult, Reconciliation } from "./publication.ts";
import { verifyAdmission } from "../moderation/admission.ts";

async function interpretAdmission(
  input: PublicationInput,
  client: ManagedClient,
  body: Record<string, unknown>,
  providerEndpoint: string,
): Promise<Reconciliation> {
  const expected = input.context.admissionId;
  insist(
    body.schema === "pirate.managed-admission-status/1" &&
      body.admissionId === expected &&
      body.jobId === input.job.job_id &&
      body.submissionId === input.row.submission_id,
    "admission_response_scope_mismatch",
    503,
  );
  if (
    body.state === "queued" ||
    body.state === "running" ||
    body.state === "uncertain"
  )
    return { kind: "unknown" };
  if (body.state === "held" && body.recovery === "resume_same_job")
    return { kind: "unknown" };
  if (body.state === "held" || body.state === "rejected")
    return {
      kind: body.state === "held" ? "held" : "rejected",
      providerId: expected,
      code:
        typeof body.errorCode === "string" &&
        /^[a-z0-9_]{1,100}$/.test(body.errorCode)
          ? body.errorCode
          : "moderation_unavailable",
      value: { serviceState: body.state, errorCode: body.errorCode ?? null },
    };
  insist(body.state === "complete", "unsupported_admission_state", 503);
  const result = object(body.result);
  insist(
    result.schema === "pirate.managed-admission/1" &&
      result.admissionId === expected &&
      Array.isArray(result.evidence) &&
      Array.isArray(result.windows),
    "invalid_completed_admission",
    503,
  );
  const decision = await verifyAdmission(
    {
      communityId: client.configuration.communityId,
      submissionId: input.row.submission_id,
      jobId: input.job.job_id,
      songSha256: input.row.audio_sha256 as `0x${string}`,
      songByteLength: input.row.audio_bytes,
      title: input.metadata.title,
      lyrics: input.metadata.lyrics.sourceText,
      songType: "original",
      declaredRating: "general",
      windows: result.windows as Parameters<
        typeof verifyAdmission
      >[0]["windows"],
      providerEndpoint,
    },
    result.evidence,
    {
      operators: [client.configuration.policies.moderationSigner],
      maxAgeSeconds: 3600,
    },
    Math.floor(Date.now() / 1000),
  );
  const value = { result, decision, evidenceSha256: hashJson(result) };
  if (decision.decision !== "publish")
    return {
      kind: decision.decision === "block" ? "rejected" : "held",
      providerId: expected,
      code: decision.reasons[0] ?? "moderation_held",
      value,
    };
  return { kind: "confirmed", providerId: expected, value };
}
async function admissionBody(
  db: D1Database,
  input: PublicationInput,
  client: ManagedClient,
) {
  const caps = await createInputCapabilities(
    db,
    input.row,
    client.configuration.app.origin,
  );
  const body = {
    jobId: input.job.job_id,
    submissionId: input.row.submission_id,
    communityId: client.configuration.communityId,
    checks: [
      "audio.identification",
      "title.rating",
      ...(caps.lyrics ? ["lyrics.classification"] : []),
    ],
    inputs: caps,
    declared: {
      songSha256: input.row.audio_sha256,
      titleSha256: hashText(input.metadata.title),
      lyricsSha256: caps.lyrics
        ? hashText(input.metadata.lyrics.sourceText)
        : null,
    },
  };
  return body;
}
export async function executeAdmission(
  db: D1Database,
  input: PublicationInput,
  client: ManagedClient,
  providerEndpoint: string,
): Promise<OperationResult> {
  const body = await admissionBody(db, input, client);
  const response = await managedRequest(
      client,
      "/v1/admissions",
      "admit",
      body,
    ),
    result = await interpretAdmission(
      input,
      client,
      response.body,
      providerEndpoint,
    );
  insist(
    result.kind !== "unknown" && result.kind !== "absent",
    "admission_pending",
    503,
  );
  return result;
}
export async function reconcileAdmission(
  input: PublicationInput,
  client: ManagedClient,
  providerEndpoint: string,
): Promise<Reconciliation> {
  const response = await managedRequest(
    client,
    "/v1/admissions/status",
    "status",
    { jobId: input.job.job_id },
  );
  if (response.status === 404)
    return {
      kind: "absent",
      proof: canonical({
        service: client.origin,
        admissionId: input.context.admissionId,
        status: 404,
        error: response.body.error,
      }),
    };
  return interpretAdmission(input, client, response.body, providerEndpoint);
}
export async function validateAdmissionResult(
  input: PublicationInput,
  client: ManagedClient,
  providerEndpoint: string,
  result: OperationResult,
) {
  const fresh = await reconcileAdmission(input, client, providerEndpoint);
  insist(
    fresh.kind !== "unknown" &&
      fresh.kind !== "absent" &&
      canonical(fresh) === canonical(result),
    "admission_result_not_reconciled",
    503,
  );
}

/** Explicit execution continuation: renew transport grants for identical sealed
 * inputs and wake the same admission. Reconciliation itself remains read-only. */
export async function resumeAdmissionProcessing(
  db: D1Database,
  input: PublicationInput,
  client: ManagedClient,
  providerEndpoint: string,
) {
  const status = await managedRequest(
    client,
    "/v1/admissions/status",
    "status",
    { jobId: input.job.job_id },
  );
  if (status.status === 404) return false;
  await interpretAdmission(input, client, status.body, providerEndpoint);
  if (status.body.recovery !== "resume_same_job") return false;
  const body = await admissionBody(db, input, client);
  await managedRequest(client, "/v1/admissions", "admit", body);
  await managedRequest(client, "/v1/admissions/resume", "resume", {
    jobId: input.job.job_id,
  });
  return true;
}
