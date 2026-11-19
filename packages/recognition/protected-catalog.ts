import { recoverTypedDataAddress, sha256, type Address, type Hex } from "viem";
import { CommunityError, bytes32, canonical, exact, hashJson, insist, integer, object } from "../community/common.ts";
import { address, decimal } from "../community/manifest-core.ts";
import { publicationData, type FirstPublication } from "../community/post-chain.ts";
import { acceptedIntent, recognitionProfile, reservationId, type AcceptedIntent, type RecognitionProfile } from "./intent.ts";
import { verifiedPublication, type VerifiedPublication } from "./model.ts";
import { reservationReceipt, verifyReservation, type ReservationReceipt } from "./reservation-receipt.ts";
import { readNativePostsPublicationReference, type NativePostsPublicationReference, type NativePostsQuote } from "../../services/native-posts-publication.ts";

export const protectedCatalogPostingSchema = "pirate.protected-posts-catalog-posting/1";
const originalSchema = "pirate.protected-posts-catalog-original/1";
const canonicalSchema = "pirate.protected-posts-catalog-canonical/1";
const retainedSchema = "pirate.protected-posts-catalog-retained/1";
const domain = { name: "Pirate Protected Posts Catalog", version: "1" } as const;
const types = { Original: [{ name: "payloadSha256", type: "bytes32" }],
  Canonical: [{ name: "payloadSha256", type: "bytes32" }] } as const;

export interface ProtectedCatalogPosting {
  schema: typeof protectedCatalogPostingSchema;
  operationId: Hex;
  requestHash: Hex;
  transactionHash: Hex;
  originalSha256: Hex;
}
export interface ProtectedCatalogOriginal {
  schema: typeof originalSchema;
  reference: Readonly<NativePostsPublicationReference>;
  applicationOriginalSha256: Hex;
  grantSha256: Hex;
  intentSha256: Hex;
  reservationId: Hex;
  quoteSha256: Hex;
  initiatingLeaseSha256: Hex;
  maximumFeeWei: string;
  calldataSha256: Hex;
  transactionHash: Hex;
  retainedOriginalSha256: Hex;
  readyRequestSha256: Hex;
  readyReceiptSha256: Hex;
  recordingId: Hex;
  bindExpiresAtMs: number;
}
export interface ProtectedCatalogCanonicalFacts {
  state: "confirmed";
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: string;
  actualFeeWei: string;
  postId: Hex;
  revision: 1;
}
export interface ProtectedCatalogCanonical extends ProtectedCatalogCanonicalFacts {
  schema: typeof canonicalSchema;
  postingSha256: Hex;
}
interface Signed<T> { payload: T; signature: Hex }
export interface ProtectedCatalogRetained {
  schema: typeof retainedSchema;
  posting: ProtectedCatalogPosting;
  original: Signed<ProtectedCatalogOriginal>;
  readyReceipt: Signed<ReservationReceipt>;
}
export interface ProtectedCatalogPromotion {
  schema: "pirate.protected-posts-catalog-promotion/1";
  publication: VerifiedPublication;
  proof: Signed<ProtectedCatalogCanonical>;
}
/** The receiver obtains these pins from the installed, independently admitted original. */
export interface ProtectedCatalogSelection {
  reference: NativePostsPublicationReference;
  applicationOriginalSha256: Hex;
  grantSha256: Hex;
  retainedCustodySha256: Hex;
  quote: NativePostsQuote;
  publisher: Address;
  postsContract: Address;
  proofSigner: Address;
  publication: FirstPublication;
  recognition: RecognitionProfile;
  /** Independently authenticate safe chain, Posts/manifest and complete fee evidence. */
  readCanonical(hash: Hex): Promise<ProtectedCatalogCanonicalFacts | { state: "unavailable" | "reverted" }>;
}

