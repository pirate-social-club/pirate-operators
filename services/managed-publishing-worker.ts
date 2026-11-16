/** Explicit profile wrapper. Existing registered/static owner composition stays
 * in managed-moderation.ts; fresh Web2 uses only journal-admitted owner grants. */
import { sha256 } from "viem";
import { loopbackSigningOpener } from "../apps/community-wizard/src/web2-moss-window.ts";
import type { ManagedEnv } from "./managed-moderation.ts";
import { bytes32, CommunityError, exact, insist, jsonBody, object } from "../packages/community/common.ts";
import type { ManagedPublishingAdmissionEnv } from "./managed-publishing-admission.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { ManagedPublishingRegistration } from "../packages/release/managed-publishing-admission.ts";

export interface ManagedPublishingEnv extends ManagedEnv, ManagedPublishingAdmissionEnv {
  MANAGED_PUBLISHING_PROFILE: "managed-web2" | "historical-registered" | "historical-owner";
  OPERATOR_SIGNING_PROFILE_JSON?: string;
  ASSETS?: Fetcher;
}
export interface OperatorSigningOnlyEnv {
  MANAGED_PUBLISHING_PROFILE: "operator-signing-only";
  OPERATOR_SIGNING_PROFILE_JSON: string;
  ASSETS: Fetcher;
}
export interface OperatorSigningClosure {
  schema: "pirate.operator-signing-closure/1";
  origin: string;
  contentSecurityPolicy: string;
  files: { path: string; sha256: string; contentType: string }[];
}
// Exact committed W1 response contract. Wildcards are confined to MegaETH's
// required SDK endpoints; configuration cannot select a broader policy.
const signingContentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.megaeth.com; frame-src https://*.megaeth.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export function operatorSigningClosure(input: OperatorSigningClosure) {
  const p = structuredClone(input); exact(object(p), ["schema", "origin", "contentSecurityPolicy", "files"]);
  const origin = new URL(p.origin);
  insist(p.schema === "pirate.operator-signing-closure/1" && origin.protocol === "https:" && p.origin === origin.origin &&
    p.contentSecurityPolicy === signingContentSecurityPolicy && Array.isArray(p.files) && p.files.length > 0 && p.files.length <= 64,
    "operator_signing_closure_unavailable", 503);
  for (const file of p.files) {
    exact(object(file), ["path", "sha256", "contentType"]);
    insist(file.path === "/operator-signing" || /^\/assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+(?![\s\S])/.test(file.path), "operator_signing_asset_path_invalid", 503);
    insist(typeof file.sha256 === "string" && file.sha256.length === 66, "operator_signing_asset_digest_invalid", 503); bytes32(file.sha256);
    insist(["text/html", "text/javascript", "text/css", "image/png", "image/svg+xml", "font/woff2"].includes(file.contentType) &&
      (file.path === "/operator-signing" ? file.contentType === "text/html" : file.contentType !== "text/html"), "operator_signing_asset_type_invalid", 503);
  }
  insist(new Set(p.files.map(file => file.path)).size === p.files.length && p.files.some(file => file.path === "/operator-signing"), "operator_signing_closure_invalid", 503);
  return p;
}
async function signingAsset(request: Request, env: Pick<ManagedPublishingEnv, "OPERATOR_SIGNING_PROFILE_JSON" | "ASSETS">) {
  insist(typeof env.OPERATOR_SIGNING_PROFILE_JSON === "string" && env.OPERATOR_SIGNING_PROFILE_JSON.length <= 32768 && env.ASSETS,
    "operator_signing_closure_unavailable", 503);
  const profile = operatorSigningClosure(JSON.parse(env.OPERATOR_SIGNING_PROFILE_JSON)), url = new URL(request.url), host = request.headers.get("host");
  insist(url.origin === profile.origin, "operator_signing_wrong_origin", 403);
  insist(host === null || host === url.host, "operator_signing_wrong_host", 403);
  insist(!url.hash && !url.pathname.includes("%"), "operator_signing_path_invalid", 404);
  if (url.pathname === "/operator-signing") {
    let opener: string;
    try { opener = loopbackSigningOpener(url.searchParams.get("openerOrigin") ?? ""); }
    catch { throw new CommunityError("operator_signing_opener_invalid", 404); }
    // Match the committed browser's sole public-metadata URL exactly, rejecting
    // duplicate/extra parameters, encoded key aliases and alternate encodings.
    insist(url.search === "?openerOrigin=" + encodeURIComponent(opener), "operator_signing_opener_invalid", 404);
  } else insist(!url.search, "operator_signing_path_invalid", 404);
  insist(request.method === "GET" || request.method === "HEAD", "operator_signing_method_unavailable", 405);
  const file = profile.files.find(file => file.path === url.pathname); insist(file, "operator_signing_asset_not_found", 404);
  // Send no incoming cookies, auth, nonce or signing payload to the assets binding.
  const response = await env.ASSETS.fetch(new Request(profile.origin + file.path, { redirect: "manual" }));
  insist(response.status === 200 && response.body, "operator_signing_asset_unavailable", 503);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength;
    if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("operator_signing_asset_limit"); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  insist(sha256(bytes) === file.sha256, "operator_signing_asset_changed", 503);
  return new Response(request.method === "HEAD" ? null : bytes, { headers: { "content-type": file.contentType,
    "cache-control": "no-store", "content-security-policy": profile.contentSecurityPolicy, "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin", "x-frame-options": "DENY", "cross-origin-opener-policy": "unsafe-none",
    "permissions-policy": 'publickey-credentials-get=(self "https://account.megaeth.com"), publickey-credentials-create=(self "https://account.megaeth.com")' } });
}
function historical(env: ManagedPublishingEnv) {
  insist(["managed-web2", "historical-registered", "historical-owner"].includes(env.MANAGED_PUBLISHING_PROFILE), "managed_profile_unavailable", 503);
  if (env.MANAGED_PUBLISHING_PROFILE === "historical-owner") insist(env.OWNER_GRANT_JSON, "historical_owner_grant_unavailable", 503);
  if (env.MANAGED_PUBLISHING_PROFILE === "historical-registered") insist(env.RELEASE_GRANT_JSON && !env.OWNER_GRANT_JSON,
    "historical_registered_grant_unavailable", 503);
  return env.MANAGED_PUBLISHING_PROFILE !== "managed-web2";
}
async function admittedEnv(env: ManagedPublishingEnv, r: ManagedPublishingRegistration, current: () => Promise<CommunityConfig>,
  gate: NonNullable<ManagedEnv["MANAGED_ADMISSION_GATE"]>): Promise<ManagedEnv> {
  const [{ canonicalCommunityClient }, { megaethReadClient }, { communityIpfsTransport }, { requireDedicatedManagedSigner }] = await Promise.all([
    import("../packages/recognition/canonical-transport.ts"), import("../packages/community/chain.ts"),
    import("./community-deployment-profile.ts"), import("../packages/release/managed-publishing-admission.ts")]);
  const s = r.scope, d = r.deployment;
  insist(env.SERVICE_ORIGIN === r.serviceOrigin, "managed_service_origin_changed", 503);
  const client = megaethReadClient(undefined, d.rpcUrl);
  const canonical = canonicalCommunityClient({ signer: requireDedicatedManagedSigner(bytes32(env.MODERATION_SIGNER_PRIVATE_KEY), d.rpcUrl),
    currentConfiguration: current, transport: env.CATALOG_CANONICAL_TRANSPORT,
    chain: { client, ownerVerification: { client, currentConfiguration: current, now: () => Math.floor(Date.now() / 1000),
      maxSafeBlockAgeSeconds: BigInt(d.freshness.maxSafeBlockAgeSeconds) },
      posts: { ...d.posts, deploymentBlock: BigInt(d.posts.deploymentBlock) }, ipfs: communityIpfsTransport(d) } });
  return { ...env, MANAGED_ADMISSION_GATE: gate, CATALOG_RELEASE_INPUTS: { canonical: async () => canonical, recognition: async () => ({ ready: canonical.ready }) },
    // The shared handler owns the gate at the actual ADD boundary; status GETs
    // remain authenticated original reads, with no blanket live-window refusal.
    PIN_TRANSPORT: env.PIN_TRANSPORT,
    OWNER_GRANT_JSON: JSON.stringify(r.grant), RELEASE_GRANT_JSON: undefined, REGISTRATION_OPERATOR_PRIVATE_KEY: undefined,
    DIRECTORY_PROFILES_JSON: JSON.stringify([d]), PAIRINGS_JSON: JSON.stringify([{
      schema: "pirate.managed-pairing/2", chainId: 6343, communityKey: d.directoryProfile.communityKey,
      installationId: s.installationId, communityId: s.communityId, directory: d.directoryProfile.directory,
      controller: s.controller, communityOrigin: s.origin, serviceOrigin: r.serviceOrigin, enabled: true,
      budgetPeriod: r.moderation.budgetPeriod, requestCap: r.moderation.requestCap,
    }]) };
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (env.MANAGED_PUBLISHING_PROFILE === "operator-signing-only") {
        if (url.pathname === "/operator-signing" || url.pathname.startsWith("/assets/")) return await signingAsset(request, env);
        return Response.json({ error: "operator_signing_backend_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      if (env.MANAGED_PUBLISHING_PROFILE === "managed-web2" && (url.pathname === "/operator-signing" || url.pathname.startsWith("/assets/")))
        return await signingAsset(request, env);
      const { default: managedModeration } = await import("./managed-moderation.ts");
      if (historical(env)) return await managedModeration.fetch(request, env);
      const { configuredPublishingAdmission } = await import("./managed-publishing-admission.ts"), service = configuredPublishingAdmission(env);
      if (url.pathname.startsWith("/v1/managed-publishing/")) return await service.fetch(request);
      insist(url.origin === service.config.origin && !url.search, "not_found", 404);
      // There is no global owner readiness: each exact original must be attached.
      if (url.pathname === "/health" && request.method === "GET") {
        await service.journal.installation();
        const community = request.headers.get("x-pirate-community"), grantDigest = request.headers.get("x-pirate-owner-grant");
        insist(community !== null && grantDigest !== null, "managed_scoped_health_required", 403);
        const { managedDigest, requireDedicatedManagedSigner, selectionFor } = await import("../packages/release/managed-publishing-admission.ts"),
          r = await service.forCommunity(managedDigest(community)), current = await service.current(r),
          signer = requireDedicatedManagedSigner(managedDigest(env.MODERATION_SIGNER_PRIVATE_KEY), r.deployment.rpcUrl);
        insist(typeof env.FILEBASE_IPFS_TOKEN === "string" && env.FILEBASE_IPFS_TOKEN.length > 0 && env.FILEBASE_IPFS_TOKEN.length <= 8192 &&
          signer.address.toLowerCase() === current.policies.moderationSigner, "managed_release_credentials_unavailable", 503);
        insist(managedDigest(grantDigest) === r.grant.sha256, "managed_selection_changed", 409);
        const observation = await service.journal.observation(r, selectionFor(r).selectionDigest);
        return Response.json({ service: "pirate-managed-web2/1", status: "available", profileHash: bytes32(env.SERVICE_PROFILE_HASH),
          release: { configured: false }, ownerRelease: { configured: true, grantSha256: r.grant.sha256, expiresAt: r.grant.expiresAt,
            selectionDigest: observation.selectionDigest, admissionReference: observation.admissionReference } }, { headers: { "cache-control": "no-store" } });
      }
      insist(url.pathname.startsWith("/v1/owner-releases/"), "fresh_catalog_release_path_required", 403);
      const body = await jsonBody(request.clone(), 256 * 1024), communityId = bytes32(object(body.authorization).communityId),
        r = await service.forCommunity(communityId, "read");
      // Only the shared lazy supplier/dispatch boundary can distinguish a new
      // purchase from authenticated replay. Do not pre-empt that decision here.
      const response = await managedModeration.fetch(request, await admittedEnv(env, r, () => service.identity(r), service.gate(r)));
      await service.identity(r);
      return response;
    } catch (error) {
      return Response.json({ error: error instanceof CommunityError ? error.code : "managed_service_unavailable" }, {
        status: error instanceof CommunityError ? error.status : 503, headers: { "cache-control": "no-store" },
      });
    }
  },
  async queue(batch, env) {
    if (env.MANAGED_PUBLISHING_PROFILE === "operator-signing-only") throw new Error("operator_signing_backend_unavailable");
    const { default: managedModeration } = await import("./managed-moderation.ts");
    if (historical(env)) { await managedModeration.queue(batch, env); return; }
    const { configuredPublishingAdmission } = await import("./managed-publishing-admission.ts"), service = configuredPublishingAdmission(env);
    for (const message of batch.messages) {
      try {
        const row = await env.DB.withSession("first-primary").prepare("SELECT community_id FROM managed_admissions WHERE admission_id=?")
          .bind(bytes32(message.body.admissionId)).first<{ community_id: string }>();
        insist(row, "managed_original_unavailable", 503);
        const r = await service.forCommunity(row.community_id);
        await managedModeration.queue({ ...batch, messages: [message] }, await admittedEnv(env, r, () => service.identity(r), service.gate(r)));
      } catch { message.retry({ delaySeconds: 60 }); }
    }
  },
  async scheduled(event, env) {
    if (env.MANAGED_PUBLISHING_PROFILE === "operator-signing-only") throw new Error("operator_signing_backend_unavailable");
    const { default: managedModeration } = await import("./managed-moderation.ts");
    if (historical(env)) { await managedModeration.scheduled(event, env); return; }
    const { configuredPublishingAdmission } = await import("./managed-publishing-admission.ts");
    await configuredPublishingAdmission(env).journal.installation();
    const { recoverAdmissions } = await import("../packages/moderation/service.ts");
    await recoverAdmissions(env.DB, async admissionId => { await env.JOBS.send({ admissionId }); });
  },
} satisfies ExportedHandler<ManagedPublishingEnv | OperatorSigningOnlyEnv, { admissionId: string }>;
