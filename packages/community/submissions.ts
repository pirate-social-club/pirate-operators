import { captureNativeSubmission } from "./native-business-binding.ts";
import type { AccountSession } from "./accounts.ts";
import {
  bytes32,
  canonical,
  exact,
  hashJson,
  insist,
  integer,
  MAX_AUDIO_BYTES,
  object,
  publicId,
  text,
  token,
} from "./common.ts";
import { createLyrics, type LyricManifest } from "./lyric-manifest.ts";
import {
  identity,
  RELEASE_POLICY,
  RELEASE_POLICY_HASH,
  type PublicationIdentity,
} from "./manifest-core.ts";

import type { PublicationExecutionProfile } from "./publication-profile.ts";
import {
  CATALOG_OWNER_POLICY_VERSION, CATALOG_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "./owner-policy.ts";
import { catalogObligationStatement, intentFromSealed } from "./catalog-outbox.ts";
import { recognitionProfile, type RecognitionProfile } from "../recognition/intent.ts";
import type { OwnerAuthorization } from "./owner-authorization.ts";

export interface SubmissionProfile extends Omit<PublicationIdentity, "postId"> {
  configurationRevision: number;
  publisher: string;
  moderationSigner: string;
  execution?: PublicationExecutionProfile;
  recognition?: RecognitionProfile;
  communityOrigin?: string;
}
export interface Submission {
  submission_id: string;
  account_id: string;
  author_id: string;
  post_id: string;
  request_hash: string;
  metadata_json: string;
  captured_wallet: string;
  creator_json: string;
  audio_sha256: string;
  audio_bytes: number;
  object_key: string;
  upload_state: "reserved" | "uploading" | "uploaded" | "sealed";
  upload_lease: string | null;
  upload_lease_until: number;
  object_etag: string | null;
  sealed_at?: number | null;
}
export interface SongMetadata {
  title: string;
  language: string;
  lyrics: LyricManifest;
  original: true;
  acceptedPolicy: typeof RELEASE_POLICY;
}
/** Owner-only metadata under the unregistered owner policy. */
export interface OwnerSongMetadata {
  title: string;
  language: string;
  lyrics: LyricManifest;
  original: true;
  acceptedPolicy: typeof UNREGISTERED_OWNER_POLICY_VERSION | typeof CATALOG_OWNER_POLICY_VERSION;
  terms?: {revision:1;allowsDerivatives:boolean};
  rating: "general" | "adult";
}
interface CreatorBinding {
  service_origin: string;
  credential_ref: string;
  sui_address: string;
  dwallet_id: string;
  capability_id: string;
  share_id: string;
  evm_address: string;
  receipt_json: string;
  verified_at: number;
}
export async function ownedSubmission(
  db: D1Database,
  id: string,
  accountId: string,
) {
  const row = await db
    .prepare(
      "SELECT * FROM media_submissions WHERE submission_id=? AND account_id=?",
    )
    .bind(id, accountId)
    .first<Submission>();
  insist(row, "submission_not_found", 404);
  return row;
}

export async function reserveSubmission(
  db: D1Database,
  session: AccountSession,
  profile: SubmissionProfile,
  input: unknown,
  idempotencyKey: string,
  time = Date.now(),
) {
  insist(
    /^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey),
    "idempotency_key_required",
  );
  const body = object(input);
  exact(body, [
    "title",
    "language",
    "lyrics",
    "original",
    "acceptedPolicy",
    "audioSha256",
    "audioBytes",
  ]);
  const title = text(body.title, 200),
    lyrics = text(body.lyrics, 32768),
    language = text(body.language, 35);
  insist(title.trim().length > 0, "title_required");
  insist(
    body.original === true && body.acceptedPolicy === RELEASE_POLICY,
    "publication_consent_required",
  );
  const audioSha256 = bytes32(body.audioSha256),
    audioBytes = integer(body.audioBytes, 1, MAX_AUDIO_BYTES);
  // Check the original request before requiring a fresh creator proof. Reopening
  // an existing upload never captures a different credential or recipient.
  const requestHash = hashJson({ input: body, profile });
  const existing = await db
    .prepare(
      "SELECT * FROM media_submissions WHERE account_id=? AND idempotency_key=?",
    )
    .bind(session.account_id, idempotencyKey)
    .first<Submission>();
  if (existing) {
    insist(
      existing.request_hash === requestHash,
      "idempotency_key_conflict",
      409,
    );
    return existing;
  }
  const creator = await db
    .prepare("SELECT * FROM creator_bindings WHERE account_id=?")
    .bind(session.account_id)
    .first<CreatorBinding>();
  insist(
    creator &&
      creator.verified_at > time - 300_000 &&
      creator.verified_at <= time,
    "creator_activation_verification_required",
    409,
  );
  const postId = publicId(),
    submissionId = crypto.randomUUID();
  const metadata: SongMetadata = {
    title,
    language,
    lyrics: createLyrics(identity({ ...profile, postId }), lyrics, language),
    original: true,
    acceptedPolicy: RELEASE_POLICY,
  };
  const reservation=db
    .prepare(
      `INSERT INTO media_submissions(submission_id,account_id,author_id,post_id,idempotency_key,request_hash,metadata_json,captured_wallet,creator_json,audio_sha256,audio_bytes,object_key,upload_state,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'reserved',? WHERE (SELECT COUNT(*) FROM media_submissions WHERE account_id=? AND upload_state!='sealed')<5
    ON CONFLICT(account_id,idempotency_key) DO NOTHING`,
    )
    .bind(
      submissionId,
      session.account_id,
      session.author_id,
      postId,
      idempotencyKey,
      requestHash,
      canonical(metadata),
      session.wallet,
      canonical(creator),
      audioSha256,
      audioBytes,
      `staging/${submissionId}/${token()}`,
      time,
      session.account_id,
    );
  await db.batch([reservation,...await captureNativeSubmission(db,submissionId,session.account_id,idempotencyKey,profile)]);
  const saved = await db
    .prepare(
      "SELECT * FROM media_submissions WHERE account_id=? AND idempotency_key=?",
    )
    .bind(session.account_id, idempotencyKey)
    .first<Submission>();
  insist(saved, "unfinished_upload_limit", 429);
  insist(saved.request_hash === requestHash, "idempotency_key_conflict", 409);
  return saved;
}

