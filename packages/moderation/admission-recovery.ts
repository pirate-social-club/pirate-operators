import type { ManagedAdmission } from "./admission-store.ts";

/** Describes continuation of the same durable calls, never permission to send
 * an unknown upstream request again. Raw receipts remain private. */
export async function admissionRecovery(db: D1Database, row: ManagedAdmission) {
  if (row.state === "complete" || row.state === "rejected")
    return "none" as const;
  if (row.state === "queued" || row.state === "running")
    return "running" as const;
  const calls = await db
    .prepare(
      "SELECT state,response_json FROM moderation_provider_calls WHERE admission_id=?",
    )
    .bind(row.admission_id)
    .all<{ state: string; response_json: string | null }>();
  if (
    calls.results.some(
      (c) =>
        (c.state === "running" || c.state === "uncertain") && !c.response_json,
    )
  )
    return "operator_review" as const;
  for (const call of calls.results) {
    if (call.response_json) {
      try {
        const response = JSON.parse(call.response_json);
        if (
          !Number.isInteger(response.status) ||
          response.status < 200 ||
          response.status >= 300
        )
          return "operator_review" as const;
      } catch {
        return "operator_review" as const;
      }
    }
  }
  const recoverable = new Set([
    "media_capability_expired",
    "private_input_unavailable",
    "moderation_unavailable",
    "admission_lease_lost",
    "retained_text_missing",
    "retained_audio_missing",
    "retained_sample_missing",
  ]);
  return recoverable.has(row.error_code ?? "")
    ? ("resume_same_job" as const)
    : ("operator_review" as const);
}