const digest = (value: unknown) => {
  insist(typeof value === "string" && /^0x[0-9a-f]{64}(?![\s\S])/.test(value) && !/^0x0+$/.test(value),
    "protected_catalog_digest_invalid");
  return bytes32(value);
};
const signature = (value: unknown): Hex => {
  insist(typeof value === "string" && /^0x[0-9a-f]{130}(?![\s\S])/.test(value),
    "protected_catalog_signature_invalid", 403);
  return value as Hex;
};
async function authenticate(kind: "Original" | "Canonical", proof: Signed<object>, expected: Address) {
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({ domain, types, primaryType: kind,
      message: { payloadSha256: hashJson(proof.payload) }, signature: proof.signature });
  } catch { insist(false, "protected_catalog_proof_unauthenticated", 403); }
  insist(recovered.toLowerCase() === expected, "protected_catalog_proof_unauthenticated", 403);
}
function readPosting(value: unknown): ProtectedCatalogPosting {
  const r = object(value);
  exact(r, ["schema", "operationId", "requestHash", "transactionHash", "originalSha256"]);
  insist(r.schema === protectedCatalogPostingSchema, "protected_catalog_posting_invalid", 409);
  return { schema: protectedCatalogPostingSchema, operationId: digest(r.operationId), requestHash: digest(r.requestHash),
    transactionHash: digest(r.transactionHash), originalSha256: digest(r.originalSha256) };
}
function reference(value: unknown) {
  try { return readNativePostsPublicationReference(canonical(value)); }
  catch { throw new CommunityError("protected_catalog_original_mismatch",409); }
}
function originalProof(value: unknown): Signed<ProtectedCatalogOriginal> {
  const signed = object(value), p = object(signed.payload);
  exact(signed, ["payload", "signature"]);
  exact(p, ["schema", "reference", "applicationOriginalSha256", "grantSha256", "intentSha256", "reservationId", "quoteSha256",
    "initiatingLeaseSha256", "maximumFeeWei", "calldataSha256", "transactionHash", "retainedOriginalSha256", "readyRequestSha256",
    "readyReceiptSha256", "recordingId", "bindExpiresAtMs"]);
  insist(p.schema === originalSchema, "protected_catalog_original_mismatch", 409);
  const payload: ProtectedCatalogOriginal = {
    schema: originalSchema, reference: reference(p.reference),
    applicationOriginalSha256: digest(p.applicationOriginalSha256), grantSha256: digest(p.grantSha256),
    intentSha256: digest(p.intentSha256), reservationId: digest(p.reservationId), quoteSha256: digest(p.quoteSha256),
    initiatingLeaseSha256: digest(p.initiatingLeaseSha256), maximumFeeWei: decimal(p.maximumFeeWei),
    calldataSha256: digest(p.calldataSha256), transactionHash: digest(p.transactionHash),
    retainedOriginalSha256: digest(p.retainedOriginalSha256), readyRequestSha256: digest(p.readyRequestSha256),
    readyReceiptSha256: digest(p.readyReceiptSha256), recordingId: digest(p.recordingId),
    bindExpiresAtMs: integer(p.bindExpiresAtMs, 1, Number.MAX_SAFE_INTEGER),
  };
  insist(canonical(payload) === canonical(p), "protected_catalog_original_mismatch", 409);
  return { payload, signature: signature(signed.signature) };
}
function canonicalProof(value: unknown): Signed<ProtectedCatalogCanonical> {
  const signed = object(value), p = object(signed.payload);
  exact(signed, ["payload", "signature"]);
  exact(p, ["schema", "postingSha256", "state", "transactionHash", "blockHash", "blockNumber", "actualFeeWei", "postId", "revision"]);
  insist(p.schema === canonicalSchema && p.state === "confirmed" && p.revision === 1,
    "protected_catalog_canonical_mismatch", 409);
  return { payload: { schema: canonicalSchema, state: p.state, revision: p.revision,
    postingSha256: digest(p.postingSha256), transactionHash: digest(p.transactionHash), blockHash: digest(p.blockHash),
    blockNumber: decimal(p.blockNumber), actualFeeWei: decimal(p.actualFeeWei), postId: digest(p.postId) },
    signature: signature(signed.signature) };
}
function receipt(value: unknown): Signed<ReservationReceipt> {
  const r = object(value);
  exact(r, ["payload", "signature"]);
  const verifiedShape = { payload: reservationReceipt(r.payload), signature: signature(r.signature) };
  insist(canonical(r) === canonical(verifiedShape), "protected_catalog_ready_mismatch", 409);
  return verifiedShape;
}
export function readProtectedCatalogRetained(value: unknown): ProtectedCatalogRetained | null {
  const row = object(value);
  if (row.schema !== retainedSchema) return null;
  exact(row, ["schema", "posting", "original", "readyReceipt"]);
  const parsed: ProtectedCatalogRetained = { schema: retainedSchema, posting: readPosting(row.posting),
    original: originalProof(row.original), readyReceipt: receipt(row.readyReceipt) };
  insist(canonical(parsed) === canonical(row), "protected_catalog_retained_mismatch", 409);
  return parsed;
}

export function readProtectedCatalogPromotion(value: unknown): ProtectedCatalogPromotion | null {
  const row=object(value);
  if (row.schema!=="pirate.protected-posts-catalog-promotion/1") return null;
  exact(row,["schema","publication","proof"]);
  const parsed={schema:row.schema,publication:verifiedPublication(row.publication),proof:canonicalProof(row.proof)} as const;
  insist(canonical(parsed)===canonical(row),"protected_catalog_canonical_mismatch",409);
  return parsed;
}

