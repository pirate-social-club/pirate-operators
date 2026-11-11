/**
 * The text-only wire contract from product spec 010 §4.
 *
 * This module is deliberately local to the Solid adapter seam. It does not
 * widen, merge, or replace the generated media submission contracts.
 */

export type TextModerationSurface = "text_post" | "comment" | "reply";

export type TextPublicationDecision = "allow" | "manual_review" | "blocked";

export type PublicTextPublicationResultV1 =
  | { readonly decision: "allow"; readonly reason_code: null }
  | {
      readonly decision: "manual_review";
      readonly reason_code: "review_required" | "moderation_unavailable";
    }
  | { readonly decision: "blocked"; readonly reason_code: "policy_violation" };

export type PublishedTextResourceV1 =
  | { readonly kind: "post"; readonly post_id: string; readonly href: string }
  | {
      readonly kind: "comment";
      readonly comment_id: string;
      readonly href: string;
    };

export interface TextContentSubmissionV1 {
  readonly submission_id: string;
  readonly href: string;
  readonly surface: TextModerationSurface;
  readonly status: "published" | "manual_review" | "blocked";
  readonly result: PublicTextPublicationResultV1;
  readonly published_resource: PublishedTextResourceV1 | null;
  readonly review_ref: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The v1 text creation body. `publish_mode` is intentionally absent. */
export interface TextContentSubmissionRequestV1 {
  readonly idempotency_key: string;
  readonly persona_id: string;
  readonly post_type: "text";
  readonly authorship_mode: "human_direct";
  readonly identity_mode: "public";
  readonly visibility: "public";
  readonly author_declared_rating: "general" | "adult_18";
  readonly title: string | null;
  readonly body: string;
}

interface RawTextSubmissionRequestObject {
  readonly idempotency_key?: unknown;
  readonly persona_id?: unknown;
  readonly post_type?: unknown;
  readonly authorship_mode?: unknown;
  readonly identity_mode?: unknown;
  readonly visibility?: unknown;
  readonly author_declared_rating?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
}

function isTextSubmissionRequestObject(
  value: unknown,
): value is RawTextSubmissionRequestObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface TextContentSubmissionRequestEnvelopeV1 {
  readonly path: { readonly communityId: string };
  readonly body: TextContentSubmissionRequestV1;
}

export class TextSubmissionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextSubmissionContractError";
  }
}

export class TextSubmissionSerializationError extends TextSubmissionContractError {
  constructor(message: string) {
    super(message);
    this.name = "TextSubmissionSerializationError";
  }
}

export function decodeTextContentSubmissionRequest(
  value: unknown,
): TextContentSubmissionRequestV1 {
  const decoded = decodeRetainedTextDraftFields(value);
  if (decoded.persona_id === undefined) {
    throw new TextSubmissionContractError(
      "Text submission request has an invalid persona id",
    );
  }
  return { ...decoded, persona_id: decoded.persona_id };
}

/** Local draft recovery only: an absent author requires a fresh explicit choice.
 * Never use this projection to replace or reconstruct persisted retry bytes.
 */
export function decodeRetainedTextDraftFields(value: unknown): Omit<
  TextContentSubmissionRequestV1,
  "persona_id"
> & {
  readonly persona_id: string | undefined;
} {
  if (!isTextSubmissionRequestObject(value)) {
    throw new TextSubmissionContractError(
      "Text submission request must be an object",
    );
  }
  const keys = Object.keys(value);
  const requiredKeys = [
    "idempotency_key",
    "post_type",
    "authorship_mode",
    "identity_mode",
    "visibility",
    "title",
    "body",
  ];
  const allowedKeys = [...requiredKeys, "persona_id", "author_declared_rating"];
  if (
    requiredKeys.some(
      (key) => !Object.prototype.hasOwnProperty.call(value, key),
    ) ||
    keys.some((key) => !allowedKeys.includes(key))
  ) {
    throw new TextSubmissionContractError(
      "Text submission request has an unexpected shape",
    );
  }
  if (
    typeof value.idempotency_key !== "string" ||
    value.idempotency_key === ""
  ) {
    throw new TextSubmissionContractError(
      "Text submission request has an invalid idempotency key",
    );
  }
  if (
    value.persona_id !== undefined &&
    (typeof value.persona_id !== "string" || value.persona_id === "")
  ) {
    throw new TextSubmissionContractError(
      "Text submission request has an invalid persona id",
    );
  }
  if (
    value.post_type !== "text" ||
    value.authorship_mode !== "human_direct" ||
    value.identity_mode !== "public" ||
    value.visibility !== "public"
  ) {
    throw new TextSubmissionContractError(
      "Text submission request has invalid fixed fields",
    );
  }
  if (
    value.author_declared_rating !== undefined &&
    value.author_declared_rating !== "general" &&
    value.author_declared_rating !== "adult_18"
  ) {
    throw new TextSubmissionContractError(
      "Text submission request has an invalid author-declared rating",
    );
  }
  if (value.title !== null && typeof value.title !== "string") {
    throw new TextSubmissionContractError(
      "Text submission request has an invalid title",
    );
  }
  if (typeof value.body !== "string" || value.body === "") {
    throw new TextSubmissionContractError(
      "Text submission request has an invalid body",
    );
  }
  return {
    idempotency_key: value.idempotency_key,
    persona_id: value.persona_id,
    post_type: "text",
    authorship_mode: "human_direct",
    identity_mode: "public",
    visibility: "public",
    author_declared_rating: value.author_declared_rating ?? "general",
    title: value.title,
    body: value.body,
  };
}

