/** Explicit profile wrapper. Existing registered/static owner composition stays
 * in managed-moderation.ts; fresh Web2 uses only journal-admitted owner grants. */
import managedModeration, { type ManagedEnv } from "./managed-moderation.ts";
import { recoverAdmissions } from "../packages/moderation/service.ts";
import { bytes32, CommunityError, insist, jsonBody, object } from "../packages/community/common.ts";
import { configuredPublishingAdmission, type ManagedPublishingAdmissionEnv } from "./managed-publishing-admission.ts";
import { canonicalCommunityClient } from "../packages/recognition/canonical-transport.ts";
import { megaethReadClient } from "../packages/community/chain.ts";
import { communityIpfsTransport } from "./community-deployment-profile.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { requireDedicatedManagedSigner, selectionFor, type ManagedPublishingRegistration } from "../packages/release/managed-publishing-admission.ts";

export interface ManagedPublishingEnv extends ManagedEnv, ManagedPublishingAdmissionEnv {
  MANAGED_PUBLISHING_PROFILE: "managed-web2" | "historical-registered" | "historical-owner";
}
function historical(env: ManagedPublishingEnv) {
  insist(["managed-web2", "historical-registered", "historical-owner"].includes(env.MANAGED_PUBLISHING_PROFILE), "managed_profile_unavailable", 503);
  if (env.MANAGED_PUBLISHING_PROFILE === "historical-owner") insist(env.OWNER_GRANT_JSON, "historical_owner_grant_unavailable", 503);
  if (env.MANAGED_PUBLISHING_PROFILE === "historical-registered") insist(env.RELEASE_GRANT_JSON && !env.OWNER_GRANT_JSON,
    "historical_registered_grant_unavailable", 503);
  return env.MANAGED_PUBLISHING_PROFILE !== "managed-web2";
}
function admittedEnv(env: ManagedPublishingEnv, r: ManagedPublishingRegistration, current: () => Promise<CommunityConfig>): ManagedEnv {
  const s = r.scope, d = r.deployment;
  insist(env.SERVICE_ORIGIN === r.serviceOrigin, "managed_service_origin_changed", 503);
  const canonical = canonicalCommunityClient({ signer: requireDedicatedManagedSigner(bytes32(env.MODERATION_SIGNER_PRIVATE_KEY), d.rpcUrl),
    currentConfiguration: current, transport: env.CATALOG_CANONICAL_TRANSPORT,
    chain: { client: megaethReadClient(undefined, d.rpcUrl), posts: { ...d.posts, deploymentBlock: BigInt(d.posts.deploymentBlock) },
      ipfs: communityIpfsTransport(d) } });
  return { ...env, CATALOG_RELEASE_INPUTS: { canonical: async () => canonical, recognition: async () => ({ ready: canonical.ready }) },
    PIN_TRANSPORT: async request => { await current(); const response = await (env.PIN_TRANSPORT ?? fetch)(request); await current(); return response; },
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
      if (historical(env)) return await managedModeration.fetch(request, env);
      const service = configuredPublishingAdmission(env), url = new URL(request.url);
      if (url.pathname.startsWith("/v1/managed-publishing/")) return await service.fetch(request);
      insist(url.origin === service.config.origin && !url.search, "not_found", 404);
      // There is no global owner readiness: each exact original must be attached.
      if (url.pathname === "/health" && request.method === "GET") {
        await service.journal.installation();
        const community = request.headers.get("x-pirate-community"), grantDigest = request.headers.get("x-pirate-owner-grant");
        if (community !== null || grantDigest !== null) {
          const r = await service.forCommunity(bytes32(community));
          const current = await service.current(r), signer = requireDedicatedManagedSigner(bytes32(env.MODERATION_SIGNER_PRIVATE_KEY), r.deployment.rpcUrl);
          insist(typeof env.FILEBASE_IPFS_TOKEN === "string" && env.FILEBASE_IPFS_TOKEN.length > 0 && env.FILEBASE_IPFS_TOKEN.length <= 8192 &&
            signer.address.toLowerCase() === current.policies.moderationSigner, "managed_release_credentials_unavailable", 503);
          insist(grantDigest === r.grant.sha256, "managed_selection_changed", 409);
          return Response.json({ service: "pirate-managed-web2/1", status: "available", profileHash: bytes32(env.SERVICE_PROFILE_HASH),
            release: { configured: false }, ownerRelease: { configured: true, grantSha256: r.grant.sha256,
              expiresAt: r.grant.expiresAt, selectionDigest: (await service.journal.observation(r, selectionFor(r).selectionDigest)).selectionDigest,
              admissionReference: r.admissionReference } }, { headers: { "cache-control": "no-store" } });
        }
        return Response.json({ service: "pirate-managed-web2/1", status: "configured", profileHash: bytes32(env.SERVICE_PROFILE_HASH),
          ownerRelease: { configured: false }, readiness: "per-admission" }, { headers: { "cache-control": "no-store" } });
      }
      insist(url.pathname.startsWith("/v1/owner-releases/"), "fresh_catalog_release_path_required", 403);
      const body = await jsonBody(request.clone(), 256 * 1024), communityId = bytes32(object(body.authorization).communityId),
        r = await service.forCommunity(communityId);
      const response = await managedModeration.fetch(request, admittedEnv(env, r, () => service.current(r)));
      // Upstream rechecks authority at its own awaited dispatch boundaries. This
      // wrapper also refuses acknowledgement if admission changed during it.
      await service.current(r);
      return response;
    } catch (error) {
      return Response.json({ error: error instanceof CommunityError ? error.code : "managed_service_unavailable" }, {
        status: error instanceof CommunityError ? error.status : 503, headers: { "cache-control": "no-store" },
      });
    }
  },
  async queue(batch, env) {
    if (historical(env)) { await managedModeration.queue(batch, env); return; }
    const service = configuredPublishingAdmission(env);
    for (const message of batch.messages) {
      try {
        const row = await env.DB.withSession("first-primary").prepare("SELECT community_id FROM managed_admissions WHERE admission_id=?")
          .bind(bytes32(message.body.admissionId)).first<{ community_id: string }>();
        insist(row, "managed_original_unavailable", 503);
        const r = await service.forCommunity(row.community_id);
        await managedModeration.queue({ ...batch, messages: [message] }, admittedEnv(env, r, () => service.current(r)));
      } catch { message.retry({ delaySeconds: 60 }); }
    }
  },
  async scheduled(event, env) {
    if (historical(env)) { await managedModeration.scheduled(event, env); return; }
    await configuredPublishingAdmission(env).journal.installation();
    await recoverAdmissions(env.DB, async admissionId => { await env.JOBS.send({ admissionId }); });
  },
} satisfies ExportedHandler<ManagedPublishingEnv, { admissionId: string }>;
