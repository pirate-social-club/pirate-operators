import type { CommunityConfig } from "./config-manifest.ts";
import {
  canonical,
  exact,
  hashJson,
  insist,
  integer,
  object,
  text,
} from "./common.ts";
import {
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
  address,
} from "./manifest-core.ts";
import { validateLyrics } from "./lyric-manifest.ts";
import { loadJob } from "./publication-store.ts";
import type { Submission, SongMetadata } from "./submissions.ts";
import type { ReleaseContext } from "../release/authority.ts";
import { selectedCuratedAmendment } from "./curated-amendment.ts";
import { curatedAdmissionId } from "./curated-amendment.ts";

export async function publicationInput(
  db: D1Database,
  media: Pick<R2Bucket, "head">,
  jobId: string,
  config: CommunityConfig,
) {
  const job = await loadJob(db, jobId),
    authority = object(JSON.parse(job.authority_json));
  const signed = await selectedCuratedAmendment(db, jobId, config),
    originalConfig = signed?.amendment.originalConfiguration ?? config;
  const row = await db
    .prepare(
      "SELECT * FROM media_submissions WHERE submission_id=? AND upload_state='sealed'",
    )
    .bind(job.submission_id)
    .first<Submission>();
  insist(row, "sealed_submission_unavailable", 503);
  const raw = object(JSON.parse(row.metadata_json));
  exact(raw, ["title", "language", "lyrics", "original", "acceptedPolicy"]);
  const metadata: SongMetadata = {
    title: text(raw.title, 200),
    language: text(raw.language, 35),
    lyrics: validateLyrics(raw.lyrics),
    original: true,
    acceptedPolicy: RELEASE_POLICY,
  };
  insist(
    raw.original === true &&
      raw.acceptedPolicy === RELEASE_POLICY &&
      metadata.language === metadata.lyrics.language,
    "sealed_metadata_changed",
    503,
  );
  const policy = object(authority.policy),
    creator = object(authority.creator);
  insist(
    authority.chainId === originalConfig.chainId &&
      authority.communityId === originalConfig.communityId &&
      authority.postsContract === originalConfig.postsContract &&
      authority.configurationRevision ===
        originalConfig.configurationRevision &&
      authority.publisher === originalConfig.publisher &&
      authority.moderationSigner === originalConfig.policies.moderationSigner &&
      authority.accountId === row.account_id &&
      authority.authorId === row.author_id &&
      authority.wallet === row.captured_wallet &&
      policy.version === RELEASE_POLICY &&
      policy.sha256 === RELEASE_POLICY_HASH &&
      canonical(creator) === row.creator_json,
    "publication_authority_changed",
    409,
  );
  insist(
    metadata.lyrics.postId === row.post_id &&
      metadata.lyrics.communityId === config.communityId &&
      metadata.lyrics.postsContract === config.postsContract,
    "sealed_lyrics_identity_changed",
    503,
  );
  insist(
    hashJson({
      metadata,
      audioSha256: row.audio_sha256,
      audioBytes: row.audio_bytes,
      authority,
    }) === job.input_hash,
    "sealed_publication_input_changed",
    503,
  );
  const head = await media.head(row.object_key);
  insist(
    head &&
      head.etag === row.object_etag &&
      head.size === row.audio_bytes &&
      head.customMetadata?.sha256 === row.audio_sha256,
    "sealed_media_missing_or_changed",
    503,
  );
  const context: ReleaseContext = {
    jobId: job.job_id,
    admissionId: signed
      ? curatedAdmissionId(config.communityId, job.job_id)
      : hashJson({
          communityId: config.communityId,
          jobId: job.job_id,
        }),
    postId: row.post_id,
    authorId: row.author_id,
    recipient: address(creator.evm_address),
    lineage: "root",
    lyrics: metadata.lyrics,
  };
  if (signed) {
    const a = signed.amendment,
      originalExecution = object(authority.execution);
    insist(
      originalExecution.configurationSha256 === hashJson(originalConfig),
      "curated_predecessor_configuration_changed",
      409,
    );
    const previous = await db
      .prepare(
        "SELECT result_json FROM external_operations WHERE operation_id=? AND job_id=? AND status='failed'",
      )
      .bind(a.originalOperationId, jobId)
      .first<{ result_json: string }>();
    insist(
      a.jobId === jobId &&
        a.submissionId === row.submission_id &&
        a.postId === row.post_id &&
        a.authorId === row.author_id &&
        a.ownerWallet === row.captured_wallet &&
        a.recipient === context.recipient &&
        a.contentSha256 === row.audio_sha256 &&
        a.originalInputHash === job.input_hash &&
        a.originalAuthorityHash === hashJson(authority) &&
        a.originalRequestHash === row.request_hash &&
        a.originalGrantHash === originalExecution.grantHash &&
        a.execution.serviceOrigin === originalExecution.serviceOrigin &&
        a.language === metadata.language &&
        previous &&
        hashJson(JSON.parse(previous.result_json)) ===
          a.originalOperationReceiptHash,
      "curated_original_input_changed",
      409,
    );
  }
  const createdAt = integer(
    (job as typeof job & { created_at: number }).created_at,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  return {
    job,
    row,
    metadata,
    authority: signed
      ? {
          ...authority,
          configurationRevision: config.configurationRevision,
          policy: config.policies.admission,
          execution: signed.amendment.execution,
          curatedAmendmentSha256: hashJson(signed),
        }
      : authority,
    amendment: signed,
    context,
    createdAt,
    progress: object(JSON.parse(job.progress_json)),
  };
}
export type PublicationInput = Awaited<ReturnType<typeof publicationInput>>;
