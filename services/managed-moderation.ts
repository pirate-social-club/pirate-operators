import { contentProfile } from "../packages/moderation/content-profile.ts";
import { createPublicClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  bytes32,
  exact,
  insist,
  integer,
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

export interface ManagedEnv {
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
  SERVICE_CHECKS: "recognition" | "content";
  CONTENT_PROFILE_JSON: string;
  MODERATION_SIGNER_PRIVATE_KEY: string;
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
  insist(
    env.SERVICE_CHECKS === "recognition" || env.SERVICE_CHECKS === "content",
    "service_checks_required",
    503,
  );
  return {
    mode: env.SERVICE_CHECKS,
    contentProfile: contentProfile(JSON.parse(env.CONTENT_PROFILE_JSON)),
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
  };
}
export default {
  async fetch(request, env) {
    try {
      const config = configuration(env);
      const response = await managedFetch(request, env.DB, config);
      if (new URL(request.url).pathname === "/health" && response.ok) {
        return Response.json(
          {
            service: "pirate-admission-service/2",
            status: "available",
            profileHash: bytes32(env.SERVICE_PROFILE_HASH),
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
