import type {ManagedAdmissionGate} from "../packages/release/managed-admission-gate.ts";
import { createPublicClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  bytes32,
  CommunityError,
  exact,
  insist,
  integer,
  jsonBody,
  object,
  text,
} from "../packages/community/common.ts";
import { address, httpsOrigin } from "../packages/community/manifest-core.ts";
import { readConfiguration } from "../packages/community/directory-reader.ts";
import { managedPairings, isWeb2Pairing } from "../packages/moderation/pairing.ts";
import { readWeb2Community } from "../packages/community/web2-directory-reader.ts";
import { parseWeb2ProfileDocument } from "../packages/community/web2-directory.ts";
import { validateCommunityDeploymentProfile, isWeb2Deployment, communityIpfsTransport } from "./community-deployment-profile.ts";
import type { IpfsTransport } from "../packages/community/ipfs.ts";
import {
  managedFetch,
  recoverAdmissions,
  runAdmission,
  type ManagedService,
} from "../packages/moderation/service.ts";

import { validateReleaseGrant } from "../packages/release/grant.ts";
import { releaseFetch } from "../packages/release/service.ts";
import {
  validateOwnerGrant,
  type OwnerBudgetGrant,
} from "../packages/release/owner-grant.ts";
import { ownerReleaseFetch } from "../packages/release/owner-release.ts";
import { storyReadClient } from "../packages/community/registration-chain.ts";
import { acrEndpoint } from "../packages/moderation/acrcloud.ts";
import { adoptCuratedAdmission } from "../packages/moderation/adopt-curated.ts";

import type { CatalogOwnerReleaseInputs } from "../packages/release/catalog-owner-release.ts";
import { canonicalCommunityClient } from "../packages/recognition/canonical-transport.ts";
import { megaethReadClient } from "../packages/community/chain.ts";
const unavailableAdmissionGate:ManagedAdmissionGate={
  async reservationCondition(){throw new CommunityError("managed_admission_gate_unavailable",503);},
  async beforeDispatch(){throw new CommunityError("managed_admission_gate_unavailable",503);},
};
export interface ManagedEnv {
  /** Authenticated private NEW-effect composition; never parsed from requests. */
  MANAGED_ADMISSION_GATE?: ManagedAdmissionGate;
  /** Trusted service composition for the external pinning provider. */
  PIN_TRANSPORT?: IpfsTransport;
  CATALOG_RELEASE_INPUTS?: CatalogOwnerReleaseInputs;
  /** Explicit managed-side qualification transport; never a community credential. */
  CATALOG_CANONICAL_TRANSPORT?: (request:Request)=>Promise<Response>;
  DB: D1Database;
  MEDIA: R2Bucket;
  JOBS: Queue<{ admissionId: string }>;
  SERVICE_ORIGIN: string;
  SERVICE_PROFILE_HASH: string;
  PAIRINGS_JSON: string;
  DIRECTORY_PROFILES_JSON: string;
  SERVICE_BUDGET_PERIOD: string;
  SERVICE_REQUEST_CAP: string;
  ACRCLOUD_HOST: string;
  ACRCLOUD_ACCESS_KEY: string;
  ACRCLOUD_ACCESS_SECRET: string;
  OPENAI_API_KEY: string;
  MODERATION_SIGNER_PRIVATE_KEY: string;
  RELEASE_GRANT_JSON?: string;
  FILEBASE_IPFS_TOKEN?: string;
  REGISTRATION_OPERATOR_PRIVATE_KEY?: string;
  /**
   * Reviewed owner budget grant for the unregistered owner policy. It enables
   * owner recognition and the pins-only owner release; no registration key,
   * registration client or creator service is involved.
   */
  OWNER_GRANT_JSON?: string;
  WEB2_PUBLISHING_SELECTION_SHA256?: string;
  OWNER_GRANT_ADMISSION_REFERENCE?: string;
}
/** The configured owner grant, or undefined when absent or invalid. */
function ownerGrant(env: ManagedEnv): OwnerBudgetGrant | undefined {
  if (!env.OWNER_GRANT_JSON) return undefined;
  try {
    return validateOwnerGrant(JSON.parse(env.OWNER_GRANT_JSON));
  } catch {
    // Owner work then fails closed with owner_grant_unavailable, and health
    // reports the owner release as not configured.
    return undefined;
  }
}
const chain = defineChain({
  id: 6343,
  name: "MegaETH Testnet",
  nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://carrot.megaeth.com/rpc"] } },
});

