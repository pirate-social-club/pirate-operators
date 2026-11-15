import { recoverTypedDataAddress, sha256, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  bytes32,
  canonical,
  exact,
  hashJson,
  insist,
  integer,
  object,
  token,
} from "../community/common.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { address, httpsOrigin } from "../community/manifest-core.ts";
import { catalogOwner } from "../community/owner-policy.ts";
export const canonicalPath = "/api/internal/catalog";
const requestDomain = {
  name: "Pirate Canonical Community Request",
  version: "1",
} as const;
const responseDomain = {
  name: "Pirate Canonical Community Response",
  version: "1",
} as const;
const types = {
  Commitment: [{ name: "payloadSha256", type: "bytes32" }],
} as const;
const actions = [
  "read",
  "source",
  "posting",
  "publication",
  "find_publication",
  "audio",
  "authorize",
  "ready",
] as const;
export type CanonicalAction = (typeof actions)[number];
interface RequestPayload {
  schema: "pirate.canonical-community-request/1";
  communityId: string;
  communityOrigin: string;
  configurationSha256: string;
  action: CanonicalAction;
  bodySha256: string;
  signer: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}
export interface CanonicalWireRequest {
  payload: RequestPayload;
  body: Record<string, unknown>;
  signature: Hex;
}
const sign = (
  signer: PrivateKeyAccount,
  domain: typeof requestDomain | typeof responseDomain,
  payload: unknown,
) =>
  signer.signTypedData({
    domain,
    types,
    primaryType: "Commitment",
    message: { payloadSha256: hashJson(payload) },
  });