export async function verifyProtectedCatalogOriginal(input: { posting: unknown; original: unknown; readyReceipt: unknown },
  selected: ProtectedCatalogSelection, intent: AcceptedIntent, nowMs: number, firstBind: boolean) {
  const candidate = structuredClone(input), p = acceptedIntent(intent), profile = recognitionProfile(selected.recognition),
    posting = readPosting(candidate.posting), original = originalProof(candidate.original), r = original.payload,
    ready = receipt(candidate.readyReceipt), expectedReference = reference(selected.reference),
    signer = address(selected.proofSigner), publisher = address(selected.publisher), postsContract = address(selected.postsContract),
    calldata = sha256(publicationData(selected.publication)), quote = structuredClone(selected.quote);
  insist(signer !== publisher && signer !== profile.signer && profile.namespace === p.namespace && profile.sha256 === p.profileSha256,
    "protected_catalog_proof_authority_invalid", 403);
  const retained = hashJson({ schema: "pirate.protected-posts-retained-original/1", retainedCustodySha256: digest(selected.retainedCustodySha256),
    reference: expectedReference, quoteSha256: quote.quoteSha256, initiatingLeaseSha256: quote.initiatingLeaseSha256,
    publisher, postsContract, calldataSha256: calldata, transactionHash: posting.transactionHash });
  insist(canonical(r.reference) === canonical(expectedReference) && r.reference.jobId === p.jobId &&
    r.reference.operationId === hashJson({ job: p.jobId, step: "publication" }) && posting.operationId === r.reference.operationId &&
    posting.requestHash === r.reference.requestHash && posting.transactionHash === r.transactionHash &&
    posting.originalSha256 === hashJson(r) && r.applicationOriginalSha256 === selected.applicationOriginalSha256 &&
    r.grantSha256 === selected.grantSha256 && r.intentSha256 === hashJson(p) && r.reservationId === reservationId(p) &&
    r.quoteSha256 === quote.quoteSha256 && r.initiatingLeaseSha256 === quote.initiatingLeaseSha256 &&
    r.maximumFeeWei === quote.maximumFeeWei && BigInt(r.maximumFeeWei) > 0n && r.calldataSha256 === calldata &&
    r.retainedOriginalSha256 === retained && r.readyReceiptSha256 === hashJson(ready) &&
    r.bindExpiresAtMs <= quote.expiresAtMs && r.bindExpiresAtMs <= ready.payload.expiresAt * 1000 &&
    r.bindExpiresAtMs > ready.payload.issuedAt * 1000 && ready.payload.issuedAt <= Math.floor(nowMs / 1000) &&
    selected.publication.communityId === p.communityId && selected.publication.postId === p.postId &&
    selected.publication.configurationRevision === p.configurationRevision && p.publicationRevision === 1,
    "protected_catalog_original_mismatch", 409);
  if (firstBind) insist(nowMs < r.bindExpiresAtMs, "protected_catalog_bind_expired", 409);
  await authenticate("Original", original, signer);
  await verifyReservation(ready, profile, { purpose: "accepted_intent", state: "ready", recordingState: "ready",
    recordingId: r.recordingId, requestSha256: r.readyRequestSha256, intentSha256: r.intentSha256, reservationId: r.reservationId,
    communityId: p.communityId, configurationRevision: p.configurationRevision, postingSha256: null, publicationSha256: null },
    firstBind ? Math.floor(nowMs / 1000) : ready.payload.issuedAt);
  return { schema: retainedSchema, posting, original, readyReceipt: ready } satisfies ProtectedCatalogRetained;
}
export async function verifyProtectedCatalogCanonical(input: unknown, bound: ProtectedCatalogRetained,
  selected: ProtectedCatalogSelection, p: AcceptedIntent) {
  const proof = canonicalProof(structuredClone(input)), value = proof.payload;
  insist(value.postingSha256 === hashJson(bound.posting) && value.transactionHash === bound.posting.transactionHash &&
    value.postId === p.postId && BigInt(value.actualFeeWei) > 0n && BigInt(value.actualFeeWei) <= BigInt(bound.original.payload.maximumFeeWei),
    "protected_catalog_canonical_mismatch", 409);
  await authenticate("Canonical", proof, address(selected.proofSigner));
  const read = await selected.readCanonical(bound.posting.transactionHash);
  const { schema: _schema, postingSha256: _postingSha256, ...facts } = value;
  insist(read.state === "confirmed" && canonical(read) === canonical(facts), "protected_catalog_canonical_mismatch", 409);
  return { proof, publication: verifiedPublication({
    namespace: p.namespace, communityId: p.communityId, postId: p.postId, publicationRevision: p.publicationRevision,
    configurationRevision: p.configurationRevision, creatorKey: p.creatorKey, audioSha256: p.audioSha256, audioBytes: p.audioBytes,
    audioObjectKey: p.audioObjectKey, audioRevision: p.audioRevision, termsRevision: p.termsRevision, termsSha256: p.termsSha256,
    allowsDerivatives: p.allowsDerivatives, publicationEvidenceSha256: hashJson(value),
  }) };
}
