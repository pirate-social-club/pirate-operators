import {
  bytes32,
  exact,
  hashJson,
  insist,
  integer,
  object,
  text,
} from "../community/common.ts";

/** Facts obtained by a server-owned publication/creator verifier, never an HTTP body cast. */
export interface VerifiedPublication {
  namespace: string;
  communityId: string;
  postId: string;
  publicationRevision: number;
  configurationRevision: number;
  creatorKey: string;
  audioSha256: string;
  audioBytes: number;
  audioObjectKey: string;
  audioRevision: number;
  termsRevision: number;
  termsSha256: string;
  allowsDerivatives: boolean;
  publicationEvidenceSha256: string;
}
export function verifiedPublication(value: unknown): VerifiedPublication {
  const p = object(value);
  exact(p, [
    "namespace",
    "communityId",
    "postId",
    "publicationRevision",
    "configurationRevision",
    "creatorKey",
    "audioSha256",
    "audioBytes",
    "audioObjectKey",
    "audioRevision",
    "termsRevision",
    "termsSha256",
    "allowsDerivatives",
    "publicationEvidenceSha256",
  ]);
  insist(typeof p.allowsDerivatives === "boolean", "invalid_recognition_terms");
  const creatorKey = text(p.creatorKey, 256),
    audioObjectKey = text(p.audioObjectKey, 512);
  insist(
    /^eip155:6343:0x[0-9a-f]{40}$/.test(creatorKey) &&
      !creatorKey.endsWith("0".repeat(40)),
    "invalid_recognition_creator",
  );
  insist(
    audioObjectKey.length > 0 && !audioObjectKey.includes("://"),
    "invalid_recognition_object",
  );
  return {
    namespace: bytes32(p.namespace),
    communityId: bytes32(p.communityId),
    postId: bytes32(p.postId),
    publicationRevision: integer(p.publicationRevision, 1, 2147483647),
    configurationRevision: integer(p.configurationRevision, 1, 2147483647),
    creatorKey,
    audioSha256: bytes32(p.audioSha256),
    audioBytes: integer(p.audioBytes, 1, 25 * 1024 * 1024),
    audioObjectKey,
    audioRevision: integer(p.audioRevision, 1, 2147483647),
    termsRevision: integer(p.termsRevision, 1, 2147483647),
    termsSha256: bytes32(p.termsSha256),
    allowsDerivatives: p.allowsDerivatives,
    publicationEvidenceSha256: bytes32(p.publicationEvidenceSha256),
  };
}
export const recordingId = (
  p: Pick<VerifiedPublication, "namespace" | "audioSha256">,
) =>
  hashJson({
    schema: "pirate.recognition-recording/1",
    namespace: p.namespace,
    audioSha256: p.audioSha256,
  });
export const associationId = (
  p: Pick<
    VerifiedPublication,
    "namespace" | "communityId" | "postId" | "publicationRevision"
  >,
) =>
  hashJson({
    schema: "pirate.recognition-publication/1",
    namespace: p.namespace,
    communityId: p.communityId,
    postId: p.postId,
    publicationRevision: p.publicationRevision,
  });
export type RecordingState =
  | "pending"
  | "upload_unknown"
  | "processing"
  | "verification_unknown"
  | "ready"
  | "failed"
  | "deleting"
  | "deleted";
export interface Recording {
  recording_id: string;
  namespace: string;
  creator_key: string;
  audio_sha256: string;
  audio_bytes: number;
  state: RecordingState;
  provider_file_id: string | null;
  provider_match_id: string | null;
  claim_token: string | null;
  lease_until: number;
  attempt: number;
}
export interface Association {
  association_id: string;
  recording_id: string;
  publication_json: string;
  state: "active" | "withdrawn";
}
export interface CatalogStatusSnapshot {
  association_id: string;
  recording_id: string;
  publication_json: string;
  association_state: "active" | "withdrawn";
  recording_state: RecordingState;
  canonical_audio_sha256: string;
  catalog_revision: number;
}
export interface CatalogFile {
  recordingId: string;
  namespace: string;
  audioSha256: string;
  fileId: string;
  matchId: string;
  state: "processing" | "ready" | "error";
}
export type CatalogLookup =
  | { outcome: "none" }
  | { outcome: "ambiguous" }
  | { outcome: "retryable" }
  | { outcome: "exact"; file: CatalogFile };
export type CatalogUpload =
  | { outcome: "unknown" }
  | { outcome: "rejected" }
  | { outcome: "accepted"; file: CatalogFile };
export interface RecognitionCatalog {
  find(
    recording: Recording,
    signal: AbortSignal,
    beforeSend: () => Promise<void>,
  ): Promise<CatalogLookup>;
  upload(
    recording: Recording,
    audio: Uint8Array,
    signal: AbortSignal,
    beforeSend: () => Promise<void>,
  ): Promise<CatalogUpload>;
  remove(
    recording: Recording,
    signal: AbortSignal,
    beforeSend: () => Promise<void>,
  ): Promise<"deleted" | "unknown" | "rejected">;
}
export const exactCatalogFile = (r: Recording, f: CatalogFile) =>
  f.namespace === r.namespace &&
  f.recordingId === r.recording_id &&
  f.audioSha256 === r.audio_sha256 &&
  /^[1-9][0-9]*$/.test(f.fileId) &&
  f.matchId.length > 0 &&
  f.matchId.length <= 512 &&
  ["processing", "ready", "error"].includes(f.state);
