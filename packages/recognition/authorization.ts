import { recoverTypedDataAddress, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { address, httpsOrigin } from "../community/manifest-core.ts";
import {
  bytes32,
  exact,
  hashJson,
  insist,
  integer,
  object,
  text,
} from "../community/common.ts";

export const recognitionDomain = {
  name: "Pirate Recognition",
  version: "1",
} as const;
export const recognitionRequestTypes = {
  RecognitionRequest: [
    { name: "namespace", type: "bytes32" },
    { name: "profileSha256", type: "bytes32" },
    { name: "action", type: "string" },
    { name: "communityId", type: "bytes32" },
    { name: "communityOrigin", type: "string" },
    { name: "serviceOrigin", type: "string" },
    { name: "configurationRevision", type: "uint64" },
    { name: "publisher", type: "address" },
    { name: "bodySha256", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;
export type RecognitionAction =
  | "catalog_enroll"
  | "catalog_status"
  | "catalog_withdraw"
  | "intent_reserve" | "intent_status" | "intent_bind" | "intent_commit" | "intent_cancel";
export interface RecognitionAuthorization {
  namespace: Hex;
  profileSha256: Hex;
  action: RecognitionAction;
  communityId: Hex;
  communityOrigin: string;
  serviceOrigin: string;
  configurationRevision: number;
  publisher: Hex;
  bodySha256: Hex;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
}
/** Loaded from Pirate's service profile and fresh verified community authority. */
export interface RecognitionAuthority {
  namespace: string;
  profileSha256: string;
  communityId: string;
  communityOrigin: string;
  publisher: string;
  configurationRevision: number;
  enabled: boolean;
}
/** Copy validated authority so a reused mutable loader object cannot change the
 * request's captured authority during a later asynchronous read. */
export function recognitionAuthority(input: unknown): RecognitionAuthority {
  const a = object(input);
  exact(a, [
    "namespace",
    "profileSha256",
    "communityId",
    "communityOrigin",
    "publisher",
    "configurationRevision",
    "enabled",
  ]);
  insist(typeof a.enabled === "boolean", "recognition_authority_invalid", 503);
  return Object.freeze({
    namespace: bytes32(a.namespace),
    profileSha256: bytes32(a.profileSha256),
    communityId: bytes32(a.communityId),
    communityOrigin: httpsOrigin(a.communityOrigin),
    publisher: address(a.publisher),
    configurationRevision: integer(a.configurationRevision, 1, 2147483647),
    enabled: a.enabled,
  });
}
const typed = (a: RecognitionAuthorization) => ({
  ...a,
  configurationRevision: BigInt(a.configurationRevision),
  issuedAt: BigInt(a.issuedAt),
  expiresAt: BigInt(a.expiresAt),
});
export async function signRecognitionRequest(
  account: PrivateKeyAccount,
  input: Omit<RecognitionAuthorization, "publisher" | "bodySha256">,
  body: Record<string, unknown>,
) {
  const authorization: RecognitionAuthorization = {
    ...input,
    publisher: account.address.toLowerCase() as Hex,
    bodySha256: hashJson(body),
  };
  const signature = await account.signTypedData({
    domain: recognitionDomain,
    types: recognitionRequestTypes,
    primaryType: "RecognitionRequest",
    message: typed(authorization),
  });
  return { authorization, body, signature };
}
export async function authorizeRecognitionRequest(
  db: D1DatabaseSession,
  input: unknown,
  action: RecognitionAction,
  namespace: string,
  profileSha256: string,
  serviceOrigin: string,
  loadAuthority: (communityId: string) => Promise<RecognitionAuthority | null>,
  now = () => Math.floor(Date.now() / 1000),
) {
  const v = object(input);
  exact(v, ["authorization", "body", "signature"]);
  const a = object(v.authorization);
  exact(
    a,
    recognitionRequestTypes.RecognitionRequest.map((f) => f.name),
  );
  insist(
    a.action === action &&
      a.namespace === namespace &&
      a.profileSha256 === profileSha256 &&
      a.serviceOrigin === serviceOrigin,
    "recognition_request_scope_mismatch",
    403,
  );
  const auth: RecognitionAuthorization = {
    namespace: bytes32(a.namespace),
    profileSha256: bytes32(a.profileSha256),
    action,
    communityId: bytes32(a.communityId),
    communityOrigin: httpsOrigin(a.communityOrigin),
    serviceOrigin: httpsOrigin(a.serviceOrigin),
    configurationRevision: integer(a.configurationRevision, 1, 2147483647),
    publisher: address(a.publisher),
    bodySha256: bytes32(a.bodySha256),
    nonce: bytes32(a.nonce),
    issuedAt: integer(a.issuedAt, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(a.expiresAt, 1, Number.MAX_SAFE_INTEGER),
  };
  const body = object(v.body),
    signature = text(v.signature, 132),
    start = now();
  insist(
    hashJson(body) === auth.bodySha256 && /^0x[0-9a-f]{130}$/.test(signature),
    "recognition_request_invalid",
    403,
  );
  insist(
    auth.issuedAt <= start &&
      auth.issuedAt >= start - 300 &&
      auth.expiresAt > start &&
      auth.expiresAt <= auth.issuedAt + 300,
    "recognition_request_expired",
    403,
  );
  const recovered = await recoverTypedDataAddress({
    domain: recognitionDomain,
    types: recognitionRequestTypes,
    primaryType: "RecognitionRequest",
    message: typed(auth),
    signature: signature as Hex,
  });
  insist(
    recovered.toLowerCase() === auth.publisher,
    "recognition_signature_invalid",
    403,
  );
  const loaded = await loadAuthority(auth.communityId),
    current = loaded ? recognitionAuthority(loaded) : null;
  insist(
    current?.enabled &&
      current.namespace === namespace &&
      current.profileSha256 === profileSha256 &&
      current.communityId === auth.communityId &&
      current.communityOrigin === auth.communityOrigin &&
      current.publisher === auth.publisher &&
      current.configurationRevision === auth.configurationRevision,
    "recognition_pairing_changed",
    403,
  );
  insist(auth.expiresAt > now(), "recognition_request_expired", 403);
  const wireHash = hashJson(v);
  await db
    .prepare(
      `INSERT INTO shared_recognition_request_nonces(namespace,community_id,nonce,wire_hash,expires_at)
    VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`,
    )
    .bind(namespace, auth.communityId, auth.nonce, wireHash, auth.expiresAt)
    .run();
  const saved = await db
    .prepare(
      `SELECT wire_hash FROM shared_recognition_request_nonces
    WHERE namespace=? AND community_id=? AND nonce=?`,
    )
    .bind(namespace, auth.communityId, auth.nonce)
    .first<{ wire_hash: string }>();
  insist(saved?.wire_hash === wireHash, "recognition_nonce_reused", 409);
  insist(auth.expiresAt > now(), "recognition_request_expired", 403);
  return { authorization: auth, body, authority: current };
}
