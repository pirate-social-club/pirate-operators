import {
  base64UrlToBytes,
  bytesToBase64Url,
  serializeTextSubmissionRequest,
  sha256Hex,
  TextSubmissionContractError,
  type TextContentSubmissionRequestEnvelopeV1,
} from "./text-submission-contract.ts";

export const PENDING_SUBMISSION_VERSION = "pending-submission-v1" as const;
export const PENDING_SUBMISSION_CONTENT_TYPE = "application/json" as const;
export const MAX_PENDING_BODY_BYTES = 1_048_576;

/**
 * One text post request retained for the life of the composer operation, so a
 * retry after an ambiguous response replays the exact bytes and idempotency
 * key rather than building a second request. The product has no saved drafts;
 * this envelope never leaves memory and is never rendered back as a draft.
 */
export interface PendingSubmissionEnvelopeV1 {
  readonly version: typeof PENDING_SUBMISSION_VERSION;
  readonly pending_request_id: string;
  readonly idempotency_key: string;
  readonly method: "POST";
  readonly same_origin_path: string;
  readonly content_type: typeof PENDING_SUBMISSION_CONTENT_TYPE;
  readonly body_utf8_base64url: string;
  readonly body_sha256: string;
  readonly submission_id: string | null;
  readonly created_at: string;
}

export class PendingSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingSubmissionError";
  }
}

export function assertSafeSameOriginPath(path: string): string {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\u0000-\u001F\u007F]/u.test(path) ||
    /%(?:2f|5c)/iu.test(path) ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new PendingSubmissionError(
      "Pending path must be a canonical same-origin path",
    );
  }
  const parsed = new URL(path, "https://same-origin.invalid");
  if (
    parsed.origin !== "https://same-origin.invalid" ||
    parsed.pathname !== path ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new PendingSubmissionError(
      "Pending path must be a canonical same-origin path",
    );
  }
  return path;
}

export function pendingBodyBytes(
  envelope: PendingSubmissionEnvelopeV1,
): Uint8Array {
  const decoded = base64UrlToBytes(envelope.body_utf8_base64url);
  if (decoded.byteLength > MAX_PENDING_BODY_BYTES)
    throw new PendingSubmissionError("Pending body exceeds endpoint limit");
  return decoded;
}

export async function createPendingSubmissionEnvelope(options: {
  readonly request: TextContentSubmissionRequestEnvelopeV1;
  readonly sameOriginPath: string;
  readonly pendingRequestId: string;
  readonly createdAt?: string;
}): Promise<PendingSubmissionEnvelopeV1> {
  const serialized = serializeTextSubmissionRequest(options.request);
  if (serialized.bytes.byteLength > MAX_PENDING_BODY_BYTES) {
    throw new TextSubmissionContractError(
      "Text submission body exceeds endpoint limit",
    );
  }
  const candidatePath = options.sameOriginPath;
  let sameOriginPath: string;
  try {
    sameOriginPath = assertSafeSameOriginPath(candidatePath);
  } catch (error) {
    throw new TextSubmissionContractError(
      error instanceof Error ? error.message : "Pending path must be canonical",
    );
  }
  const bodyUtf8Base64Url = bytesToBase64Url(serialized.bytes);
  return {
    version: PENDING_SUBMISSION_VERSION,
    pending_request_id: options.pendingRequestId,
    idempotency_key: serialized.normalized.body.idempotency_key,
    method: "POST",
    same_origin_path: sameOriginPath,
    content_type: PENDING_SUBMISSION_CONTENT_TYPE,
    body_utf8_base64url: bodyUtf8Base64Url,
    body_sha256: await sha256Hex(serialized.bytes),
    submission_id: null,
    created_at: options.createdAt ?? new Date().toISOString(),
  };
}

interface RawRequestBody {
  readonly idempotency_key?: unknown;
}

function isRequestObject(value: unknown): value is RawRequestBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a retained envelope's digest and key/body binding at a trust
 * boundary. Other composers that carry the same envelope shape reuse it.
 */
export async function validatePendingSubmissionEnvelope(
  value: unknown,
): Promise<PendingSubmissionEnvelopeV1> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PendingSubmissionError("Pending submission must be an object");
  }
  // SAFETY: the preceding branch establishes a non-array object. The closed
  // envelope fields are re-validated by re-creating from the retained bytes.
  const candidate = value as PendingSubmissionEnvelopeV1;
  if (
    candidate.version !== PENDING_SUBMISSION_VERSION ||
    candidate.method !== "POST" ||
    candidate.content_type !== PENDING_SUBMISSION_CONTENT_TYPE ||
    typeof candidate.pending_request_id !== "string" ||
    candidate.pending_request_id === "" ||
    typeof candidate.idempotency_key !== "string" ||
    candidate.idempotency_key === "" ||
    typeof candidate.body_utf8_base64url !== "string" ||
    typeof candidate.body_sha256 !== "string" ||
    (candidate.submission_id !== null &&
      typeof candidate.submission_id !== "string") ||
    typeof candidate.created_at !== "string"
  ) {
    throw new PendingSubmissionError("Unsupported pending submission envelope");
  }
  const sameOriginPath = assertSafeSameOriginPath(candidate.same_origin_path);
  let bytes: Uint8Array;
  try {
    bytes = pendingBodyBytes(candidate);
  } catch (error) {
    if (error instanceof PendingSubmissionError) throw error;
    throw new PendingSubmissionError("Invalid pending body encoding");
  }
  if ((await sha256Hex(bytes)) !== candidate.body_sha256)
    throw new PendingSubmissionError("Pending body hash does not match");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new PendingSubmissionError("Pending body is not valid UTF-8 JSON");
  }
  if (
    !isRequestObject(parsed) ||
    parsed.idempotency_key !== candidate.idempotency_key
  ) {
    throw new PendingSubmissionError(
      "Pending body idempotency key does not match",
    );
  }
  return { ...candidate, same_origin_path: sameOriginPath };
}