/**
 * Owner-only reservation under the unregistered owner policy. The caller has
 * already verified the controller-signed owner authorization for this session
 * wallet. No creator binding is read or captured.
 */
export async function reserveOwnerSubmission(
  db: D1Database,
  session: AccountSession,
  profile: SubmissionProfile,
  authorization: OwnerAuthorization,
  input: unknown,
  idempotencyKey: string,
  time = Date.now(),
) {
  insist(
    /^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey),
    "idempotency_key_required",
  );
  insist(
    session.wallet.toLowerCase() === authorization.ownerWallet,
    "owner_publication_only",
    403,
  );
  const body = object(input);
  exact(body, [
    "title",
    "language",
    "lyrics",
    "original",
    "acceptedPolicy",
    "rating",
    "audioSha256",
    "audioBytes",
    ...(authorization.policy.version === CATALOG_OWNER_POLICY_VERSION ? ["terms"] : []),
  ]);
  const title = text(body.title, 200),
    lyrics = text(body.lyrics, 32768),
    language = text(body.language, 35);
  insist(title.trim().length > 0, "title_required");
  insist(
    body.original === true &&
      body.acceptedPolicy === authorization.policy.version,
    "publication_consent_required",
  );
  insist(
    body.rating === "general" || body.rating === "adult",
    "invalid_declared_rating",
  );
  let terms: OwnerSongMetadata["terms"];
  if (authorization.policy.version === CATALOG_OWNER_POLICY_VERSION) {
    const t = object(body.terms); exact(t, ["revision","allowsDerivatives"]);
    insist(t.revision === 1 && typeof t.allowsDerivatives === "boolean", "publication_terms_required");
    insist(profile.recognition && profile.communityOrigin, "recognition_profile_required", 503);
    recognitionProfile(profile.recognition);
    terms = {revision:1,allowsDerivatives:t.allowsDerivatives};
  }
  const audioSha256 = bytes32(body.audioSha256),
    audioBytes = integer(body.audioBytes, 1, MAX_AUDIO_BYTES);
  const requestHash = hashJson({ input: body, profile });
  const existing = await db
    .prepare(
      "SELECT * FROM media_submissions WHERE account_id=? AND idempotency_key=?",
    )
    .bind(session.account_id, idempotencyKey)
    .first<Submission>();
  if (existing) {
    insist(
      existing.request_hash === requestHash,
      "idempotency_key_conflict",
      409,
    );
    return existing;
  }
  const postId = publicId(),
    submissionId = crypto.randomUUID();
  const metadata: OwnerSongMetadata = {
    title,
    language,
    lyrics: createLyrics(identity({ ...profile, postId }), lyrics, language),
    original: true,
    acceptedPolicy: authorization.policy.version as OwnerSongMetadata["acceptedPolicy"],
    ...(terms ? {terms} : {}),
    rating: body.rating,
  };
  const reservation=db
    .prepare(
      `INSERT INTO media_submissions(submission_id,account_id,author_id,post_id,idempotency_key,request_hash,metadata_json,captured_wallet,creator_json,audio_sha256,audio_bytes,object_key,upload_state,created_at)
    SELECT ?,?,?,?,?,?,?,?,'null',?,?,?,'reserved',? WHERE (SELECT COUNT(*) FROM media_submissions WHERE account_id=? AND upload_state!='sealed')<5
    ON CONFLICT(account_id,idempotency_key) DO NOTHING`,
    )
    .bind(
      submissionId,
      session.account_id,
      session.author_id,
      postId,
      idempotencyKey,
      requestHash,
      canonical(metadata),
      session.wallet,
      audioSha256,
      audioBytes,
      `staging/${submissionId}/${token()}`,
      time,
      session.account_id,
    );
  await db.batch([reservation,...await captureNativeSubmission(db,submissionId,session.account_id,idempotencyKey,profile)]);
  const saved = await db
    .prepare(
      "SELECT * FROM media_submissions WHERE account_id=? AND idempotency_key=?",
    )
    .bind(session.account_id, idempotencyKey)
    .first<Submission>();
  insist(saved, "unfinished_upload_limit", 429);
  insist(saved.request_hash === requestHash, "idempotency_key_conflict", 409);
  return saved;
}

