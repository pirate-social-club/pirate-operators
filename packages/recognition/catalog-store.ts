import { canonical, hashJson, insist, text } from "../community/common.ts";
import type {
  SongSourceRegistration,
  SongSourceRecordingStore,
} from "./catalog-workflow.ts";

/** Loaded from verified publication/creator authority by the service. Never
 * deserialize these facts directly from an enrollment HTTP request. */
export interface AcceptedRecording {
  assetId: string;
  creatorId: string;
  communityId: string;
  postId: string;
  publicationRevision: number;
  audioRevision: number;
  audioSha256: string;
  immutableAudioRef: string;
  verificationSample: SongSourceRegistration["verificationSample"];
  termsRevision: number;
  termsHash: string;
  allowsDerivatives: boolean;
}
interface Row {
  registration_json: string;
  publication_json: string;
  creator_id: string;
  state: SongSourceRegistration["state"];
  provider_file_id: string | null;
  provider_match_id: string | null;
  claim_owner: string | null;
  claim_fence: number;
}
const fields = (row: Row): SongSourceRegistration => ({
  ...JSON.parse(row.registration_json),
  state: row.state,
  providerFileId: row.provider_file_id,
  providerMatchId: row.provider_match_id,
  claimOwner: row.claim_owner,
  claimFence: BigInt(row.claim_fence),
});

/** All accepted licenses enroll. Permission to derive is evaluated separately. */
export async function enrollAcceptedRecording(
  db: D1Database,
  assetId: string,
  bucketId: string,
  readAccepted: (assetId: string) => Promise<AcceptedRecording | null>,
) {
  insist(/^[1-9][0-9]*$/.test(bucketId), "invalid_catalog_bucket");
  const publication = await readAccepted(assetId);
  insist(
    publication && publication.assetId === assetId,
    "accepted_recording_required",
    403,
  );
  insist(
    /^[0-9a-f]{64}$/.test(publication.audioSha256) &&
      /^0x[0-9a-f]{64}$/.test(publication.termsHash) &&
      typeof publication.allowsDerivatives === "boolean" &&
      [
        publication.publicationRevision,
        publication.audioRevision,
        publication.termsRevision,
      ].every((n) => Number.isSafeInteger(n) && n > 0),
    "invalid_recording_authority",
  );
  text(publication.creatorId, 256);
  insist(publication.creatorId.length > 0, "creator_required");
  const registrationId = hashJson({
    assetId,
    audioRevision: publication.audioRevision,
    audioSha256: publication.audioSha256,
    bucketId,
  });
  const registration = {
    registrationId,
    assetId,
    submissionId: registrationId,
    operationId: registrationId,
    audioRevision: publication.audioRevision,
    analysisRevision: 1,
    publicationRevision: publication.publicationRevision,
    termsRevision: publication.termsRevision,
    canonicalAudioSha256: publication.audioSha256,
    immutableAudioRef: publication.immutableAudioRef,
    verificationSample: publication.verificationSample,
    provider: "acrcloud",
    bucketId,
    opaqueTitle: `pirate-${registrationId.slice(2)}`,
  };
  await db
    .prepare(
      `INSERT INTO recognition_recordings(registration_id,asset_id,creator_id,publication_json,registration_json,state)
    VALUES(?,?,?,?,?,'pending_upload') ON CONFLICT DO NOTHING`,
    )
    .bind(
      registrationId,
      assetId,
      publication.creatorId,
      canonical(publication),
      canonical(registration),
    )
    .run();
  const row = await db
    .prepare("SELECT * FROM recognition_recordings WHERE registration_id=?")
    .bind(registrationId)
    .first<Row>();
  insist(
    row &&
      row.registration_json === canonical(registration) &&
      row.publication_json === canonical(publication),
    "recording_identity_conflict",
    409,
  );
  return registrationId;
}
export async function claimRecording(
  db: D1Database,
  id: string,
  workerId: string,
  now = Date.now(),
) {
  const row = await db
    .prepare(
      `UPDATE recognition_recordings SET claim_owner=?,claim_fence=claim_fence+1,lease_until=?
    WHERE registration_id=? AND lease_until<=? AND state NOT IN ('ready','failed','deleted','deletion_pending') RETURNING *`,
    )
    .bind(workerId, now + 120000, id, now)
    .first<Row>();
  return row ? fields(row) : null;
}
export function recordingStore(db: D1Database): SongSourceRecordingStore {
  const transition = async (
    input: { registrationId: string; workerId: string; claimFence: bigint },
    state: string,
    evidence: unknown,
    file?: { providerFileId: string; providerMatchId: string },
  ) => {
    const encoded = canonical(evidence),
      now = Date.now();
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO recognition_catalog_events(registration_id,state,evidence_json,created_at)
        SELECT registration_id,?,?,? FROM recognition_recordings WHERE registration_id=? AND claim_owner=? AND claim_fence=? AND lease_until>?`,
        )
        .bind(
          state,
          encoded,
          now,
          input.registrationId,
          input.workerId,
          Number(input.claimFence),
          now,
        ),
      db
        .prepare(
          `UPDATE recognition_recordings SET state=?,evidence_json=?,provider_file_id=COALESCE(?,provider_file_id),provider_match_id=COALESCE(?,provider_match_id)
        WHERE registration_id=? AND claim_owner=? AND claim_fence=? AND lease_until>?`,
        )
        .bind(
          state,
          encoded,
          file?.providerFileId ?? null,
          file?.providerMatchId ?? null,
          input.registrationId,
          input.workerId,
          Number(input.claimFence),
          now,
        ),
    ]);
    return results[1].meta.changes === 1;
  };
  return {
    async get(id) {
      const row = await db
        .prepare("SELECT * FROM recognition_recordings WHERE registration_id=?")
        .bind(id)
        .first<Row>();
      return row ? fields(row) : null;
    },
    acceptProviderFile: (input) =>
      transition(
        input,
        "provider_processing",
        { digest: input.evidenceDigest, file: input.file },
        input.file,
      ),
    markProviderOutcomeUnknown: (input) =>
      transition(input, "provider_outcome_unknown", {
        digest: input.evidenceDigest,
      }),
    markReady: (input) =>
      transition(input, "ready", input.identificationEvidence, input),
    fail: (input) =>
      transition(input, "failed", {
        code: input.failureCode,
        evidenceRef: input.evidenceRef,
      }),
  };
}
export async function recordingForMatch(
  db: D1Database,
  providerMatchId: string,
) {
  const row = await db
    .prepare(
      "SELECT * FROM recognition_recordings WHERE provider_match_id=? AND state='ready'",
    )
    .bind(providerMatchId)
    .first<Row>();
  return row ? (JSON.parse(row.publication_json) as AcceptedRecording) : null;
}
