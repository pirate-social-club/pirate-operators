import { recoverTypedDataAddress, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  bytes32,
  canonical,
  exact,
  hashJson,
  insist,
  integer,
  object,
  text,
} from "../community/common.ts";
import { address, httpsOrigin } from "../community/manifest-core.ts";
import {
  associationId,
  recordingId,
  verifiedPublication,
  type RecordingState,
  type VerifiedPublication,
} from "./model.ts";

/** Separate from community moderation and inbound publisher authorization. */
export const catalogStatusDomain = {
  name: "Pirate Recognition Catalog Status",
  version: "1",
} as const;
export const catalogStatusTypes = {
  CatalogStatus: [
    { name: "schema", type: "string" },
    { name: "namespace", type: "bytes32" },
    { name: "profileSha256", type: "bytes32" },
    { name: "serviceOrigin", type: "string" },
    { name: "communityId", type: "bytes32" },
    { name: "communityOrigin", type: "string" },
    { name: "configurationRevision", type: "uint64" },
    { name: "requestSha256", type: "bytes32" },
    { name: "associationId", type: "bytes32" },
    { name: "postId", type: "bytes32" },
    { name: "publicationRevision", type: "uint64" },
    { name: "publicationSha256", type: "bytes32" },
    { name: "recordingId", type: "bytes32" },
    { name: "canonicalAudioSha256", type: "bytes32" },
    { name: "state", type: "string" },
    { name: "catalogRevision", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;
export type CatalogStatusState = RecordingState | "withdrawn";
const states: readonly CatalogStatusState[] = [
  "pending",
  "upload_unknown",
  "processing",
  "verification_unknown",
  "ready",
  "failed",
  "deleting",
  "deleted",
  "withdrawn",
];
export interface CatalogStatusPayload {
  schema: "pirate.recognition-catalog-receipt/1";
  namespace: Hex;
  profileSha256: Hex;
  serviceOrigin: string;
  communityId: Hex;
  communityOrigin: string;
  configurationRevision: number;
  requestSha256: Hex;
  associationId: Hex;
  postId: Hex;
  publicationRevision: number;
  publicationSha256: Hex;
  recordingId: Hex;
  canonicalAudioSha256: Hex;
  state: CatalogStatusState;
  catalogRevision: number;
  issuedAt: number;
  expiresAt: number;
}
export interface CatalogStatusReceipt {
  payload: CatalogStatusPayload;
  signature: Hex;
}
export interface RecognitionConnection {
  namespace: string;
  profileSha256: string;
  origin: string;
  signer: string;
}
export function recognitionConnection(
  input: RecognitionConnection,
): RecognitionConnection {
  return {
    namespace: bytes32(input.namespace),
    profileSha256: bytes32(input.profileSha256),
    origin: httpsOrigin(input.origin),
    signer: address(input.signer),
  };
}
export function catalogStatusPayload(input: unknown): CatalogStatusPayload {
  const p = object(input);
  exact(
    p,
    catalogStatusTypes.CatalogStatus.map((field) => field.name),
  );
  insist(
    p.schema === "pirate.recognition-catalog-receipt/1" &&
      states.includes(p.state as CatalogStatusState),
    "recognition_status_invalid",
    503,
  );
  const payload: CatalogStatusPayload = {
    schema: "pirate.recognition-catalog-receipt/1",
    namespace: bytes32(p.namespace),
    profileSha256: bytes32(p.profileSha256),
    serviceOrigin: httpsOrigin(p.serviceOrigin),
    communityId: bytes32(p.communityId),
    communityOrigin: httpsOrigin(p.communityOrigin),
    configurationRevision: integer(p.configurationRevision, 1, 2147483647),
    requestSha256: bytes32(p.requestSha256),
    associationId: bytes32(p.associationId),
    postId: bytes32(p.postId),
    publicationRevision: integer(p.publicationRevision, 1, 2147483647),
    publicationSha256: bytes32(p.publicationSha256),
    recordingId: bytes32(p.recordingId),
    canonicalAudioSha256: bytes32(p.canonicalAudioSha256),
    state: p.state as CatalogStatusState,
    catalogRevision: integer(p.catalogRevision, 0, Number.MAX_SAFE_INTEGER),
    issuedAt: integer(p.issuedAt, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(p.expiresAt, 1, Number.MAX_SAFE_INTEGER),
  };
  insist(
    payload.expiresAt > payload.issuedAt &&
      payload.expiresAt <= payload.issuedAt + 60 &&
      payload.recordingId ===
        recordingId({
          namespace: payload.namespace,
          audioSha256: payload.canonicalAudioSha256,
        }) &&
      payload.associationId ===
        associationId({
          namespace: payload.namespace,
          communityId: payload.communityId,
          postId: payload.postId,
          publicationRevision: payload.publicationRevision,
        }),
    "recognition_status_binding_invalid",
    503,
  );
  insist(
    canonical(payload) === canonical(p),
    "recognition_status_noncanonical",
    503,
  );
  return payload;
}
const typed = (p: CatalogStatusPayload) => ({
  ...p,
  configurationRevision: BigInt(p.configurationRevision),
  publicationRevision: BigInt(p.publicationRevision),
  catalogRevision: BigInt(p.catalogRevision),
  issuedAt: BigInt(p.issuedAt),
  expiresAt: BigInt(p.expiresAt),
});
export async function signCatalogStatus(
  account: PrivateKeyAccount,
  input: CatalogStatusPayload,
): Promise<CatalogStatusReceipt> {
  const payload = catalogStatusPayload(input);
  const signature = await account.signTypedData({
    domain: catalogStatusDomain,
    types: catalogStatusTypes,
    primaryType: "CatalogStatus",
    message: typed(payload),
  });
  return { payload, signature };
}
export async function verifyCatalogStatus(
  input: unknown,
  expected: {
    connection: RecognitionConnection;
    publication: VerifiedPublication;
    communityOrigin: string;
    requestSha256: string;
    recordingId?: string;
  },
  now = () => Math.floor(Date.now() / 1000),
): Promise<CatalogStatusReceipt> {
  const receipt = object(input);
  exact(receipt, ["payload", "signature"]);
  const payload = catalogStatusPayload(receipt.payload),
    p = verifiedPublication(expected.publication),
    c = recognitionConnection(expected.connection);
  insist(
    payload.namespace === c.namespace &&
      payload.namespace === p.namespace &&
      payload.profileSha256 === c.profileSha256 &&
      payload.serviceOrigin === c.origin &&
      payload.communityId === p.communityId &&
      payload.communityOrigin === httpsOrigin(expected.communityOrigin) &&
      payload.configurationRevision === p.configurationRevision &&
      payload.postId === p.postId &&
      payload.publicationRevision === p.publicationRevision &&
      payload.publicationSha256 === hashJson(p) &&
      payload.requestSha256 === bytes32(expected.requestSha256) &&
      (expected.recordingId === undefined ||
        payload.recordingId === bytes32(expected.recordingId)),
    "recognition_status_scope_mismatch",
    403,
  );
  const fresh = () =>
    insist(
      payload.issuedAt <= now() &&
        payload.issuedAt > now() - 60 &&
        payload.expiresAt > now(),
      "recognition_status_expired",
      409,
    );
  fresh();
  const signature = text(receipt.signature, 132);
  insist(
    /^0x[0-9a-f]{130}$/.test(signature),
    "recognition_status_signature_invalid",
    403,
  );
  let signer: string;
  try {
    signer = await recoverTypedDataAddress({
      domain: catalogStatusDomain,
      types: catalogStatusTypes,
      primaryType: "CatalogStatus",
      message: typed(payload),
      signature: signature as Hex,
    });
  } catch {
    insist(false, "recognition_status_signature_invalid", 403);
  }
  insist(
    signer!.toLowerCase() === c.signer,
    "recognition_status_signature_invalid",
    403,
  );
  fresh();
  return { payload, signature: signature as Hex };
}
