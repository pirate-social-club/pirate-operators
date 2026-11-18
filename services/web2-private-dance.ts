import { syncPublicPosts } from "../packages/community/post-index.ts";
import { canonical, hashJson, insist } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { createPrivatePracticeDance, type PrivateMediaJob } from "./community-private-dance.ts";
import type { CommunityEnv } from "./community-application.ts";
import type { PublicReadPorts } from "./community-public.ts";
import type { DancePrivatePolicyV2 } from "./dance-private-catalogue.ts";
import { communityPrivatePractice } from "./community-private-practice.ts";
import { readCommunityDeploymentProfile } from "./community-deployment-profile.ts";
import { dancePublicationMediaAccess } from "./dance-publication-media-access.ts";

export async function selectedWeb2Dance(
  env: CommunityEnv,
  config: CommunityConfig,
  reads: PublicReadPorts,
  readCurrent: () => Promise<CommunityConfig>,
) {
  const original = env.COMMUNITY_DEPLOYMENT_PROFILE_JSON;
  const selection = env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON;
  const document = env.PRIVATE_DANCE_POLICY_JSON;
  const renderer = env.PRIVATE_DANCE_RENDERER;
  insist(original && document && renderer && typeof renderer.fetch === "function",
    "dance_private_runtime_unavailable", 503);
  const deployment = readCommunityDeploymentProfile(original);
  const profile = communityPrivatePractice(env, deployment);
  const policy = JSON.parse(document) as DancePrivatePolicyV2;
  insist(profile?.activities.dance?.policyHash === hashJson(policy),
    "dance_private_selection_changed", 503);
  const configBytes = canonical(config);
  const db = env.DB, bucket = env.MEDIA, jobs = env.JOBS;
  let lost = false;
  function checkSelection() {
    if (env.COMMUNITY_DEPLOYMENT_PROFILE_JSON !== original ||
        env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON !== selection ||
        env.PRIVATE_DANCE_POLICY_JSON !== document || env.PRIVATE_DANCE_RENDERER !== renderer ||
        env.DB !== db || env.MEDIA !== bucket || env.JOBS !== jobs || canonical(config) !== configBytes) lost = true;
    insist(!lost, "dance_private_selection_changed", 409);
  }
  async function current() {
    checkSelection();
    const fresh = await readCurrent();
    checkSelection();
    if (canonical(fresh) !== configBytes) lost = true;
    insist(!lost, "dance_private_selection_changed", 409);
    const row = await db.prepare("SELECT body_json FROM dance_host_context WHERE community_id=?")
      .bind(config.communityId).first<{body_json:string}>();
    checkSelection();
    if (row?.body_json !== canonical(policy)) lost = true;
    insist(!lost, "dance_private_policy_changed", 409);
  }
  await current();
  checkSelection();
  const history = reads.configurationHistory ? [...await reads.configurationHistory()] : [config];
  checkSelection();
  const scan = await syncPublicPosts(db, reads.client, reads.profile, history, config, reads.transport);
  checkSelection();
  insist(scan.caughtUp, "dance_publication_index_pending", 503);
  await current();
  checkSelection();
  const selectedPublication = env.WEB2_DANCE_PUBLICATION_INPUTS;
  const publicationV2 = selectedPublication?.publication.db === db &&
    config.schema === "pirate.community-config/4" ?
      dancePublicationMediaAccess(selectedPublication, config, reads, () => {
        checkSelection();
        insist(env.WEB2_DANCE_PUBLICATION_INPUTS === selectedPublication, "dance_publication_source_changed", 409);
      }) : undefined;
  return createPrivatePracticeDance({ db, bucket, config, reads, policy, renderer, current, publicationV2,
    enqueue: async (job:PrivateMediaJob) => { await current(); checkSelection(); await jobs.send(job); checkSelection(); } });
}
