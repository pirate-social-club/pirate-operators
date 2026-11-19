import { trustedWeb2PublicationReadbackPath } from "../packages/community/web2-trusted-publication.ts";
import { nativePublicationLookupFetch, nativePublicationSelectionReadback } from "./linux-web2-publication.ts";
import { publicationLookupPath } from "./native-publication-reference.ts";
import { nativePostsDispatchReadyPath, nativePostsQuoteReadyPath } from "./native-posts-publication.ts";
import { nativeDanceDispatchReadyPath, nativeDanceReadyPath } from "./native-dance-retained-reference.ts";
import { installedNativeDanceOriginals, installedNativeDanceReadyFetch } from "./linux-web2-dance-retained-transport.ts";
import { installedNativeDanceDispatchReadyFetch } from "./linux-web2-dance-dispatch.ts";
import { nativeApplicationOriginal, web2ApplicationOriginal } from "./application-native-readback.ts";
import {
  communityFetch, communityQueue, communityScheduled, installedDanceActionRevalidator, protectedPostsConfigurationReader,
  web2PrivateDanceHostPorts, type CommunityEnv, type InstalledProtectedFirstSong,
} from "./community-application.ts";
import { readCommunityDeploymentProfile, isWeb2Deployment, type CommunityDeploymentProfile,
  type Web2CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { firstSongDriver } from "./first-song-driver.ts";
import { protectedOwnerSongRuntime } from "./first-song-runtime.ts";
import { bindInstalledProtectedPosts, hasProtectedPostsBindings, protectedPostsPrimaryFetch } from "./linux-web2-protected-posts.ts";
import { canonical, insist } from "../packages/community/common.ts";
import type { CommunityQueueJob } from "./community-private-dance.ts";
import {nativeDigest} from "../packages/community/native-business-binding.ts";
import type { DanceV2OriginalLookup } from "./dance-v2-action-recovery.ts";
import { linuxWeb2DanceOwnerScopeReader } from "./linux-web2-dance-owner-scope.ts";

import { linuxWeb2KaraokeUpgrade, type NativeKaraokeSocketEnv } from "./linux-web2-karaoke-upgrade.ts";
import { danceHostPrefix, nativeDanceAuthority, type NativeDanceEnv } from "./linux-web2-dance-authority.ts";

import { nativePostsCustodyPath } from "../packages/community/native-posts-custody.ts";
import { bindNativePostsCustody, nativePostsCustody, type NativePostsEnv } from "./linux-web2-posts-custody.ts";

export interface LinuxCommunityEnv extends CommunityEnv, NativeKaraokeSocketEnv, NativeDanceEnv, NativePostsEnv {
  COMMUNITY_DEPLOYMENT_PROFILE_JSON: string;
  WEB2_DANCE_RETAINED_SCOPE_JSON?: string;
  WEB2_DANCE_V2_ORIGINALS?: DanceV2OriginalLookup;
}

function installedDanceScope(env: LinuxCommunityEnv) {
  const actionOriginals = env.WEB2_DANCE_V2_ORIGINALS ??
    (env.WEB2_DANCE_RETAINED_SCOPE_JSON === undefined ? undefined : installedNativeDanceOriginals(env));
  if (env.WEB2_DANCE_RETAINED_SCOPE_JSON === undefined && !actionOriginals) return undefined;
  return linuxWeb2DanceOwnerScopeReader({
    env, actionOriginals,
    readRecord: () => env.WEB2_DANCE_RETAINED_SCOPE_JSON,
    async readFreshConfiguration(deployment) {
      insist(canonical(readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON)) === canonical(deployment),
        "linux_web2_dance_retained_deployment_changed", 503);
      const config = await web2PrivateDanceHostPorts(env).current();
      insist(config.schema === "pirate.community-config/4", "linux_web2_dance_retained_configuration_changed", 503);
      return config;
    },
  });
}
async function installedOriginal(env:LinuxCommunityEnv,deployment:CommunityDeploymentProfile){
  if(isWeb2Deployment(deployment)){
    const original=await web2ApplicationOriginal(env);
    insist(canonical(original.record.body.draft.deployment)===canonical(deployment),"web2_native_deployment_changed",503);
    const digest=nativeDigest(original),communityId=deployment.directoryProfile.communityId,origin=deployment.origin;
    const postsFence = await bindNativePostsCustody(env, deployment, original);
    return {...env, ...(postsFence ? { LOCAL_POSTS_EFFECT_FENCE: postsFence } : {}),
      async CATALOG_ACCOUNT_FENCE(accountId:string,wallet:string,authorId:string){
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

async function openProtectedFirstSong(
  env: LinuxCommunityEnv, deployment: Web2CommunityDeploymentProfile,
  config: CommunityConfig, current: () => Promise<CommunityConfig>,
) {
  const original = await web2ApplicationOriginal(env);
  const mount = await bindInstalledProtectedPosts(env, original);
  insist(mount && canonical(original.record.body.draft.deployment) === canonical(deployment),
    "protected_posts_mount_unavailable", 503);
  const { runtime, configuration, maximumTotalFee, catalogReady, authorize } = protectedOwnerSongRuntime(
    env, config, current, deployment, mount,
  );
  const scope = mount.scope(env.DB, configuration, runtime.posting.ownerGrant, deployment.managedOrigin, maximumTotalFee);
  return { mount, runtime, scope, catalogReady, authorize };
}

function selectProtectedFirstSong(
  env: LinuxCommunityEnv, deployment: CommunityDeploymentProfile,
): InstalledProtectedFirstSong | undefined {
  if (!isWeb2Deployment(deployment) || !hasProtectedPostsBindings(env)) return;
  return {
    async runtime(config, current) {
      return (await openProtectedFirstSong(env, deployment, config, current)).runtime;
    },
    async canonical(config, current) {
      const { mount, authorize } = await openProtectedFirstSong(env, deployment, config, current);
      return {
        respond: mount.respond,
        authorize,
        async currentConfiguration() {
          const live = await current();
          mount.assertCurrent();
          return live;
        },
      };
    },
  };
}

/** Explicit Linux composition. Missing/invalid server inputs never select First Song. */
export default {
  async fetch(request:Request, env:LinuxCommunityEnv) {
    const path = new URL(request.url).pathname;
    if (path === trustedWeb2PublicationReadbackPath) return nativePublicationSelectionReadback(request, env);
    if (path === publicationLookupPath) return nativePublicationLookupFetch(request, env);
    if (path === nativeDanceReadyPath) return installedNativeDanceReadyFetch(request, env);
    if (path === nativeDanceDispatchReadyPath) return installedNativeDanceDispatchReadyFetch(
      request, env, installedDanceActionRevalidator(env, installedDanceScope(env), request.signal),
    );
    let deployment: CommunityDeploymentProfile;
    try {
      deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON);
    } catch {
      return Response.json({ error: "community_deployment_unconfigured" }, {
        status: 503, headers: { "cache-control": "no-store" },
      });
    }
    if (isWeb2Deployment(deployment) && new URL(request.url).pathname === nativePostsCustodyPath)
      return nativePostsCustody(request, env, deployment);
    if (path === nativePostsQuoteReadyPath || path === nativePostsDispatchReadyPath) {
      const reverse = env.WEB2_PROTECTED_POSTS_REVERSE_AUTH;
      if (!isWeb2Deployment(deployment) || !reverse || !/^[a-f0-9]{64}(?![\s\S])/.test(reverse))
        return protectedPostsPrimaryFetch(request, undefined);
      const selected = deployment;
      return protectedPostsPrimaryFetch(request, {
        origin: selected.origin, reverse,
        async open() {
          const bound = await installedOriginal(env, selected);
          const current = protectedPostsConfigurationReader(bound);
          const { mount, scope, runtime, catalogReady } = await openProtectedFirstSong(bound, selected, await current(), current);
          const driver = firstSongDriver(runtime);
          return {
            scope, assertCurrent: mount.assertCurrent,
            async revalidate(operation) {
              const { ownerExpiresAtMs } = await driver.revalidateProtectedPostsOwner(operation);
              return { ownerExpiresAtMs, catalogExpiresAtMs: await catalogReady(operation) };
            },
          };
        },
      });
    }
    const bound=await installedOriginal(env,deployment);
    if (isWeb2Deployment(deployment)) {
      const path = new URL(request.url).pathname;
      insist(new URL(request.url).origin === deployment.origin, "wrong_community_host", 403);
      if (path === "/attempt") {
        const original = await web2ApplicationOriginal(env);
        if (!original.record.body.draft.privatePractice?.includes("karaoke")) return new Response(null,{status:404});
        return linuxWeb2KaraokeUpgrade(request, bound, deployment);
      }
      if (path.startsWith(danceHostPrefix)) {
        const original = await web2ApplicationOriginal(env);
        if (!original.record.body.draft.privatePractice?.includes("dance")) return new Response(null,{status:404});
        return nativeDanceAuthority(request, bound, deployment);
      }
    }
    return await communityFetch(request, bound, undefined,
      isWeb2Deployment(deployment) ? installedDanceScope(bound) : undefined,
      selectProtectedFirstSong(bound, deployment));
  },
  async queue(batch, env) {
    const deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON);
    const bound=isWeb2Deployment(deployment)?await installedOriginal(env,deployment):env;
    await communityQueue(batch, bound, undefined,
      isWeb2Deployment(deployment) ? installedDanceScope(bound) : undefined,
      selectProtectedFirstSong(bound, deployment));
  },
  async scheduled(_event, env) {
    const deployment = readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON);
    const bound=isWeb2Deployment(deployment)?await installedOriginal(env,deployment):env;
    await communityScheduled(bound);
  },
} satisfies ExportedHandler<LinuxCommunityEnv, CommunityQueueJob>;