function configuration(env: ManagedEnv): ManagedService {
  insist(
    /^0x[0-9a-fA-F]{64}$/.test(env.MODERATION_SIGNER_PRIVATE_KEY),
    "invalid_service_signer",
    503,
  );
  const pairings = managedPairings(JSON.parse(env.PAIRINGS_JSON)),
    rawProfiles: unknown = JSON.parse(env.DIRECTORY_PROFILES_JSON);
  insist(
    Array.isArray(rawProfiles) && rawProfiles.length === pairings.length,
    "invalid_directory_profiles",
    503,
  );
  const profiles = rawProfiles.map((value) => {
    const p = object(value);
    if (p.schema === "pirate.community-deployment/2") {
      const deployment = validateCommunityDeploymentProfile(p);
      insist(isWeb2Deployment(deployment), "invalid_directory_profile", 503);
      return {kind: "web2" as const, communityId: deployment.directoryProfile.communityId, deployment};
    }
    exact(p, [
      "chainId",
      "communityId",
      "directory",
      "registry",
      "deploymentBlock",
      "directoryCodeHash",
    ]);
    insist(
      p.chainId === 6343 &&
        typeof p.deploymentBlock === "string" &&
        /^(0|[1-9][0-9]{0,18})$/.test(p.deploymentBlock),
      "invalid_directory_profile",
      503,
    );
    return {
      kind: "historical" as const,
      chainId: 6343 as const,
      communityId: bytes32(p.communityId),
      directory: address(p.directory),
      registry: address(p.registry),
      deploymentBlock: BigInt(p.deploymentBlock),
      directoryCodeHash: bytes32(p.directoryCodeHash),
    };
  });
  const serviceOrigin = httpsOrigin(env.SERVICE_ORIGIN);
  insist(
    pairings.every((p) => p.serviceOrigin === serviceOrigin) &&
      new Set(profiles.map((p) => p.communityId)).size === profiles.length,
    "invalid_directory_profiles",
    503,
  );
  const client = createPublicClient({
    chain,
    transport: http(chain.rpcUrls.default.http[0], {
      retryCount: 0,
      timeout: 15000,
      fetchOptions: { redirect: "manual" },
    }),
  });
  return {
    serviceOrigin,
    pairings,
    serviceRequestCap: integer(Number(env.SERVICE_REQUEST_CAP), 1, 100),
    serviceBudgetPeriod: text(env.SERVICE_BUDGET_PERIOD, 64),
    acr: {
      host: env.ACRCLOUD_HOST,
      accessKey: env.ACRCLOUD_ACCESS_KEY,
      accessSecret: env.ACRCLOUD_ACCESS_SECRET,
    },
    openAiKey: env.OPENAI_API_KEY,
    signer: privateKeyToAccount(
      env.MODERATION_SIGNER_PRIVATE_KEY as `0x${string}`,
    ),
    async currentConfiguration(pairing) {
      const profile = profiles.find(
        (p) => p.communityId === pairing.communityId,
      );
      insist(profile, "unpaired_directory_profile", 503);
      if (profile.kind === "web2") {
        const deployment = profile.deployment, directory = parseWeb2ProfileDocument(deployment.directoryProfile);
        insist(isWeb2Pairing(pairing) && directory.directory === pairing.directory &&
          directory.communityKey === pairing.communityKey && directory.installationId === pairing.installationId &&
          deployment.origin === pairing.communityOrigin && deployment.managedOrigin === serviceOrigin,
          "unpaired_directory_profile", 503);
        const web2Client = createPublicClient({chain, transport: http(deployment.rpcUrl,
          {retryCount: 0, timeout: 15000, fetchOptions: {redirect: "manual"}})});
        const read = await readWeb2Community(web2Client, directory,
          {now: () => BigInt(Math.floor(Date.now()/1000)), maxSafeBlockAgeSeconds: BigInt(deployment.freshness.maxSafeBlockAgeSeconds)},
          communityIpfsTransport(deployment));
        insist(read.eligibility.status === "available", "community_authority_unavailable", 503);
        return read.config;
      }
      insist(
        !isWeb2Pairing(pairing) &&
          profile.registry === pairing.registry &&
          profile.directory === pairing.directory,
        "unpaired_directory_profile",
        503,
      );
      return readConfiguration(client, profile);
    },
    async wake(admissionId) {
      await env.JOBS.send({ admissionId });
    },
    ownerGrant: ownerGrant(env),
  };
}
export default {
  async fetch(request, env) {
    try {
      const config = configuration(env);
      const url = new URL(request.url);
      if (url.pathname === "/v1/curated/adopt") {
        insist(
          request.method === "POST" &&
            url.origin === config.serviceOrigin &&
            !url.search &&
            env.RELEASE_GRANT_JSON,
          "not_found",
          404,
        );
        const input = await jsonBody(request, 256 * 1024);
        exact(input, ["signed", "result"]);
        const a = object(object(input.signed).amendment),
          pairing = config.pairings.find(
            (p) => p.communityId === a.communityId && p.enabled,
          );
        insist(
          pairing && request.headers.get("origin") === pairing.communityOrigin,
          "unpaired_curated_adoption",
          403,
        );
        const current = await config.currentConfiguration(pairing),
          grant = validateReleaseGrant(JSON.parse(env.RELEASE_GRANT_JSON));
        return Response.json(
          await adoptCuratedAdmission(
            env.DB,
            input.signed,
            input.result,
            current,
            grant,
          ),
          { headers: { "cache-control": "no-store" } },
        );
      }
      if (url.pathname.startsWith("/v1/owner-releases/")) {
        insist(
          config.ownerGrant && env.FILEBASE_IPFS_TOKEN,
          "owner_release_unavailable",
          503,
        );
        return ownerReleaseFetch(request, env.DB, env.MEDIA, {
          admissionGate:env.WEB2_PUBLISHING_SELECTION_SHA256 ? (env.MANAGED_ADMISSION_GATE ?? unavailableAdmissionGate) : env.MANAGED_ADMISSION_GATE,
          origin: config.serviceOrigin,
          ownerGrant: config.ownerGrant,
          pairings: config.pairings,
          currentConfiguration: config.currentConfiguration,
          filebaseCredential: env.FILEBASE_IPFS_TOKEN,
          pinTransport: env.PIN_TRANSPORT,
          acrEndpoint: acrEndpoint(config.acr.host),
          catalog: env.CATALOG_RELEASE_INPUTS ?? (()=>{
            const client=(id:string)=>{
              const pairing=config.pairings.find(p=>p.communityId===id&&p.enabled);
              insist(pairing,"canonical_community_unconfigured",503);
              const selected=(JSON.parse(env.DIRECTORY_PROFILES_JSON) as unknown[]).map(v=>object(v)).find(v=>
                v.schema==="pirate.community-deployment/2"&&object(v.directoryProfile).communityId===id);
              insist(selected,"canonical_deployment_unconfigured",503);
              const deployment=validateCommunityDeploymentProfile(selected);
              const chainClient = megaethReadClient(undefined,deployment.rpcUrl);
              return canonicalCommunityClient({signer:config.signer,
                chain:{client:chainClient,ownerVerification:isWeb2Deployment(deployment) ? {client:chainClient,currentConfiguration:()=>config.currentConfiguration(pairing),
                  now:()=>Math.floor(Date.now()/1000),maxSafeBlockAgeSeconds:BigInt(deployment.freshness.maxSafeBlockAgeSeconds)} : undefined,
                  posts:{...deployment.posts,deploymentBlock:BigInt(deployment.posts.deploymentBlock)},ipfs:communityIpfsTransport(deployment)},
                currentConfiguration:()=>config.currentConfiguration(pairing),transport:env.CATALOG_CANONICAL_TRANSPORT});
            };
            return {canonical:async(id:string)=>client(id),recognition:async(id:string)=>({ready:client(id).ready})};
          })(),
        });
      }
      if (url.pathname.startsWith("/v1/releases/")) {
        insist(
          env.RELEASE_GRANT_JSON &&
            env.FILEBASE_IPFS_TOKEN &&
            /^0x[0-9a-fA-F]{64}$/.test(
              env.REGISTRATION_OPERATOR_PRIVATE_KEY ?? "",
            ),
          "release_service_unavailable",
          503,
        );
        return releaseFetch(request, env.DB, env.MEDIA, {
          origin: config.serviceOrigin,
          grant: JSON.parse(env.RELEASE_GRANT_JSON),
          pairings: config.pairings,
          currentConfiguration: async pairing => {
            insist(!isWeb2Pairing(pairing), "historical_registered_release_profile_required", 503);
            const current = await config.currentConfiguration(pairing);
            insist(current.schema !== "pirate.community-config/4", "historical_registered_release_profile_required", 503);
            return current;
          },
          filebaseCredential: env.FILEBASE_IPFS_TOKEN,
          registrationSigner: privateKeyToAccount(
            env.REGISTRATION_OPERATOR_PRIVATE_KEY as `0x${string}`,
          ),
          registrationClient: storyReadClient(),
          acrEndpoint: acrEndpoint(config.acr.host),
        });
      }
      const response = await managedFetch(request, env.DB, config);
      if (new URL(request.url).pathname === "/health" && response.ok) {
        let release: {
          configured: boolean;
          grantSha256?: string;
          registrationOperator?: string;
          expiresAt?: number;
        } = { configured: false };
        try {
          const grant = validateReleaseGrant(
            JSON.parse(env.RELEASE_GRANT_JSON ?? "null"),
          );
          const signer = privateKeyToAccount(
            env.REGISTRATION_OPERATOR_PRIVATE_KEY as `0x${string}`,
          );
          if (
            env.FILEBASE_IPFS_TOKEN &&
            signer.address.toLowerCase() === grant.registration.operator &&
            grant.expiresAt > Math.floor(Date.now() / 1000)
          )
            release = {
              configured: true,
              grantSha256: grant.sha256,
              registrationOperator: grant.registration.operator,
              expiresAt: grant.expiresAt,
            };
        } catch {
          /* Moderation health remains distinct from release configuration. */
        }
        if(env.WEB2_PUBLISHING_SELECTION_SHA256 && (!config.ownerGrant ||
          request.headers.get("x-pirate-community")!==config.ownerGrant.communityId || request.headers.get("x-pirate-owner-grant")!==config.ownerGrant.sha256))
          return Response.json({error:"managed_health_scope_mismatch"},{status:403,headers:{"cache-control":"no-store"}});
        const owner = config.ownerGrant,
          ownerRelease =
            owner &&
            env.FILEBASE_IPFS_TOKEN &&
            (!env.WEB2_PUBLISHING_SELECTION_SHA256 || env.MANAGED_ADMISSION_GATE) &&
            owner.validFrom <= Math.floor(Date.now()/1000) && owner.expiresAt > Math.floor(Date.now() / 1000) &&
            ((!env.WEB2_PUBLISHING_SELECTION_SHA256 && !env.OWNER_GRANT_ADMISSION_REFERENCE) ||
              (/^0x[0-9a-f]{64}$/.test(env.WEB2_PUBLISHING_SELECTION_SHA256 ?? "") && env.OWNER_GRANT_ADMISSION_REFERENCE))
              ? {
                  configured: true,
                  grantSha256: owner.sha256,
                  ...(env.WEB2_PUBLISHING_SELECTION_SHA256 ? {selectionDigest:env.WEB2_PUBLISHING_SELECTION_SHA256,admissionReference:env.OWNER_GRANT_ADMISSION_REFERENCE} : {}),
                  expiresAt: owner.expiresAt,
                }
              : { configured: false };

        return Response.json(
          {
            service: "pirate-managed-moderation/1",
            status: "available",
            profileHash: bytes32(env.SERVICE_PROFILE_HASH),
            release,
            ownerRelease,
          },
          { headers: { "cache-control": "no-store" } },
        );
      }
      return response;
    } catch {
      return Response.json(
        { error: "service_configuration_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  },
  async queue(batch, env) {
    const config = configuration(env);
    for (const message of batch.messages) {
      try {
        const state = await runAdmission(
          env.DB,
          env.MEDIA,
          message.body.admissionId,
          config,
        );
        console.log(
          JSON.stringify({
            event: "managed_admission",
            admissionId: message.body.admissionId,
            state,
          }),
        );
        message.ack();
      } catch {
        // The durable journal decides whether a provider can run; Queue retry
        // only wakes reconciliation and cannot authorize another purchase.
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_event, env) {
    await recoverAdmissions(env.DB, configuration(env).wake);
  },
} satisfies ExportedHandler<ManagedEnv, { admissionId: string }>;