interface RawTextObject {
  readonly submission_id?: unknown;
  readonly href?: unknown;
  readonly surface?: unknown;
  readonly status?: unknown;
  readonly result?: unknown;
  readonly published_resource?: unknown;
  readonly review_ref?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  readonly kind?: unknown;
  readonly post_id?: unknown;
  readonly comment_id?: unknown;
  readonly decision?: unknown;
  readonly reason_code?: unknown;
}

function isRecord(value: unknown): value is RawTextObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TextSubmissionContractError(
      `Invalid text submission field: ${field}`,
    );
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new TextSubmissionContractError(
      `Invalid text submission field: ${field}`,
    );
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  const candidate = allowed.find((item) => item === value);
  if (candidate === undefined) {
    throw new TextSubmissionContractError(
      `Invalid text submission field: ${field}`,
    );
  }
  return candidate;
}

function decodePublishedResource(value: unknown): PublishedTextResourceV1 {
  if (!isRecord(value))
    throw new TextSubmissionContractError(
      "published_resource must be an object",
    );
  const kind = oneOf(value.kind, "published_resource.kind", [
    "post",
    "comment",
  ] as const);
  if (kind === "post") {
    return {
      kind,
      post_id: requiredString(value.post_id, "published_resource.post_id"),
      href: requiredString(value.href, "published_resource.href"),
    };
  }
  return {
    kind,
    comment_id: requiredString(
      value.comment_id,
      "published_resource.comment_id",
    ),
    href: requiredString(value.href, "published_resource.href"),
  };
}

/**
 * Decode and enforce the closed result/status cross-field invariants. A
 * successful HTTP response is not trusted until it passes this decoder.
 */
export function decodeTextContentSubmission(
  value: unknown,
): TextContentSubmissionV1 {
  if (!isRecord(value))
    throw new TextSubmissionContractError("Text submission must be an object");

  const submissionId = requiredString(value.submission_id, "submission_id");
  const href = requiredString(value.href, "href");
  const surface = oneOf(value.surface, "surface", [
    "text_post",
    "comment",
    "reply",
  ] as const);
  const status = oneOf(value.status, "status", [
    "published",
    "manual_review",
    "blocked",
  ] as const);
  const rawResult = value.result;
  if (!isRecord(rawResult))
    throw new TextSubmissionContractError("result must be an object");
  const decision = oneOf(rawResult.decision, "result.decision", [
    "allow",
    "manual_review",
    "blocked",
  ] as const);
  const rawReason = rawResult.reason_code;
  const expectedKind = surface === "text_post" ? "post" : "comment";

  const rawPublishedResource = value.published_resource;
  const publishedResource =
    rawPublishedResource === null
      ? null
      : decodePublishedResource(rawPublishedResource);
  const reviewRef = nullableString(value.review_ref, "review_ref");

  if (status === "published") {
    if (
      decision !== "allow" ||
      rawReason !== null ||
      publishedResource === null ||
      publishedResource.kind !== expectedKind ||
      reviewRef !== null
    ) {
      throw new TextSubmissionContractError(
        "Published text submission has inconsistent result fields",
      );
    }
  } else if (status === "manual_review") {
    const reasonCode = oneOf(rawReason, "result.reason_code", [
      "review_required",
      "moderation_unavailable",
    ] as const);
    if (
      decision !== "manual_review" ||
      publishedResource !== null ||
      reviewRef === null ||
      reviewRef === ""
    ) {
      throw new TextSubmissionContractError(
        "Manual-review text submission has inconsistent result fields",
      );
    }
    return {
      submission_id: submissionId,
      href,
      surface,
      status,
      result: { decision, reason_code: reasonCode },
      published_resource: null,
      review_ref: reviewRef,
      created_at: requiredString(value.created_at, "created_at"),
      updated_at: requiredString(value.updated_at, "updated_at"),
    };
  } else if (
    decision !== "blocked" ||
    rawReason !== "policy_violation" ||
    publishedResource !== null ||
    reviewRef !== null
  ) {
    throw new TextSubmissionContractError(
      "Blocked text submission has inconsistent result fields",
    );
  }

  return {
    submission_id: submissionId,
    href,
    surface,
    status,
    result:
      decision === "allow"
        ? { decision: "allow", reason_code: null }
        : { decision: "blocked", reason_code: "policy_violation" },
    published_resource: publishedResource,
    review_ref: reviewRef,
    created_at: requiredString(value.created_at, "created_at"),
    updated_at: requiredString(value.updated_at, "updated_at"),
  };
}

