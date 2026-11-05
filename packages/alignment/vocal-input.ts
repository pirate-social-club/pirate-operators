// Narrow private read capability for the existing managed evidence signer.
// Wiring this helper into either live service requires its own reviewed package.
import { recoverMessageAddress, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  bytes32,
  exact,
  hashJson,
  insist,
  integer,
  jsonBody,
  object,
  MAX_AUDIO_BYTES,
} from "../community/common.ts";
import { httpsOrigin } from "../community/manifest-core.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { ownerCurated } from "../community/owner-policy.ts";

export interface VocalCapability {
  schema: "pirate.vocal-input/1";
  communityId: Hex;
  configurationSha256: Hex;
  postId: Hex;
  postRevision: number;
  vocalSha256: Hex;
  byteLength: number;
  durationMs: number;
  communityOrigin: string;
  serviceOrigin: string;
  issuedAt: number;
  expiresAt: number;
}
export interface SignedVocalCapability {
  capability: VocalCapability;
  signature: Hex;
}
export interface PublishedVocalSource {
  configuration: CommunityConfig;
  post: { communityId: Hex; postId: Hex; revision: number };
}
export function vocalCapability(
  value: unknown,
  configuration: CommunityConfig,
  serviceOrigin: string,
  now = Math.floor(Date.now() / 1000),
): VocalCapability {
  const c = object(value);
  exact(c, [
    "schema",
    "communityId",
    "configurationSha256",
    "postId",
    "postRevision",
    "vocalSha256",
    "byteLength",
    "durationMs",
    "communityOrigin",
    "serviceOrigin",
    "issuedAt",
    "expiresAt",
  ]);
  insist(
    c.schema === "pirate.vocal-input/1" &&
      ownerCurated(configuration.policies.admission),
    "vocal_policy_unavailable",
    403,
  );
  const issuedAt = integer(c.issuedAt, 1, Number.MAX_SAFE_INTEGER),
    expiresAt = integer(c.expiresAt, issuedAt + 1, issuedAt + 300);
  insist(
    issuedAt <= now + 30 && expiresAt > now,
    "vocal_capability_expired",
    403,
  );
  const result: VocalCapability = {
    schema: "pirate.vocal-input/1",
    communityId: bytes32(c.communityId),
    configurationSha256: bytes32(c.configurationSha256),
    postId: bytes32(c.postId),
    postRevision: integer(c.postRevision, 1, Number.MAX_SAFE_INTEGER),
    vocalSha256: bytes32(c.vocalSha256),
    byteLength: integer(c.byteLength, 1, MAX_AUDIO_BYTES),
    durationMs: integer(c.durationMs, 1, 3600000),
    communityOrigin: httpsOrigin(c.communityOrigin),
    serviceOrigin: httpsOrigin(c.serviceOrigin),
    issuedAt,
    expiresAt,
  };
  insist(
    result.communityId === configuration.communityId &&
      result.configurationSha256 === hashJson(configuration) &&
      result.communityOrigin === configuration.app.origin &&
      result.serviceOrigin === httpsOrigin(serviceOrigin),
    "vocal_capability_scope_changed",
    403,
  );
  return result;
}
export async function signVocalCapability(
  signer: PrivateKeyAccount,
  input: VocalCapability,
  configuration: CommunityConfig,
  serviceOrigin: string,
  now = Math.floor(Date.now() / 1000),
): Promise<SignedVocalCapability> {
  const capability = vocalCapability(input, configuration, serviceOrigin, now);
  insist(
    signer.address.toLowerCase() === configuration.policies.moderationSigner,
    "vocal_service_signer_changed",
    403,
  );
  return {
    capability,
    signature: await signer.signMessage({
      message: { raw: hashJson(capability) },
    }),
  };
}

/** Both private published-job state and a fresh canonical public-post check
 * must pass. Possession of a community session or a provider key is insufficient. */
export async function serveVocalInput(
  request: Request,
  db: D1Database,
  media: Pick<R2Bucket, "get">,
  configuration: CommunityConfig,
  serviceOrigin: string,
  readPublication: (
    capability: VocalCapability,
  ) => Promise<PublishedVocalSource>,
  clock = () => Math.floor(Date.now() / 1000),
) {
  const url = new URL(request.url);
  insist(
    request.method === "POST" &&
      url.origin === configuration.app.origin &&
      url.pathname === "/api/alignment/vocal" &&
      !url.search &&
      request.headers.get("origin") === httpsOrigin(serviceOrigin),
    "vocal_capability_required",
    403,
  );
  const signed = await jsonBody(request, 16384);
  exact(signed, ["capability", "signature"]);
  const capability = vocalCapability(
    signed.capability,
    configuration,
    serviceOrigin,
    clock(),
  );
  insist(
    typeof signed.signature === "string" &&
      /^0x[0-9a-fA-F]{130}$/.test(signed.signature),
    "invalid_vocal_signature",
    403,
  );
  const signer = await recoverMessageAddress({
    message: { raw: hashJson(capability) },
    signature: signed.signature as Hex,
  });
  insist(
    signer.toLowerCase() === configuration.policies.moderationSigner,
    "invalid_vocal_signature",
    403,
  );
  const freshPublication = async () => {
    const current = await readPublication(capability);
    insist(
      current.post.communityId === capability.communityId &&
        current.post.postId === capability.postId &&
        current.post.revision === capability.postRevision,
      "vocal_publication_changed",
      403,
    );
    vocalCapability(capability, current.configuration, serviceOrigin, clock());
    return current.configuration;
  };
  await freshPublication();
  const stem = await db
    .prepare(
      `SELECT m.object_key,m.object_etag,m.sha256,m.byte_length,m.duration_ms,j.authority_json
    FROM media_stems m JOIN media_submissions s ON s.submission_id=m.submission_id
    JOIN publication_jobs j ON j.submission_id=s.submission_id
    WHERE s.post_id=? AND s.upload_state='sealed' AND j.phase='published'
    AND m.slot='vocals' AND m.state='sealed'`,
    )
    .bind(capability.postId)
    .first<{
      object_key: string;
      object_etag: string;
      sha256: string;
      byte_length: number;
      duration_ms: number;
      authority_json: string;
    }>();
  insist(
    stem &&
      object(JSON.parse(stem.authority_json)).communityId ===
        capability.communityId &&
      stem.sha256 === capability.vocalSha256 &&
      stem.byte_length === capability.byteLength &&
      stem.duration_ms === capability.durationMs,
    "published_vocal_unavailable",
    404,
  );
  vocalCapability(capability, configuration, serviceOrigin, clock());
  const stored = await media.get(stem.object_key);
  insist(
    stored &&
      stored.etag === stem.object_etag &&
      stored.size === capability.byteLength &&
      stored.customMetadata?.sha256 === capability.vocalSha256,
    "published_vocal_changed",
    503,
  );
  // Repeat both canonical publication and current authority after private I/O.
  // No await may separate this final expiry check from the response boundary.
  const deliveryConfiguration = await freshPublication();
  vocalCapability(capability, deliveryConfiguration, serviceOrigin, clock());
  return new Response(stored.body, {
    headers: {
      "content-type": "audio/mpeg",
      "content-length": String(capability.byteLength),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
