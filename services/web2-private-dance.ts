import { syncPublicPosts } from "../packages/community/post-index.ts";
import { canonical, hashJson, insist } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { createPrivatePracticeDance, type PrivateMediaJob } from "./community-private-dance.ts";
import type { CommunityEnv } from "./community-application.ts";
import type { PublicReadPorts } from "./community-public.ts";
import type { DancePrivatePolicyV2 } from "./dance-private-catalogue.ts";
import { web2ApplicationOriginal } from "./application-native-readback.ts";
import { reuseNativePublicationApplication } from "./linux-web2-publication.ts";
import type { InstalledPublicDanceMount } from "./web2-installed-public-dance.ts";
import { assertInstalledRewardDanceSource } from "./web2-installed-dance-song.ts";
import { assertInstalledDanceRewardConfiguration, installedDanceOfferForSong, readInstalledDanceRewardAttachment } from "./web2-installed-dance-rewards.ts";
import { communityPrivatePractice } from "./community-private-practice.ts";
import { isWeb2Deployment, readCommunityDeploymentProfile } from "./community-deployment-profile.ts";
import { dancePublicationMediaAccess } from "./dance-publication-media-access.ts";

export async function selectedWeb2Dance(
  env: CommunityEnv,
  config: CommunityConfig,
  reads: PublicReadPorts,
  readCurrent: () => Promise<CommunityConfig>,
  openNative?: () => Promise<InstalledPublicDanceMount | undefined>,
) {
  const original = env.COMMUNITY_DEPLOYMENT_PROFILE_JSON;
  const selection = env.COMMUNITY_PRIVATE_PRACTICE_PROFILE_JSON;
  const document = env.PRIVATE_DANCE_POLICY_JSON;
  const renderer = env.PRIVATE_DANCE_RENDERER;
  const attachment = env.WEB2_DANCE_REWARD_ATTACHMENT_JSON;
  const publicationMount = env.PUBLICATION_NATIVE_MOUNT_JSON;
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
        env.WEB2_DANCE_REWARD_ATTACHMENT_JSON !== attachment || env.PUBLICATION_NATIVE_MOUNT_JSON !== publicationMount ||
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
  const inProcessPublication = env.WEB2_DANCE_PUBLICATION_INPUTS;
  function checkPublicationSelection() {
    checkSelection();
    insist(env.WEB2_DANCE_PUBLICATION_INPUTS === inProcessPublication, "dance_publication_source_changed", 409);
  }
  let native: InstalledPublicDanceMount | undefined;
  const publicationSource = openNative && attachment !== undefined ? {
    db,
    async open() {
      checkPublicationSelection();
      insist(!inProcessPublication, "dance_publication_source_changed", 503);
      native = await openNative();
      insist(native, "dance_installed_authority_unavailable", 503);
      await native.assertCurrent();
      checkPublicationSelection();
      return native.selection;
    },
  } : attachment === undefined ? inProcessPublication : undefined;
  // The lazy authority is consumed only for an authenticated, stored
  // publication-bound take. The owner’s regular private replay takes no path
  // through a rewards, moderator or publication grant dependency.
  const publicationV2 = publicationSource && config.schema === "pirate.community-config/4" &&
    (!("publication" in publicationSource) || publicationSource.publication.db === db) ?
      dancePublicationMediaAccess(publicationSource, config, reads, async () => {
        if (native) await native.assertCurrent();
        checkPublicationSelection();
      }) : undefined;
  const installedOffer = attachment === undefined ? undefined : async (songKey: string, now: number) => {
    await current();
    if (!openNative || !publicationV2) return null;
    // Discovery advertises only an available confirmed pair. An unbound
    // session can still read its ordinary practice choices while it enrolls.
    const offered = await openNative().catch(() => undefined);
    if (!offered?.selection.participants) return null;
    const selectedPublication = offered.selection;
    insist(isWeb2Deployment(deployment), "dance_reward_attachment_unverified", 503);
    const original = await web2ApplicationOriginal(env);
    const installed = await readInstalledDanceRewardAttachment(env, original, deployment);
    checkSelection();
    insist(installed, "dance_reward_attachment_unverified", 503);
    assertInstalledDanceRewardConfiguration(installed, config);
    assertInstalledRewardDanceSource(installed, selectedPublication.source);
    await reuseNativePublicationApplication(env, deployment, selectedPublication.publication);
    const offer = await installedDanceOfferForSong(db, installed, songKey, now);
    await offered.assertCurrent();
    checkPublicationSelection();
    return offer;
  };
  return createPrivatePracticeDance({ db, bucket, config, reads, policy, renderer, current, publicationV2, installedOffer,
    enqueue: async (job:PrivateMediaJob) => { await current(); checkSelection(); await jobs.send(job); checkSelection(); } });
}