/** Apply the exact text normalization used by the moderation preimage. */
export function normalizeTextField(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/\r\n|\r/gu, "\n")
    .normalize("NFC")
    .trim();
}

export function normalizeTextSubmissionRequest(
  request: TextContentSubmissionRequestEnvelopeV1,
): TextContentSubmissionRequestEnvelopeV1 {
  const communityId = normalizeTextField(request.path.communityId);
  const idempotencyKey = normalizeTextField(request.body.idempotency_key);
  const personaId = normalizeTextField(request.body.persona_id);
  const body = normalizeTextField(request.body.body);
  if (communityId === null || communityId === "")
    throw new TextSubmissionContractError("Community ID is required");
  if (idempotencyKey === null || idempotencyKey === "")
    throw new TextSubmissionContractError("Idempotency key is required");
  if (personaId === null || personaId === "")
    throw new TextSubmissionContractError("Persona ID is required");
  if (body === null || body === "")
    throw new TextSubmissionContractError("Text body is required");
  return {
    path: { communityId },
    body: {
      idempotency_key: idempotencyKey,
      persona_id: personaId,
      post_type: "text",
      authorship_mode: "human_direct",
      identity_mode: "public",
      visibility: "public",
      author_declared_rating: request.body.author_declared_rating,
      title: normalizeTextField(request.body.title),
      body,
    },
  };
}

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function bytesToBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const combined = (first << 16) | (second << 8) | third;
    output += BASE64URL_ALPHABET[(combined >>> 18) & 63];
    output += BASE64URL_ALPHABET[(combined >>> 12) & 63];
    if (index + 1 < bytes.length)
      output += BASE64URL_ALPHABET[(combined >>> 6) & 63];
    if (index + 2 < bytes.length) output += BASE64URL_ALPHABET[combined & 63];
  }
  return output;
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new TextSubmissionContractError("Invalid base64url body");
  }
  const output: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64URL_ALPHABET.indexOf(value[index] ?? "");
    const b = BASE64URL_ALPHABET.indexOf(value[index + 1] ?? "");
    const c =
      value[index + 2] === undefined
        ? 0
        : BASE64URL_ALPHABET.indexOf(value[index + 2]);
    const d =
      value[index + 3] === undefined
        ? 0
        : BASE64URL_ALPHABET.indexOf(value[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0)
      throw new TextSubmissionContractError("Invalid base64url body");
    output.push((a << 2) | (b >>> 4));
    if (index + 2 < value.length) output.push(((b & 15) << 4) | (c >>> 2));
    if (index + 3 < value.length) output.push(((c & 3) << 6) | d);
  }
  return new Uint8Array(output);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined)
    throw new TextSubmissionSerializationError("SHA-256 is unavailable");
  const digest = await subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Serialize the normalized request once; retry code must reuse these bytes. */
export function serializeTextSubmissionRequest(
  request: TextContentSubmissionRequestEnvelopeV1,
): SerializedTextSubmissionRequest {
  const normalized = normalizeTextSubmissionRequest(request);
  const json = JSON.stringify(normalized.body);
  return { normalized, bytes: new TextEncoder().encode(json) };
}

export interface SerializedTextSubmissionRequest {
  readonly normalized: TextContentSubmissionRequestEnvelopeV1;
  readonly bytes: Uint8Array;
}
