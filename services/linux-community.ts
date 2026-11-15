import { nativeApplicationOriginal, web2ApplicationOriginal } from "./application-native-readback.ts";
import {
  communityFetch, communityQueue, communityScheduled,
  type CommunityEnv,
} from "./community-application.ts";
import { readCommunityDeploymentProfile, isWeb2Deployment, type CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import { canonical, insist } from "../packages/community/common.ts";
import type { CommunityQueueJob } from "./community-private-dance.ts";
import {nativeDigest} from "../packages/community/native-business-binding.ts";

export interface LinuxCommunityEnv extends CommunityEnv {
  COMMUNITY_DEPLOYMENT_PROFILE_JSON: string;
}
async function installedOriginal(env:LinuxCommunityEnv,deployment:CommunityDeploymentProfile){
  if(isWeb2Deployment(deployment)){
    const original=await web2ApplicationOriginal(env);
    insist(canonical(original.record.body.draft.deployment)===canonical(deployment),"web2_native_deployment_changed",503);
    const digest=nativeDigest(original),communityId=deployment.directoryProfile.communityId,origin=deployment.origin;
    return {...env,async CATALOG_ACCOUNT_FENCE(accountId:string,wallet:string,authorId:string){
      const row=await env.DB.withSession("first-primary").prepare(`SELECT a.account_id
        FROM community_accounts a JOIN credential_bindings b ON b.account_id=a.account_id
        JOIN application_identity i ON i.id=1 AND i.community_id=? AND i.community_origin=?
        JOIN native_application_original o ON o.singleton=1 AND o.original_digest=?
        WHERE a.account_id=? AND a.author_id=? AND b.namespace='moss' AND b.network=6343 AND b.subject=?`)
        .bind(communityId,origin,digest,accountId,authorId,wallet).first();
      insist(row,"owner_account_fence_changed",403);
    }};
  }
  await nativeApplicationOriginal(env);return env;
}

/** Explicit Linux composition. Missing/invalid server inputs never select First Song. */
export default {
  async fetch(request:Request, env:LinuxCommunityEnv) {
    let deployment: CommunityDeploymentProfile;
    try {
      deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON);
    } catch {
      return Response.json({ error: "community_deployment_unconfigured" }, {
        status: 503, headers: { "cache-control": "no-store" },
      });
    }
    const bound=await installedOriginal(env,deployment);
    return await communityFetch(request, bound);
  },
  async queue(batch, env) {
    const deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON);
    const bound=isWeb2Deployment(deployment)?await installedOriginal(env,deployment):env;
    await communityQueue(batch, bound);
  },
  async scheduled(_event, env) {
    const deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON);
    const bound=isWeb2Deployment(deployment)?await installedOriginal(env,deployment):env;
    await communityScheduled(bound);
  },
} satisfies ExportedHandler<LinuxCommunityEnv, CommunityQueueJob>;
