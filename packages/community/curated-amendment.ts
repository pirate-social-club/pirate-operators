import { recoverMessageAddress } from "viem";
import {
  bytes32,
  exact,
  hashJson,
  insist,
  integer,
  object,
  text,
} from "./common.ts";
import { address, httpsOrigin } from "./manifest-core.ts";
import { validateConfig, type CommunityConfig } from "./config-manifest.ts";
import { ownerCurated } from "./owner-policy.ts";
import type { RegisteredExecutionProfile } from "./publication-profile.ts";

export interface CuratedAmendment {
  schema: "pirate.owner-curated-amendment/1";
  communityId: string;
  jobId: string;
  submissionId: string;
  postId: string;
  authorId: string;
  ownerWallet: string;
  recipient: string;
  contentSha256: string;
  originalInputHash: string;
  originalAuthorityHash: string;
  originalRequestHash: string;
  originalAdmissionId: string;
  originalAdmissionRequestHash: string;
  originalPreparedHash: string;
  originalCallsHash: string;
  originalOperationId: string;
  originalOperationReceiptHash: string;
  originalGrantHash: string;
  originalConfiguration: CommunityConfig;
  configurationSha256: string;
  execution: RegisteredExecutionProfile;
  recognitionSha256: string;
  rating: "general" | "adult_18";
  language: string;
  expiresAt: number;
}
export interface SignedCuratedAmendment {
  amendment: CuratedAmendment;
  signature: `0x${string}`;
}
export const curatedAdmissionId = (communityId: string, jobId: string) =>
  hashJson({ communityId, jobId, policy: "pirate-owner-curated/2026-11-05/1" });
export const curatedOperationId = (signed: SignedCuratedAmendment) =>
  hashJson({
    job: signed.amendment.jobId,
    step: "admission",
    amendment: hashJson(signed),
  });
export async function validateCuratedAmendment(
  value: unknown,
  config: CommunityConfig,
): Promise<SignedCuratedAmendment> {
  const signed = object(value);
  exact(signed, ["amendment", "signature"]);
  const a = object(signed.amendment);
  exact(a, [
    "schema",
    "communityId",
    "jobId",
    "submissionId",
    "postId",
    "authorId",
    "ownerWallet",
    "recipient",
    "contentSha256",
    "originalInputHash",
    "originalAuthorityHash",
    "originalRequestHash",
    "originalAdmissionId",
    "originalAdmissionRequestHash",
    "originalPreparedHash",
    "originalCallsHash",
    "originalOperationId",
    "originalOperationReceiptHash",
    "originalGrantHash",
    "originalConfiguration",
    "configurationSha256",
    "execution",
    "recognitionSha256",
    "rating",
    "language",
    "expiresAt",
  ]);
  insist(
    a.schema === "pirate.owner-curated-amendment/1" &&
      ownerCurated(config.policies.admission) &&
      config.configurationRevision === 2 &&
      a.communityId === config.communityId &&
      a.configurationSha256 === hashJson(config),
    "curated_configuration_mismatch",
    409,
  );
  const original = validateConfig(a.originalConfiguration);
  insist(
    original.configurationRevision === 1 &&
      original.communityId === config.communityId &&
      original.registry === config.registry &&
      original.postsContract === config.postsContract &&
      original.publisher === config.publisher &&
      original.controller === config.controller &&
      original.app.origin === config.app.origin,
    "curated_predecessor_changed",
    409,
  );
  for (const key of [
    "communityId",
    "postId",
    "authorId",
    "contentSha256",
    "originalInputHash",
    "originalAuthorityHash",
    "originalRequestHash",
    "originalAdmissionId",
    "originalAdmissionRequestHash",
    "originalPreparedHash",
    "originalCallsHash",
    "originalOperationId",
    "originalOperationReceiptHash",
    "originalGrantHash",
    "configurationSha256",
    "recognitionSha256",
  ])
    bytes32(a[key]);
  address(a.ownerWallet);
  address(a.recipient);
  insist(
    /^[a-f0-9-]{36}$/.test(text(a.submissionId, 36)) &&
      a.jobId === `publication:${a.submissionId}` &&
      (a.rating === "general" || a.rating === "adult_18") &&
      /^(und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(text(a.language, 35)),
    "invalid_curated_identity",
  );
  integer(a.expiresAt, 1, Number.MAX_SAFE_INTEGER);
  const execution = object(a.execution),
    posting = object(execution.posting);
  insist(
    execution.configurationSha256 === a.configurationSha256 &&
      execution.schema === "pirate.publication-execution-profile/1" &&
      execution.grantHash !== a.originalGrantHash &&
      httpsOrigin(execution.serviceOrigin) &&
      posting.postsContract === config.postsContract &&
      posting.expiresAt === a.expiresAt,
    "curated_execution_changed",
    409,
  );
  insist(
    typeof signed.signature === "string" &&
      /^0x[0-9a-f]{130}$/.test(signed.signature),
    "invalid_curated_signature",
  );
  const signer = await recoverMessageAddress({
    message: { raw: hashJson(a) },
    signature: signed.signature as `0x${string}`,
  });
  insist(
    signer.toLowerCase() === config.controller,
    "untrusted_curated_controller",
    403,
  );
  return signed as unknown as SignedCuratedAmendment;
}
export async function selectedCuratedAmendment(
  db: D1Database,
  jobId: string,
  config: CommunityConfig,
) {
  if (!ownerCurated(config.policies.admission)) return null;
  const row = await db
    .prepare("SELECT signed_json FROM publication_amendments WHERE job_id=?")
    .bind(jobId)
    .first<{ signed_json: string }>();
  insist(row, "curated_amendment_required", 409);
  return validateCuratedAmendment(JSON.parse(row.signed_json), config);
}
export async function requireCuratedOwner(
  db: D1Database,
  config: CommunityConfig,
  wallet: string,
) {
  if (!ownerCurated(config.policies.admission)) return;
  const rows = await db
    .prepare("SELECT signed_json FROM publication_amendments LIMIT 2")
    .all<{ signed_json: string }>();
  insist(rows.results.length === 1, "curated_owner_scope_unavailable", 503);
  const signed = await validateCuratedAmendment(
    JSON.parse(rows.results[0]!.signed_json),
    config,
  );
  insist(
    signed.amendment.ownerWallet === wallet,
    "owner_publication_only",
    403,
  );
}
