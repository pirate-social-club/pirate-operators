import type { Hex } from "viem";
import {
  bytes32, canonical, exact, hashJson, insist, integer, object,
} from "../packages/community/common.ts";
import { decimal, ipfsUri } from "../packages/community/manifest-core.ts";
import type { FirstPublication } from "../packages/community/post-chain.ts";

export const nativePostsPublicationVersion = "pirate.protected-posts/1";
export const nativePostsQuotePath = "/publication/v1/posts-quote";
export const nativePostsQuoteReadyPath = "/_operator/native-publication/posts-quote-ready";
export const nativePostsDispatchPath = "/publication/v1/posts-dispatch";
export const nativePostsObservationPath = "/publication/v1/posts-observation";
export const nativePostsDispatchReadyPath = "/_operator/native-publication/posts-dispatch-ready";
export const nativePostsCatalogReservationPath = "/publication/v1/posts-catalog-reservation";
export const nativePostsCatalogResponsePath = "/publication/v1/posts-catalog-respond";

export interface NativePostsPublicationReference {
  schema: "pirate.native-posts-publication-reference/1";
  installationId: Hex;
  releaseSha256: Hex;
  jobId: string;
  operationId: Hex;
  requestHash: Hex;
}

interface PreparePins {
  quoteSha256: Hex;
  initiatingLeaseSha256: Hex;
}

export interface NativePostsDispatchRequest extends PreparePins {
  reference: Readonly<NativePostsPublicationReference>;
}

export interface NativePostsQuote extends PreparePins {
  maximumFeeWei: string;
  expiresAtMs: number;
}

export interface NativePostsDispatchProof extends NativePostsQuote {
  calldata: Hex;
}

export interface NativePostsQuoteProof {
  version: "pirate.native-posts-quote-proof/1";
  applicationOriginalSha256: Hex;
  configurationSha256: Hex;
  grantSha256: Hex;
  initiatingLeaseSha256: Hex;
  expiresAtMs: number;
  publication: Readonly<FirstPublication & { configurationRevision: 1 }>;
}

interface CanonicalPosting {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: string;
  actualFeeWei: string;
}

export type NativePostsPublicationStatus =
  | { state: "no_attempt" | "held" }
  | { state: "retained_unsent" | "attempt_unknown"; transactionHash: Hex }
  | (CanonicalPosting & { state: "confirmed"; postId: Hex; revision: 1 })
  | (CanonicalPosting & { state: "reverted" });

const pinFields = ["quoteSha256", "initiatingLeaseSha256"] as const;
const quoteFields = [...pinFields, "maximumFeeWei", "expiresAtMs"] as const;
const canonicalFields = ["state", "transactionHash", "blockHash", "blockNumber", "actualFeeWei"] as const;

function digest(value: unknown) {
  const checked = bytes32(value);
  insist(checked.length === 66, "native_posts_digest_invalid");
  return checked;
}

function readReference(value: unknown): NativePostsPublicationReference {
  const row = object(value);
  exact(row, ["schema", "installationId", "releaseSha256", "jobId", "operationId", "requestHash"]);
  const jobId = row.jobId;
  const operationId = digest(row.operationId);
  insist(row.schema === "pirate.native-posts-publication-reference/1" && typeof jobId === "string" &&
    /^publication:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/.test(jobId) &&
    operationId === hashJson({ job: jobId, step: "publication" }), "native_posts_original_changed");
  return {
    schema: row.schema, installationId: digest(row.installationId), releaseSha256: digest(row.releaseSha256),
    jobId, operationId, requestHash: digest(row.requestHash),
  };
}

function canonicalObject(raw: string) {
  const row = object(JSON.parse(raw));
  insist(raw === canonical(row), "native_posts_wire_invalid");
  return row;
}

export function readNativePostsPublicationReference(raw: string) {
  return Object.freeze(readReference(canonicalObject(raw)));
}

export function readNativePostsDispatchRequest(raw: string): Readonly<NativePostsDispatchRequest> {
  const row = canonicalObject(raw);
  exact(row, ["reference", ...pinFields]);
  return Object.freeze({
    reference: Object.freeze(readReference(row.reference)),
    quoteSha256: digest(row.quoteSha256),
    initiatingLeaseSha256: digest(row.initiatingLeaseSha256),
  });
}

/** Use only after the mounted transport authenticates the responder and installed scope. */
function readResult(raw: string, reference: Readonly<NativePostsPublicationReference>) {
  const row = canonicalObject(raw);
  exact(row, ["reference", "result"]);
  insist(row.reference === hashJson(reference), "native_posts_reply_changed", 503);
  return object(row.result);
}

function readQuote(row: Record<string, unknown>): NativePostsQuote {
  const maximumFeeWei = decimal(row.maximumFeeWei);
  insist(maximumFeeWei !== "0", "native_posts_fee_invalid");
  return {
    quoteSha256: digest(row.quoteSha256),
    initiatingLeaseSha256: digest(row.initiatingLeaseSha256),
    maximumFeeWei,
    expiresAtMs: integer(row.expiresAtMs, 1, Number.MAX_SAFE_INTEGER),
  };
}

export function readNativePostsQuote(raw: string, reference: Readonly<NativePostsPublicationReference>) {
  const row = readResult(raw, reference);
  exact(row, quoteFields);
  return Object.freeze(readQuote(row));
}