export async function sealSubmission(
  db: D1Database,
  media: R2Bucket,
  session: AccountSession,
  profile: SubmissionProfile,
  id: string,
  time = Date.now(),
  ownerAuthorization?: OwnerAuthorization,
) {
  const row = await ownedSubmission(db, id, session.account_id);
  insist(
    row.upload_state === "uploaded" || row.upload_state === "sealed",
    "upload_not_complete",
    409,
  );
  const head = await media.head(row.object_key);
  insist(
    head &&
      head.size === row.audio_bytes &&
      head.etag === row.object_etag &&
      head.customMetadata?.sha256 === row.audio_sha256,
    "sealed_media_missing_or_changed",
    409,
  );
  // Reopening after a configuration change cannot silently move an upload to a
  // different publisher/policy. Its initial request already captured the profile.
  const metadata = JSON.parse(row.metadata_json) as
    | SongMetadata
    | OwnerSongMetadata;
  const catalog = metadata.acceptedPolicy === CATALOG_OWNER_POLICY_VERSION;
  const owner = catalog || metadata.acceptedPolicy === UNREGISTERED_OWNER_POLICY_VERSION;
  insist(owner === !!ownerAuthorization, "submission_policy_mismatch", 409);
  const authority = owner
    ? {
        ...profile,
        accountId: row.account_id,
        authorId: row.author_id,
        wallet: row.captured_wallet,
        creator: null,
        policy: {
          version: catalog ? CATALOG_OWNER_POLICY_VERSION : UNREGISTERED_OWNER_POLICY_VERSION,
          sha256: catalog ? CATALOG_OWNER_POLICY_HASH : UNREGISTERED_OWNER_POLICY_HASH,
        },
        ownerAuthorizationSha256: hashJson(ownerAuthorization),
      }
    : {
        ...profile,
        accountId: row.account_id,
        authorId: row.author_id,
        wallet: row.captured_wallet,
        creator: JSON.parse(row.creator_json),
        policy: { version: RELEASE_POLICY, sha256: RELEASE_POLICY_HASH },
      };
  const requestInput = {
    title: metadata.title,
    language: metadata.language,
    lyrics: metadata.lyrics.sourceText,
    original: metadata.original,
    acceptedPolicy: metadata.acceptedPolicy,
    ...("rating" in metadata ? { rating: metadata.rating } : {}),
    ...("terms" in metadata && metadata.terms ? {terms:metadata.terms} : {}),
    audioSha256: row.audio_sha256,
    audioBytes: row.audio_bytes,
  };
  insist(
    hashJson({ input: requestInput, profile }) === row.request_hash,
    "submission_profile_changed",
    409,
  );
  const inputHash = hashJson({
    metadata,
    audioSha256: row.audio_sha256,
    audioBytes: row.audio_bytes,
    authority,
  });
  const jobId = `publication:${id}`, acceptedAt = row.sealed_at ?? time;
  await db.batch([
    db
      .prepare(
        `UPDATE media_submissions SET upload_state='sealed',sealed_at=COALESCE(sealed_at,?)
      WHERE submission_id=? AND account_id=? AND upload_state='uploaded'`,
      )
      .bind(time, id, session.account_id),
    db
      .prepare(
        `INSERT INTO publication_jobs(job_id,submission_id,input_hash,authority_json,phase,due_at,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,? FROM media_submissions WHERE submission_id=? AND account_id=? AND upload_state='sealed'
      ON CONFLICT(submission_id) DO NOTHING`,
      )
      .bind(
        jobId,
        id,
        inputHash,
        canonical(authority),
        catalog ? "catalog_reserve" : "admission",
        time,
        time,
        time,
        id,
        session.account_id,
      ),
    ...(catalog ? [catalogObligationStatement(db, intentFromSealed({jobId,inputHash,authority,row,metadata,acceptedAt})),
      db.prepare("INSERT INTO transaction_guards(guard_id,valid) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM publication_catalog_obligations o JOIN publication_jobs j ON j.job_id=o.job_id WHERE j.job_id=? AND j.input_hash=? AND o.intent_sha256=?) THEN 1 ELSE 0 END")
        .bind(token(),jobId,inputHash,hashJson(intentFromSealed({jobId,inputHash,authority,row,metadata,acceptedAt}))) ] : []),
  ]);
  const job = await db
    .prepare(
      "SELECT job_id,input_hash FROM publication_jobs WHERE submission_id=?",
    )
    .bind(id)
    .first<{ job_id: string; input_hash: string }>();
  insist(
    job?.job_id === jobId && job.input_hash === inputHash,
    "sealed_input_conflict",
    409,
  );
  return { jobId, postId: row.post_id };
}
