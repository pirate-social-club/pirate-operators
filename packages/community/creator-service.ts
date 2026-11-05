import { recoverTypedDataAddress, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { bytes32, exact, hashJson, insist, integer, object } from "./common.ts";
import { address, httpsOrigin } from "./manifest-core.ts";
import type { CommunityConfig } from "./config-manifest.ts";

export type CreatorAction = "creator_launch" | "creator_exchange";
export interface CreatorAuthorization {
  action: CreatorAction;
  communityId: Hex;
  communityOrigin: string;
  serviceOrigin: string;
  configurationRevision: number;
  publisher: `0x${string}`;
  bodySha256: Hex;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
}
const domain = { name: "PirateCreatorConnection", version: "1" } as const;
const types = {
  CreatorRequest: [
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
const message = (a: CreatorAuthorization) => ({
  ...a,
  configurationRevision: BigInt(a.configurationRevision),
  issuedAt: BigInt(a.issuedAt),
  expiresAt: BigInt(a.expiresAt),
});
export async function signCreatorRequest(
  signer: PrivateKeyAccount,
  authorization: Omit<CreatorAuthorization, "publisher" | "bodySha256">,
  body: Record<string, unknown>,
) {
  const a = {
    ...authorization,
    publisher: address(signer.address.toLowerCase()),
    bodySha256: hashJson(body),
  };
  return {
    authorization: a,
    body,
    signature: await signer.signTypedData({
      domain,
      types,
      primaryType: "CreatorRequest",
      message: message(a),
    }),
  };
}
export async function authorizeCreatorRequest(
  input: unknown,
  action: CreatorAction,
  serviceOrigin: string,
  current: (communityId: Hex) => Promise<CommunityConfig>,
  now = Math.floor(Date.now() / 1000),
) {
  const envelope = object(input);
  exact(envelope, ["authorization", "body", "signature"]);
  const raw = object(envelope.authorization);
  exact(
    raw,
    types.CreatorRequest.map((f) => f.name),
  );
  insist(
    raw.action === action && raw.serviceOrigin === serviceOrigin,
    "wrong_creator_service_scope",
    403,
  );
  const a: CreatorAuthorization = {
    action,
    communityId: bytes32(raw.communityId),
    communityOrigin: httpsOrigin(raw.communityOrigin),
    serviceOrigin: httpsOrigin(raw.serviceOrigin),
    configurationRevision: integer(
      raw.configurationRevision,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    publisher: address(raw.publisher),
    bodySha256: bytes32(raw.bodySha256),
    nonce: bytes32(raw.nonce),
    issuedAt: integer(raw.issuedAt, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(raw.expiresAt, 1, Number.MAX_SAFE_INTEGER),
  };
  insist(
    a.issuedAt <= now &&
      a.issuedAt >= now - 300 &&
      a.expiresAt > now &&
      a.expiresAt <= a.issuedAt + 300,
    "expired_creator_request",
    403,
  );
  const body = object(envelope.body);
  insist(
    hashJson(body) === a.bodySha256 &&
      typeof envelope.signature === "string" &&
      /^0x[0-9a-f]{130}$/.test(envelope.signature),
    "invalid_creator_request_signature",
    403,
  );
  const recovered = await recoverTypedDataAddress({
    domain,
    types,
    primaryType: "CreatorRequest",
    message: message(a),
    signature: envelope.signature as Hex,
  });
  insist(
    address(recovered.toLowerCase()) === a.publisher,
    "invalid_creator_request_signature",
    403,
  );
  const config = await current(a.communityId);
  insist(
    config.chainId === 6343 &&
      config.communityId === a.communityId &&
      config.app.origin === a.communityOrigin &&
      config.configurationRevision === a.configurationRevision &&
      config.publisher === a.publisher,
    "creator_community_authority_changed",
    403,
  );
  insist(
    a.expiresAt > Math.max(now, Math.floor(Date.now() / 1000)),
    "expired_creator_request",
    403,
  );
  return { authorization: a, body, wireHash: hashJson(envelope) };
}

export interface CreatorConnectionBody {
  connectionId: string;
  accountRef: Hex;
  state: string;
  verifierHash: string;
}
export function creatorConnectionBody(input: unknown): CreatorConnectionBody {
  const value = object(input);
  exact(value, ["connectionId", "accountRef", "state", "verifierHash"]);
  insist(
    typeof value.connectionId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        value.connectionId,
      ),
    "invalid_creator_connection",
  );
  insist(
    typeof value.state === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(value.state) &&
      typeof value.verifierHash === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(value.verifierHash),
    "invalid_creator_connection",
  );
  return {
    connectionId: value.connectionId,
    accountRef: bytes32(value.accountRef),
    state: value.state,
    verifierHash: value.verifierHash,
  };
}
