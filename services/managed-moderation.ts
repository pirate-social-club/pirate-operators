import { createPublicClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  bytes32,
  exact,
  insist,
  integer,
  jsonBody,
  object,
  text,
} from "../packages/community/common.ts";
import { address, httpsOrigin } from "../packages/community/manifest-core.ts";
import { readConfiguration } from "../packages/community/directory-reader.ts";
import { managedPairings } from "../packages/moderation/pairing.ts";
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
export interface ManagedEnv {
  CATALOG_RELEASE_INPUTS?: CatalogOwnerReleaseInputs;
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
      insist(
        profile &&
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
          origin: config.serviceOrigin,
          ownerGrant: config.ownerGrant,
          pairings: config.pairings,
          currentConfiguration: config.currentConfiguration,
          filebaseCredential: env.FILEBASE_IPFS_TOKEN,
          acrEndpoint: acrEndpoint(config.acr.host),
          catalog: env.CATALOG_RELEASE_INPUTS,
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
          currentConfiguration: config.currentConfiguration,
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
        const owner = config.ownerGrant,
          ownerRelease =
            owner &&
            env.FILEBASE_IPFS_TOKEN &&
            owner.expiresAt > Math.floor(Date.now() / 1000)
              ? {
                  configured: true,
                  grantSha256: owner.sha256,
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
