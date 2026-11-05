import type {
  MediaIdentificationOutcome,
  MediaIdentificationProviderService,
} from "./identification.ts";
export const SONG_SOURCE_RECORDING_AUTHORITY_VERSION =
  "song-source-recording-authority-v1" as const;

export type SongSourceRegistrationState =
  | "pending_upload"
  | "provider_outcome_unknown"
  | "provider_processing"
  | "ready"
  | "failed"
  | "deletion_pending"
  | "deleted";

export type SongSourceRegistration = Readonly<{
  registrationId: string;
  assetId: string;
  submissionId: string;
  operationId: string;
  audioRevision: number;
  analysisRevision: number;
  publicationRevision: number;
  termsRevision: number;
  canonicalAudioSha256: string;
  immutableAudioRef: string;
  verificationSample: Readonly<{
    objectKey: string;
    contentType: "audio/mpeg" | "audio/wav";
    byteLength: number;
  }>;
  provider: "acrcloud";
  bucketId: string;
  opaqueTitle: string;
  state: SongSourceRegistrationState;
  providerFileId: string | null;
  providerMatchId: string | null;
  claimOwner: string | null;
  claimFence: bigint;
}>;

export type SongSourceCatalogFile = Readonly<{
  providerFileId: string;
  providerMatchId: string;
  bucketId: string;
  opaqueTitle: string;
  state: "processing" | "ready" | "error";
  registrationId: string;
  assetId: string;
  canonicalAudioSha256: string;
}>;

export type SongSourceCatalogLookup =
  | Readonly<{ outcome: "none" }>
  | Readonly<{ outcome: "exact"; file: SongSourceCatalogFile }>
  | Readonly<{ outcome: "ambiguous" }>
  | Readonly<{ outcome: "retryable"; reason: string }>
  | Readonly<{ outcome: "rejected"; reason: string }>;

export type SongSourceCatalogUpload =
  | Readonly<{
      outcome: "accepted";
      file: SongSourceCatalogFile;
      evidenceDigest: string;
    }>
  | Readonly<{ outcome: "ambiguous"; evidenceDigest: string }>
  | Readonly<{ outcome: "retryable"; reason: string }>
  | Readonly<{ outcome: "rejected"; reason: string; evidenceDigest: string }>;

export interface SongSourceCatalog {
  readonly findExact: (
    registration: SongSourceRegistration,
    signal: AbortSignal,
  ) => Promise<SongSourceCatalogLookup>;
  readonly upload: (
    registration: SongSourceRegistration,
    audio: Readonly<{
      bytes: Uint8Array;
      filename: string;
      contentType: string;
    }>,
    signal: AbortSignal,
  ) => Promise<SongSourceCatalogUpload>;
  readonly get: (
    registration: SongSourceRegistration,
    providerFileId: string,
    signal: AbortSignal,
  ) => Promise<SongSourceCatalogLookup>;
}

export interface SongSourceAudioReader {
  readonly readCanonical: (
    registration: SongSourceRegistration,
    signal: AbortSignal,
  ) => Promise<
    Readonly<{ bytes: Uint8Array; filename: string; contentType: string }>
  >;
  readonly readVerificationSample: (
    registration: SongSourceRegistration,
    signal: AbortSignal,
  ) => Promise<
    Readonly<{ bytes: Uint8Array; filename: string; contentType: string }>
  >;
}

export type SongSourceFailureCode =
  | "catalog_configuration_invalid"
  | "catalog_upload_rejected"
  | "catalog_record_ambiguous"
  | "catalog_record_invalid"
  | "catalog_processing_failed"
  | "verification_rejected"
  | "verification_mismatch";

export interface SongSourceRecordingStore {
  readonly get: (
    registrationId: string,
  ) => Promise<SongSourceRegistration | null>;
  readonly acceptProviderFile: (
    input: Readonly<{
      registrationId: string;
      workerId: string;
      claimFence: bigint;
      file: SongSourceCatalogFile;
      evidenceDigest: string;
    }>,
  ) => Promise<boolean>;
  readonly markProviderOutcomeUnknown: (
    input: Readonly<{
      registrationId: string;
      workerId: string;
      claimFence: bigint;
      evidenceDigest: string;
    }>,
  ) => Promise<boolean>;
  readonly markReady: (
    input: Readonly<{
      registrationId: string;
      workerId: string;
      claimFence: bigint;
      providerFileId: string;
      providerMatchId: string;
      identificationEvidence: MediaIdentificationOutcome;
    }>,
  ) => Promise<boolean>;
  readonly fail: (
    input: Readonly<{
      registrationId: string;
      workerId: string;
      claimFence: bigint;
      failureCode: SongSourceFailureCode;
      evidenceRef: string;
    }>,
  ) => Promise<boolean>;
}

export type SongSourceRecordingWorkflowDependencies = Readonly<{
  enabled: boolean;
  workerId: string;
  adapterRevision: string;
  store: SongSourceRecordingStore;
  catalog: SongSourceCatalog;
  audio: SongSourceAudioReader;
  identification: MediaIdentificationProviderService;
}>;

export type SongSourceRecordingWorkflowResult = Readonly<{
  outcome: "inert" | "waiting" | "progress" | "ready" | "failed" | "lost_claim";
}>;
