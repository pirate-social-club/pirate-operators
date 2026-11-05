import {
  bytes32,
  canonical,
  exact,
  hashJson,
  insist,
  object,
  text,
} from "../community/common.ts";
import { address } from "../community/manifest-core.ts";
import {
  validateLyrics,
  type LyricManifest,
} from "../community/lyric-manifest.ts";
import { configureBudget, reserveBudget } from "../community/budgets.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { getAdmission } from "../moderation/admission-store.ts";
import {
  verifyAdmission,
  type AdmissionDecision,
} from "../moderation/admission.ts";
import type { PreparedAdmission } from "../moderation/prepare-admission.ts";
import type { EvidenceRecord } from "../moderation/evidence.ts";
import type { RegistrationGrant } from "./registration-operations.ts";
import type { PinGrant } from "./pin-operations.ts";

// This policy is supplied by reviewed operator configuration. Never deserialize
// it from a community request or let a request choose a new budget namespace.
export interface ReleaseGrant {
  sha256: string;
  communityId: string;
  communityOrigin: string;
  configurationRevision: number;
  publisher: string;
  contentSha256: string;
  recipient: string;
  expiresAt: number;
  pins: PinGrant;
  registration: RegistrationGrant;
}
export interface ReleaseContext {
  jobId: string;
  admissionId: string;
  postId: string;
  authorId: string;
  recipient: string;
  lineage: "root";
  lyrics: LyricManifest;
}
export interface AdmittedRelease {
  context: ReleaseContext;
  grant: ReleaseGrant;
  config: CommunityConfig;
  prepared: PreparedAdmission;
  decision: AdmissionDecision;
  evidenceSha256: string;
  createdAt: number;
}
export async function establishRelease(
  db: D1Database,
  input: unknown,
  grant: ReleaseGrant,
  config: CommunityConfig,
  providerEndpoint: string,
  now = Math.floor(Date.now() / 1000),
  mode: "execute" | "reconcile" = "execute",
): Promise<AdmittedRelease | null> {
  const value = object(input);
  exact(value, [
    "jobId",
    "admissionId",
    "postId",
    "authorId",
    "recipient",
    "lineage",
    "lyrics",
  ]);
  insist(
    value.lineage === "root",
    "derivative_registration_requires_parent",
    409,
  );
  const context: ReleaseContext = {
    jobId: text(value.jobId, 128),
    admissionId: bytes32(value.admissionId),
    postId: bytes32(value.postId),
    authorId: bytes32(value.authorId),
    recipient: address(value.recipient),
    lineage: "root",
    lyrics: validateLyrics(value.lyrics),
  };
  insist(
    /^[A-Za-z0-9:_-]{1,128}$/.test(context.jobId),
    "invalid_release_identity",
    400,
  );
  insist(
    Number.isSafeInteger(grant.expiresAt) &&
      (mode === "reconcile" || grant.expiresAt > now) &&
      grant.communityId === config.communityId &&
      grant.communityOrigin === config.app.origin &&
      grant.configurationRevision === config.configurationRevision &&
      grant.publisher === config.publisher &&
      context.recipient === grant.recipient &&
      grant.registration.recipient === grant.recipient &&
      grant.registration.contentSha256 === grant.contentSha256 &&
      grant.registration.sha256 === grant.sha256 &&
      grant.pins.sha256 === grant.sha256,
    "release_grant_unavailable",
    403,
  );
  insist(
    context.lyrics.communityId === config.communityId &&
      context.lyrics.postsContract === config.postsContract &&
      context.lyrics.chainId === 6343 &&
      context.lyrics.postId === context.postId,
    "release_lyrics_identity_mismatch",
    409,
  );
  const prior = await db
    .prepare(
      "SELECT request_hash,context_json,admission_sha256,created_at FROM managed_releases WHERE grant_hash=?",
    )
    .bind(grant.sha256)
    .first<{
      request_hash: string;
      context_json: string;
      admission_sha256: string;
      created_at: number;
    }>();
  if (mode === "reconcile" && !prior) return null;
  const admission = await getAdmission(
    db,
    context.admissionId,
    config.communityId,
  );
  insist(
    admission.job_id === context.jobId &&
      admission.state === "complete" &&
      admission.prepared_json &&
      admission.result_json,
    "release_admission_unavailable",
    409,
  );
  const prepared = JSON.parse(admission.prepared_json) as PreparedAdmission,
    result = object(JSON.parse(admission.result_json)),
    request = object(JSON.parse(admission.request_json)),
    declared = object(request.declared);
  insist(
    declared.songSha256 === grant.contentSha256 &&
      prepared.lyrics === context.lyrics.sourceText,
    "release_content_mismatch",
    409,
  );
  const decision = await verifyAdmission(
    {
      communityId: config.communityId,
      submissionId: admission.submission_id,
      jobId: context.jobId,
      songSha256: bytes32(grant.contentSha256),
      songByteLength: object(object(request.inputs).song).byteLength as number,
      title: prepared.title,
      lyrics: prepared.lyrics,
      songType: "original",
      declaredRating: "general",
      windows: prepared.windows.map(
        ({ objectKey, byteLength, ...window }) => window,
      ),
      providerEndpoint,
    },
    result.evidence as EvidenceRecord[],
    {
      recognitionOperators: [config.policies.recognitionSigner],
      contentOperators: [config.policies.moderationSigner],
      contentProfile: config.policies.contentProfile,
      maxAgeSeconds: 3600,
    },
    mode === "reconcile" ? prior!.created_at : now,
  );
  insist(
    decision.decision === "publish",
    decision.decision === "block" ? "release_rejected" : "release_held",
    409,
  );
  const requestHash = hashJson({ context, grant, configuration: config }),
    evidenceSha256 = hashJson(result),
    keys = [
      {
        scope: `release:grant:${grant.sha256}`,
        period: grant.pins.period,
        asset: "root_releases",
      },
    ];
  if (mode === "execute") {
    await configureBudget(db, keys[0]!, "1");
    await reserveBudget(db, requestHash, requestHash, keys, "1");
    await db
      .prepare(
        "INSERT INTO managed_releases(grant_hash,request_hash,context_json,admission_sha256,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING",
      )
      .bind(grant.sha256, requestHash, canonical(context), evidenceSha256, now)
      .run();
  }
  const saved = await db
    .prepare(
      "SELECT request_hash,context_json,admission_sha256,created_at FROM managed_releases WHERE grant_hash=?",
    )
    .bind(grant.sha256)
    .first<{
      request_hash: string;
      context_json: string;
      admission_sha256: string;
      created_at: number;
    }>();
  insist(
    saved?.request_hash === requestHash &&
      saved.context_json === canonical(context) &&
      saved.admission_sha256 === evidenceSha256,
    "release_grant_already_bound",
    409,
  );
  return {
    context,
    grant,
    config,
    prepared,
    decision,
    evidenceSha256,
    createdAt: saved.created_at,
  };
}
