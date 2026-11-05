import { privateKeyToAccount } from "viem/accounts";
import { insist, jsonBody } from "../packages/community/common.ts";
import { address } from "../packages/community/manifest-core.ts";
import { megaethReadClient } from "../packages/community/chain.ts";
import { storyReadClient } from "../packages/community/registration-chain.ts";
import { creatorServiceOrigin } from "../packages/community/creator-receipt.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { FirstSongDriverPorts } from "./first-song-driver.ts";
import { firstSong } from "./first-song-profile.ts";

export interface FirstSongRuntimeEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  COMMUNITY_PUBLISHER_PRIVATE_KEY: string;
  CREATOR_PROFILE_HASH: string;
  MANAGED_PROFILE_HASH: string;
  RELEASE_GRANT_HASH: string;
  REGISTRATION_OPERATOR_ADDRESS: string;
  POSTING_EXPIRES_AT: string;
}
export async function managedReleaseConfigured(env: FirstSongRuntimeEnv) {
  try {
    const response = await fetch(firstSong.managedOrigin + "/health", {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      }),
      body = await jsonBody(response),
      release = body.release as Record<string, unknown> | undefined;
    return (
      response.ok &&
      body.profileHash === env.MANAGED_PROFILE_HASH &&
      release?.configured === true &&
      release.grantSha256 === env.RELEASE_GRANT_HASH &&
      release.registrationOperator === env.REGISTRATION_OPERATOR_ADDRESS
    );
  } catch {
    return false;
  }
}
export function publicPostsProfile() {
  return {
    ...firstSong.posts,
    deploymentBlock: BigInt(firstSong.posts.deploymentBlock),
  };
}
export function firstSongRuntime(
  env: FirstSongRuntimeEnv,
  configuration: CommunityConfig,
  currentConfiguration: () => Promise<CommunityConfig>,
): FirstSongDriverPorts {
  insist(
    /^0x[0-9a-fA-F]{64}$/.test(env.COMMUNITY_PUBLISHER_PRIVATE_KEY) &&
      /^0x[0-9a-f]{64}$/.test(env.RELEASE_GRANT_HASH),
    "release_runtime_unconfigured",
    503,
  );
  const publisher = privateKeyToAccount(
      env.COMMUNITY_PUBLISHER_PRIVATE_KEY as `0x${string}`,
    ),
    client = megaethReadClient(),
    story = storyReadClient(),
    managed = { origin: firstSong.managedOrigin, publisher, configuration },
    expiresAt = Number(env.POSTING_EXPIRES_AT);
  insist(
    Number.isSafeInteger(expiresAt) && expiresAt > 0,
    "release_runtime_unconfigured",
    503,
  );
  return {
    db: env.DB,
    media: env.MEDIA,
    managed,
    release: {
      client: managed,
      grantHash: env.RELEASE_GRANT_HASH,
      registrationOperator: address(env.REGISTRATION_OPERATOR_ADDRESS),
      story,
    },
    posting: {
      db: env.DB,
      client,
      publisher,
      profile: publicPostsProfile(),
      config: configuration,
      currentConfiguration,
      bounds: {
        period: "first-song-20261105-v1",
        maximumGas: "1000000",
        maximumGasPrice: "30000000",
        maximumTotalFee: "30000000000000",
        expiresAt,
      },
    },
    acrEndpoint: "https://identify-eu-west-1.acrcloud.com/v1/identify",
    async checkServices() {
      const native = await fetch(creatorServiceOrigin + "/api/health", {
          redirect: "manual",
          signal: AbortSignal.timeout(15000),
        }),
        status = await jsonBody(native);
      insist(
        native.ok &&
          status.profileHash === env.CREATOR_PROFILE_HASH &&
          status.testnet === true &&
          (await managedReleaseConfigured(env)),
        "release_service_unavailable",
        503,
      );
    },
  };
}
