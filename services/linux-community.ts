import {
  communityFetch, communityQueue, communityScheduled,
  type CommunityEnv,
} from "./community-application.ts";
import { readCommunityDeploymentProfile, type CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import type { CommunityQueueJob } from "./community-private-dance.ts";

export interface LinuxCommunityEnv extends CommunityEnv {
  COMMUNITY_DEPLOYMENT_PROFILE_JSON: string;
}

/** Explicit Linux composition. Missing/invalid server inputs never select First Song. */
export default {
  async fetch(request, env) {
    let deployment: CommunityDeploymentProfile;
    try {
      deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON);
    } catch {
      return Response.json({ error: "community_deployment_unconfigured" }, {
        status: 503, headers: { "cache-control": "no-store" },
      });
    }
    return await communityFetch(request, env, undefined, deployment);
  },
  async queue(batch, env) {
    const deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON);
    await communityQueue(batch, env, undefined, deployment);
  },
  async scheduled(_event, env) {
    const deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON);
    await communityScheduled(env, undefined, deployment);
  },
} satisfies ExportedHandler<LinuxCommunityEnv, CommunityQueueJob>;
