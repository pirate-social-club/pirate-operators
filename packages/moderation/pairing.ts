import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  bytes32,
  exact,
  hashJson,
  insist,
  integer,
  object,
  text,
} from "../community/common.ts";
import { address, httpsOrigin } from "../community/manifest-core.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { evidenceDomain } from "./evidence.ts";

export interface ManagedPairing {
  communityId: Hex;
  registry: Address;
  directory: Address;
  controller: Address;
  communityOrigin: string;
  serviceOrigin: string;
  enabled: boolean;
  budgetPeriod: string;
  requestCap: number;
}
export interface ServiceAuthorization {
  action:
    | "admit"
    | "status"
    | "resume"
    | "release_pin"
    | "release_register"
    | "release_pin_status"
    | "release_register_status";
  communityId: Hex;
  communityOrigin: string;
  serviceOrigin: string;
  configurationRevision: number;
  publisher: Address;
  requestSha256: Hex;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
}
export interface SignedServiceRequest {
  authorization: ServiceAuthorization;
  body: Record<string, unknown>;
  signature: Hex;
}
export const serviceRequestTypes = {
  ServiceRequest: [
    { name: "action", type: "string" },
    { name: "communityId", type: "string" },
    { name: "communityOrigin", type: "string" },
    { name: "serviceOrigin", type: "string" },
    { name: "configurationRevision", type: "uint64" },
    { name: "publisher", type: "address" },
    { name: "requestSha256", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;
const message = (a: ServiceAuthorization) => ({
  ...a,
  configurationRevision: BigInt(a.configurationRevision),
  issuedAt: BigInt(a.issuedAt),
  expiresAt: BigInt(a.expiresAt),
});
export function managedPairings(value: unknown): ManagedPairing[] {
  insist(
    Array.isArray(value) && value.length <= 100,
    "invalid_managed_pairings",
    503,
  );
  const values = value.map((input) => {
    const p = object(input);
    exact(p, [
      "communityId",
      "registry",
      "directory",
      "controller",
      "communityOrigin",
      "serviceOrigin",
      "enabled",
      "budgetPeriod",
      "requestCap",
    ]);
    insist(typeof p.enabled === "boolean", "invalid_managed_pairing", 503);
    const budgetPeriod = text(p.budgetPeriod, 64);
    insist(
      /^[a-z0-9][a-z0-9_-]{1,63}$/.test(budgetPeriod),
      "invalid_budget_period",
      503,
    );
    return {
      communityId: bytes32(p.communityId),
      registry: address(p.registry),
      directory: address(p.directory),
      controller: address(p.controller),
      communityOrigin: httpsOrigin(p.communityOrigin),
      serviceOrigin: httpsOrigin(p.serviceOrigin),
      enabled: p.enabled,
      budgetPeriod,
      requestCap: integer(p.requestCap, 1, 100),
    };
  });
  insist(
    new Set(values.map((p) => p.communityId)).size === values.length,
    "duplicate_managed_pairing",
    503,
  );
  return values;
}
export async function signServiceRequest(
  account: PrivateKeyAccount,
  authorization: Omit<ServiceAuthorization, "publisher" | "requestSha256">,
  body: Record<string, unknown>,
): Promise<SignedServiceRequest> {
  const a = {
    ...authorization,
    publisher: account.address.toLowerCase() as Address,
    requestSha256: hashJson(body),
  };
  return {
    authorization: a,
    body,
    signature: await account.signTypedData({
      domain: evidenceDomain,
      types: serviceRequestTypes,
      primaryType: "ServiceRequest",
      message: message(a),
    }),
  };
}
export async function authorizeServiceRequest(
  db: D1Database,
  input: unknown,
  action: ServiceAuthorization["action"],
  serviceOrigin: string,
  pairings: ManagedPairing[],
  currentConfiguration: (pairing: ManagedPairing) => Promise<CommunityConfig>,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const value = object(input);
  exact(value, ["authorization", "body", "signature"]);
  const a = object(value.authorization);
  exact(
    a,
    serviceRequestTypes.ServiceRequest.map((f) => f.name),
  );
  insist(
    a.action === action && a.serviceOrigin === serviceOrigin,
    "wrong_service_request_scope",
    403,
  );
  const authorization: ServiceAuthorization = {
    action,
    communityId: bytes32(a.communityId),
    communityOrigin: httpsOrigin(a.communityOrigin),
    serviceOrigin: httpsOrigin(a.serviceOrigin),
    configurationRevision: integer(
      a.configurationRevision,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    publisher: address(a.publisher),
    requestSha256: bytes32(a.requestSha256),
    nonce: bytes32(a.nonce),
    issuedAt: integer(a.issuedAt, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(a.expiresAt, 1, Number.MAX_SAFE_INTEGER),
  };
  const pairing = pairings.find(
    (p) => p.communityId === authorization.communityId,
  );
  insist(
    pairing?.enabled &&
      pairing.communityOrigin === authorization.communityOrigin &&
      pairing.serviceOrigin === serviceOrigin,
    "managed_pairing_unavailable",
    403,
  );
  insist(
    authorization.issuedAt <= nowSeconds &&
      authorization.issuedAt >= nowSeconds - 300 &&
      authorization.expiresAt > nowSeconds &&
      authorization.expiresAt <= authorization.issuedAt + 300,
    "expired_service_request",
    403,
  );
  const body = object(value.body);
  insist(
    hashJson(body) === authorization.requestSha256,
    "service_request_hash_mismatch",
    403,
  );
  insist(
    typeof value.signature === "string" &&
      /^0x[0-9a-f]{130}$/.test(value.signature),
    "invalid_service_signature",
    403,
  );
  const recovered = await recoverTypedDataAddress({
    domain: evidenceDomain,
    types: serviceRequestTypes,
    primaryType: "ServiceRequest",
    message: message(authorization),
    signature: value.signature as Hex,
  });
  insist(
    recovered.toLowerCase() === authorization.publisher,
    "invalid_service_signature",
    403,
  );
  const current = await currentConfiguration(pairing);
  insist(
    current.chainId === 6343 &&
      current.communityId === pairing.communityId &&
      current.registry === pairing.registry &&
      current.directory === pairing.directory &&
      current.controller === pairing.controller &&
      current.app.origin === pairing.communityOrigin &&
      current.publisher === authorization.publisher &&
      current.configurationRevision === authorization.configurationRevision,
    "community_authority_changed",
    403,
  );
  // Recheck wall-clock expiry after the asynchronous canonical-chain read.
  const acceptedAt = Math.max(nowSeconds, Math.floor(Date.now() / 1000));
  insist(authorization.expiresAt > acceptedAt, "expired_service_request", 403);
  const wireHash = hashJson({
    authorization,
    body,
    signature: value.signature,
  });
  await db
    .prepare(
      `INSERT INTO moderation_request_nonces(community_id,nonce,wire_hash,expires_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING`,
    )
    .bind(
      pairing.communityId,
      authorization.nonce,
      wireHash,
      authorization.expiresAt,
    )
    .run();
  const nonce = await db
    .prepare(
      "SELECT wire_hash FROM moderation_request_nonces WHERE community_id=? AND nonce=?",
    )
    .bind(pairing.communityId, authorization.nonce)
    .first<{ wire_hash: string }>();
  insist(nonce?.wire_hash === wireHash, "service_nonce_reused", 409);
  return { pairing, authorization, body, current };
}