async function recovered(
  domain: typeof requestDomain | typeof responseDomain,
  payload: unknown,
  signature: unknown,
) {
  insist(
    typeof signature === "string" && /^0x[0-9a-f]{130}$/.test(signature),
    "canonical_signature_invalid",
    403,
  );
  return (
    await recoverTypedDataAddress({
      domain,
      types,
      primaryType: "Commitment",
      message: { payloadSha256: hashJson(payload) },
      signature: signature as Hex,
    })
  ).toLowerCase();
}
export function canonicalAuthority(config: CommunityConfig) {
  insist(
    catalogOwner(config.policies.admission) && config.policies.recognition,
    "canonical_community_unconfigured",
    503,
  );
  return config.policies.recognition;
}
export async function signCanonicalRequest(
  signer: PrivateKeyAccount,
  config: CommunityConfig,
  action: CanonicalAction,
  body: Record<string, unknown>,
  now = Math.floor(Date.now() / 1000),
): Promise<CanonicalWireRequest> {
  canonicalAuthority(config);
  const payload: RequestPayload = {
    schema: "pirate.canonical-community-request/1",
    communityId: config.communityId,
    communityOrigin: config.app.origin,
    configurationSha256: hashJson(config),
    action,
    bodySha256: hashJson(body),
    signer: signer.address.toLowerCase(),
    nonce: hashJson({ nonce: token() }),
    issuedAt: now,
    expiresAt: now + 60,
  };
  return {
    payload,
    body,
    signature: await sign(signer, requestDomain, payload),
  };
}
export async function authorizeCanonicalRequest(
  input: unknown,
  config: CommunityConfig,
  now = Math.floor(Date.now() / 1000),
) {
  const v = object(input);
  exact(v, ["payload", "body", "signature"]);
  const p = object(v.payload),
    profile = canonicalAuthority(config);
  exact(p, [
    "schema",
    "communityId",
    "communityOrigin",
    "configurationSha256",
    "action",
    "bodySha256",
    "signer",
    "nonce",
    "issuedAt",
    "expiresAt",
  ]);
  insist(
    p.schema === "pirate.canonical-community-request/1" &&
      actions.includes(p.action as CanonicalAction),
    "canonical_request_invalid",
    403,
  );
  const payload: RequestPayload = {
    schema: p.schema,
    communityId: bytes32(p.communityId),
    communityOrigin: httpsOrigin(p.communityOrigin),
    configurationSha256: bytes32(p.configurationSha256),
    action: p.action as CanonicalAction,
    bodySha256: bytes32(p.bodySha256),
    signer: address(p.signer),
    nonce: bytes32(p.nonce),
    issuedAt: integer(p.issuedAt, 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(p.expiresAt, 1, Number.MAX_SAFE_INTEGER),
  };
  insist(
    payload.communityId === config.communityId &&
      payload.communityOrigin === config.app.origin &&
      payload.configurationSha256 === hashJson(config) &&
      payload.issuedAt <= now &&
      payload.issuedAt >= now - 60 &&
      payload.expiresAt > now &&
      payload.expiresAt <= payload.issuedAt + 60,
    "canonical_request_scope_changed",
    403,
  );
  const body = object(v.body);
  insist(
    hashJson(body) === payload.bodySha256,
    "canonical_request_body_changed",
    403,
  );
  insist(
    payload.signer === profile.signer ||
      payload.signer === config.policies.moderationSigner,
    "canonical_caller_forbidden",
    403,
  );
  insist(
    payload.action !== "ready" ||
      payload.signer === config.policies.moderationSigner,
    "canonical_caller_forbidden",
    403,
  );
  insist(
    (await recovered(requestDomain, payload, v.signature)) === payload.signer,
    "canonical_signature_invalid",
    403,
  );
  return { payload, body, signature: v.signature as Hex };
}
/** Receipt commits to the actual binary/JSON bytes and this one request. */
export async function canonicalResponse(
  wire: CanonicalWireRequest,
  config: CommunityConfig,
  signer: PrivateKeyAccount,
  data: unknown | Uint8Array,
) {
  insist(
    signer.address.toLowerCase() === config.publisher,
    "canonical_publisher_changed",
    503,
  );
  const binary = data instanceof Uint8Array,
    bytes = binary ? data : new TextEncoder().encode(canonical(data));
  const payload = {
    schema: "pirate.canonical-community-response/1",
    requestSha256: hashJson(wire),
    configurationSha256: hashJson(config),
    bodySha256: sha256(bytes),
    expiresAt: wire.payload.expiresAt,
  };
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": binary ? "application/octet-stream" : "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-pirate-canonical-receipt": JSON.stringify({
        payload,
        signature: await sign(signer, responseDomain, payload),
      }),
    },
  });
}
export async function readCanonicalBytes(
  response: Pick<Response, "body">,
  maximum: number,
  signal: AbortSignal,
) {
  const reader = response.body?.getReader();
  insist(reader, "canonical_response_missing", 503);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      insist(size <= maximum, "canonical_response_too_large", 503);
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function canonicalRequestBody(request: Request) {
  insist(
    request.headers.get("content-type")?.split(";")[0] === "application/json",
    "json_required",
    415,
  );
  const bytes = await readCanonicalBytes(
    request,
    64 * 1024,
    AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
  );
  return object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}
export async function verifyCanonicalResponse(
  input: unknown,
  wire: CanonicalWireRequest,
  config: CommunityConfig,
  bytes: Uint8Array,
) {
  const receipt = object(input);
  exact(receipt, ["payload", "signature"]);
  const p = object(receipt.payload);
  exact(p, [
    "schema",
    "requestSha256",
    "configurationSha256",
    "bodySha256",
    "expiresAt",
  ]);
  insist(
    p.schema === "pirate.canonical-community-response/1" &&
      p.requestSha256 === hashJson(wire) &&
      p.configurationSha256 === hashJson(config) &&
      p.bodySha256 === sha256(bytes) &&
      p.expiresAt === wire.payload.expiresAt &&
      Number(p.expiresAt) > Math.floor(Date.now() / 1000),
    "canonical_response_scope_changed",
    403,
  );
  insist(
    (await recovered(responseDomain, p, receipt.signature)) ===
      config.publisher,
    "canonical_response_signer_changed",
    403,
  );
}