export function readNativePostsQuoteProof(
  raw: string,
  reference: Readonly<NativePostsPublicationReference>,
): Readonly<NativePostsQuoteProof> {
  const row = readResult(raw, reference);
  exact(row, ["version", "applicationOriginalSha256", "configurationSha256", "grantSha256",
    "initiatingLeaseSha256", "expiresAtMs", "publication"]);
  insist(row.version === "pirate.native-posts-quote-proof/1", "native_posts_quote_proof_invalid", 503);
  const post = object(row.publication);
  exact(post, ["communityId", "postId", "authorId", "configurationRevision", "manifestSha256", "manifestURI"]);
  insist(post.configurationRevision === 1, "native_posts_revision_changed", 503);
  const expiresAtMs = integer(row.expiresAtMs, 1, Number.MAX_SAFE_INTEGER);
  insist(Date.now() < expiresAtMs, "native_posts_quote_proof_expired", 403);
  return Object.freeze({
    version: row.version,
    applicationOriginalSha256: digest(row.applicationOriginalSha256),
    configurationSha256: digest(row.configurationSha256),
    grantSha256: digest(row.grantSha256),
    initiatingLeaseSha256: digest(row.initiatingLeaseSha256),
    expiresAtMs,
    publication: Object.freeze({
      communityId: digest(post.communityId), postId: digest(post.postId), authorId: digest(post.authorId),
      configurationRevision: post.configurationRevision, manifestSha256: digest(post.manifestSha256),
      manifestURI: ipfsUri(post.manifestURI),
    }),
  });
}

function assertPins(row: Record<string, unknown>, request: NativePostsDispatchRequest) {
  insist(row.quoteSha256 === request.quoteSha256 && row.initiatingLeaseSha256 === request.initiatingLeaseSha256,
    "native_posts_execute_pins_changed", 503);
}

function readStatus(row: Record<string, unknown>, extraFields: readonly string[]): NativePostsPublicationStatus {
  const state = row.state;
  if (state === "no_attempt" || state === "held") {
    exact(row, [...extraFields, "state"]);
    return { state };
  }
  if (state === "retained_unsent" || state === "attempt_unknown") {
    exact(row, [...extraFields, "state", "transactionHash"]);
    return { state, transactionHash: digest(row.transactionHash) };
  }
  insist(state === "confirmed" || state === "reverted", "native_posts_status_invalid", 503);
  const fields = [...extraFields, ...canonicalFields];
  exact(row, state === "confirmed" ? [...fields, "postId", "revision"] : fields);
  const receipt = {
    transactionHash: digest(row.transactionHash),
    blockHash: digest(row.blockHash),
    blockNumber: decimal(row.blockNumber),
    actualFeeWei: decimal(row.actualFeeWei),
  };
  if (state === "reverted") return { ...receipt, state };
  insist(row.revision === 1, "native_posts_revision_changed", 503);
  return { ...receipt, state, postId: digest(row.postId), revision: 1 };
}

export function readNativePostsPublicationStatus(raw: string, reference: Readonly<NativePostsPublicationReference>) {
  return readStatus(readResult(raw, reference), []);
}

export function readNativePostsDispatchStatus(raw: string, request: NativePostsDispatchRequest) {
  const row = readResult(raw, request.reference);
  assertPins(row, request);
  return readStatus(row, pinFields);
}

export function assertNativePostsDispatchProofCurrent(expiresAtMs: number) {
  insist(Number.isSafeInteger(expiresAtMs) && Date.now() < expiresAtMs, "native_posts_dispatch_proof_expired", 403);
}

export function readNativePostsDispatchProof(raw: string, request: NativePostsDispatchRequest): Readonly<NativePostsDispatchProof> {
  const row = readResult(raw, request.reference);
  exact(row, [...quoteFields, "calldata"]);
  assertPins(row, request);
  const proof = readQuote(row);
  const calldata = row.calldata;
  // The retained quote fixes these bytes. The sender also reconstructs the exact call.
  insist(typeof calldata === "string" && /^0x2307eea1(?:[0-9a-f]{2})+(?![\s\S])/.test(calldata),
    "native_posts_dispatch_proof_invalid", 503);
  assertNativePostsDispatchProofCurrent(proof.expiresAtMs);
  return Object.freeze({ ...proof, calldata: calldata as Hex });
}

export function nativePostsPublicationResponse(
  reference: Readonly<NativePostsPublicationReference>,
  result: NativePostsQuote | NativePostsQuoteProof | NativePostsDispatchProof | NativePostsPublicationStatus |
    (NativePostsPublicationStatus & PreparePins),
) {
  const row = object(result);
  const raw = canonical({ reference: hashJson(reference), result });
  if ("state" in result) {
    if ("quoteSha256" in result) {
      digest(result.quoteSha256);
      digest(result.initiatingLeaseSha256);
      readStatus(row, pinFields);
    } else {
      readStatus(row, []);
    }
  } else if ("version" in result) {
    readNativePostsQuoteProof(raw, reference);
  } else if ("calldata" in result) {
    readNativePostsDispatchProof(raw, {
      reference, quoteSha256: digest(result.quoteSha256), initiatingLeaseSha256: digest(result.initiatingLeaseSha256),
    });
  } else {
    exact(row, quoteFields);
    readQuote(row);
  }
  return new Response(raw, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
