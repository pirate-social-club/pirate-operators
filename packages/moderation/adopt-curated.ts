import {
  canonical,
  hashJson,
  insist,
  token,
  object,
} from "../community/common.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import {
  validateCuratedAmendment,
  curatedAdmissionId,
} from "../community/curated-amendment.ts";
import { selectedAdmission } from "./curated-admission.ts";
import { verifyAdmission } from "./admission.ts";
import {
  OWNER_POLICY,
  OWNER_POLICY_VERSION,
} from "../community/owner-policy.ts";
import type { PreparedAdmission } from "./prepare-admission.ts";
import type { ReleaseGrant } from "../release/authority.ts";

/** Adopt a new finite policy decision while retaining the automated refusal.
 * Original provider quota rows remain untouched and no new check is purchased. */
export async function adoptCuratedAdmission(
  db: D1Database,
  value: unknown,
  resultValue: unknown,
  config: CommunityConfig,
  grant: ReleaseGrant,
  time = Date.now(),
) {
  const signed = await validateCuratedAmendment(value, config),
    a = signed.amendment,
    result = object(resultValue),
    id = curatedAdmissionId(config.communityId, a.jobId);
  insist(
    a.execution.grantHash === grant.sha256 &&
      grant.configurationRevision === config.configurationRevision &&
      grant.publisher === config.publisher &&
      grant.contentSha256 === a.contentSha256 &&
      grant.recipient === a.recipient &&
      a.expiresAt === grant.expiresAt &&
      grant.pins.maximumAdds === 5 &&
      a.expiresAt > Math.floor(time / 1000),
    "curated_grant_mismatch",
    409,
  );
  const saved = await db
    .prepare(
      "SELECT signed_json,result_json FROM curated_admissions WHERE admission_id=?",
    )
    .bind(id)
    .first<{ signed_json: string; result_json: string }>();
  if (saved) {
    insist(
      saved.signed_json === canonical(signed) &&
        saved.result_json === canonical(result),
      "curated_admission_conflict",
      409,
    );
    await selectedAdmission(db, id, config);
    return { adopted: true, id };
  }
  // Fully validate the candidate before the atomic insert becomes visible.
  const selected = await selectedAdmission(db, id, config, {
      original_admission_id: a.originalAdmissionId,
      signed_json: canonical(signed),
      result_json: canonical(result),
      amendment_sha256: hashJson(signed),
      created_at: time,
    }),
    original = selected.admission,
    prepared = JSON.parse(original.prepared_json!) as PreparedAdmission,
    request = object(JSON.parse(original.request_json)),
    song = object(object(request.inputs).song);
  const decision = await verifyAdmission(
    {
      communityId: config.communityId,
      submissionId: a.submissionId,
      jobId: a.jobId,
      songSha256: a.contentSha256 as `0x${string}`,
      songByteLength: Number(song.byteLength),
      title: prepared.title,
      lyrics: prepared.lyrics,
      songType: "original",
      declaredRating: a.rating,
      windows: prepared.windows.map(({ objectKey, byteLength, ...w }) => w),
      providerEndpoint: "https://identify-eu-west-1.acrcloud.com/v1/identify",
    },
    result.evidence as unknown[],
    {
      operators: [config.policies.moderationSigner],
      maxAgeSeconds: OWNER_POLICY.recognition.maximumAgeSeconds,
      policyVersion: OWNER_POLICY_VERSION,
    },
    Math.floor(time / 1000),
  );
  insist(
    decision.decision === "publish",
    "curated_recognition_not_admitted",
    409,
  );
  // A guarded transaction rejects active/unknown/funded predecessors before
  // either the successor release allowance or publication can become active.
  const guard = token();
  await db.batch([
    db
      .prepare(
        "INSERT INTO transaction_guards(guard_id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM managed_admissions WHERE admission_id=? AND state='held' AND request_hash=? AND lease_until<=?) AND NOT EXISTS(SELECT 1 FROM moderation_provider_calls WHERE admission_id=? AND (state IN ('planned','running','uncertain') OR response_json IS NULL)) AND NOT EXISTS(SELECT 1 FROM managed_releases) AND NOT EXISTS(SELECT 1 FROM funded_pins) AND NOT EXISTS(SELECT 1 FROM funded_registrations) THEN 1 ELSE 0 END",
      )
      .bind(
        guard,
        a.originalAdmissionId,
        a.originalAdmissionRequestHash,
        time,
        a.originalAdmissionId,
      ),
    db
      .prepare(
        "INSERT INTO curated_admissions(admission_id,original_admission_id,amendment_sha256,signed_json,result_json,created_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        id,
        a.originalAdmissionId,
        hashJson(signed),
        canonical(signed),
        canonical(result),
        time,
      ),
    db.prepare("DELETE FROM transaction_guards WHERE guard_id=?").bind(guard),
  ]);
  return { adopted: true, id };
}
