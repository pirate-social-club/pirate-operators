import type { PrivateKeyAccount } from "viem/accounts";
import {
  canonical,
  hashJson,
  insist,
  object,
  hashText,
} from "../community/common.ts";
import {
  ownerCurated,
  OWNER_POLICY,
  OWNER_POLICY_VERSION,
} from "../community/owner-policy.ts";
import {
  curatedAdmissionId,
  validateCuratedAmendment,
} from "../community/curated-amendment.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { getAdmission, admissionId } from "./admission-store.ts";
import { parseAcrResponse } from "./acrcloud.ts";
import { signEvidence, evidenceSchemas } from "./evidence.ts";
import type { PreparedAdmission } from "./prepare-admission.ts";
import type { ProviderResponse } from "./provider-http.ts";

export async function originalProviderCalls(db: D1Database, id: string) {
  return (
    await db
      .prepare(
        "SELECT * FROM moderation_provider_calls WHERE admission_id=? ORDER BY kind",
      )
      .bind(id)
      .all<Record<string, unknown>>()
  ).results;
}
/** Sign genuine retained recognition under the new explicit policy. The
 * provider acquisition time is preserved; no content check is manufactured. */
export async function retainedRecognition(
  db: D1Database,
  originalId: string,
  signer: PrivateKeyAccount,
) {
  const row = await getAdmission(db, originalId),
    prepared = JSON.parse(row.prepared_json!) as PreparedAdmission,
    request = object(JSON.parse(row.request_json)),
    declared = object(request.declared),
    song = object(object(request.inputs).song),
    calls = await originalProviderCalls(db, originalId),
    windows: Record<string, unknown>[] = [],
    details: Record<string, unknown>[] = [];
  let acquired = Number.MAX_SAFE_INTEGER;
  for (const role of ["primary", "alternate"] as const) {
    const call = calls.find((c) => c.kind === `acr_${role}`),
      window = prepared.windows.find((w) => w.role === role);
    insist(
      call &&
        window &&
        call.state === "validated" &&
        typeof call.response_json === "string" &&
        typeof call.started_at === "number",
      "retained_recognition_unavailable",
      409,
    );
    const input = object(object(JSON.parse(String(call.request_json))).input);
    insist(
      input.sampleSha256 === window.sampleSha256 &&
        input.byteLength === window.byteLength,
      "retained_recognition_input_changed",
      409,
    );
    const receipt = JSON.parse(call.response_json) as ProviderResponse;
    insist(
      hashText(receipt.body) === receipt.bodySha256,
      "retained_recognition_receipt_changed",
      409,
    );
    const result = parseAcrResponse(receipt);
    insist(
      !result.details.allCandidatesExcluded,
      "acrcloud_excluded_reference_needs_review",
      409,
    );
    acquired = Math.min(acquired, Math.floor(call.started_at / 1000));
    const { objectKey, byteLength, ...facts } = window;
    windows.push({ ...facts, providerCode: result.code });
    details.push(result.details);
    if (result.code !== 2004) break;
  }
  const codes = windows.map((w) => w.providerCode),
    result = codes.includes(0)
      ? "identified"
      : codes.every((c) => c === 1001)
        ? "not_identified"
        : "inconclusive";
  return signEvidence(
    signer,
    {
      check: "audio.identification",
      schema: evidenceSchemas["audio.identification"],
      submissionId: row.submission_id,
      communityId: row.community_id,
      jobId: row.job_id,
      subject: String(declared.songSha256) as `0x${string}`,
      evaluator: "pirate-owner-curated/1;retained-acr-raw/1",
      policy: OWNER_POLICY_VERSION,
      result,
      issuedAt: acquired,
      expiresAt: acquired + OWNER_POLICY.recognition.maximumAgeSeconds,
    },
    {
      songSha256: declared.songSha256,
      songByteLength: song.byteLength,
      extraction: "mp3-frame-window/1",
      windows,
      provider: "acrcloud",
      providerEndpoint: "https://identify-eu-west-1.acrcloud.com/v1/identify",
    },
    { windows: details },
  );
}
/** This is a distinct policy admission; the original held row is never updated. */
export async function selectedAdmission(
  db: D1Database,
  id: string,
  config: CommunityConfig,
  candidate?: {
    original_admission_id: string;
    signed_json: string;
    result_json: string;
    amendment_sha256: string;
    created_at: number;
  },
) {
  if (!ownerCurated(config.policies.admission))
    return {
      admission: await getAdmission(db, id, config.communityId),
      curation: null,
    };
  const saved =
    candidate ??
    (await db
      .prepare("SELECT * FROM curated_admissions WHERE admission_id=?")
      .bind(id)
      .first<{
        original_admission_id: string;
        signed_json: string;
        result_json: string;
        amendment_sha256: string;
        created_at: number;
      }>());
  insist(saved, "curated_admission_unavailable", 409);
  const signed = await validateCuratedAmendment(
      JSON.parse(saved.signed_json),
      config,
    ),
    a = signed.amendment,
    original = await getAdmission(
      db,
      saved.original_admission_id,
      config.communityId,
    ),
    calls = await originalProviderCalls(db, original.admission_id),
    result = object(JSON.parse(saved.result_json)),
    declared = object(object(JSON.parse(original.request_json)).declared);
  insist(
    saved.amendment_sha256 === hashJson(signed) &&
      id === curatedAdmissionId(config.communityId, a.jobId) &&
      original.admission_id === a.originalAdmissionId &&
      original.admission_id === admissionId(config.communityId, a.jobId) &&
      original.job_id === a.jobId &&
      original.submission_id === a.submissionId &&
      original.state === "held" &&
      original.request_hash === a.originalAdmissionRequestHash &&
      original.prepared_json &&
      hashJson(JSON.parse(original.prepared_json)) === a.originalPreparedHash &&
      hashJson(calls) === a.originalCallsHash &&
      declared.songSha256 === a.contentSha256,
    "curated_original_admission_changed",
    409,
  );
  const classifier = calls.find((c) => c.kind === "lyrics_classification"),
    receipt = classifier?.response_json
      ? (JSON.parse(String(classifier.response_json)) as ProviderResponse)
      : null;
  insist(
    receipt?.status === 403 &&
      hashText(receipt.body) === receipt.bodySha256 &&
      object(object(JSON.parse(receipt.body)).error).code ===
        "model_not_found" &&
      calls.every(
        (c) =>
          c.state === "validated" ||
          (c.state === "received" && typeof c.response_json === "string"),
      ),
    "curated_original_outcome_unresolved",
    409,
  );
  insist(
    result.schema === "pirate.owner-admission/1" &&
      result.admissionId === id &&
      result.amendmentSha256 === saved.amendment_sha256 &&
      result.automatedContent === "deferred" &&
      Array.isArray(result.evidence) &&
      result.evidence.length === 1 &&
      hashJson(result.evidence[0]) === a.recognitionSha256,
    "invalid_curated_admission",
    409,
  );
  const declarations = object(result.declarations);
  insist(
    declarations.source === "operator_declared" &&
      declarations.rating === a.rating &&
      declarations.language === a.language,
    "curated_declaration_changed",
    409,
  );
  return {
    admission: {
      ...original,
      admission_id: id,
      state: "complete" as const,
      result_json: canonical(result),
      created_at: saved.created_at,
    },
    curation: signed,
  };
}
