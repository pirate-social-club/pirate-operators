import { nativeApplicationOriginal, web2ApplicationOriginal } from "./application-native-readback.ts";
import {
  communityFetch, communityQueue, communityScheduled,
  type CommunityEnv,
} from "./community-application.ts";
import { readCommunityDeploymentProfile, isWeb2Deployment, type CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import { canonical, insist } from "../packages/community/common.ts";
import type { CommunityQueueJob } from "./community-private-dance.ts";

export interface LinuxCommunityEnv extends CommunityEnv {
  COMMUNITY_DEPLOYMENT_PROFILE_JSON: string;
}
async function installedOriginal(env:LinuxCommunityEnv,deployment:CommunityDeploymentProfile){
  if(isWeb2Deployment(deployment)){
    const original=await web2ApplicationOriginal(env);
    insist(canonical(original.record.body.draft.deployment)===canonical(deployment),"web2_native_deployment_changed",503);
  }else await nativeApplicationOriginal(env);
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
    await installedOriginal(env,deployment);
    return await communityFetch(request, env);
  },
  async queue(batch, env) {
    const deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON);
    if(isWeb2Deployment(deployment))await installedOriginal(env,deployment);
    await communityQueue(batch, env);
  },
  async scheduled(_event, env) {
    const deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON);
    if(isWeb2Deployment(deployment))await installedOriginal(env,deployment);
    await communityScheduled(env);
  },
} satisfies ExportedHandler<LinuxCommunityEnv, CommunityQueueJob>;
