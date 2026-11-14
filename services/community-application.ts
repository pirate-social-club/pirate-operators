import { nativeBusinessResponse } from "./application-native-readback.ts";
import { withKaraokeRequestSession } from "./karaoke-request-session.ts";
import { communityProfilesApi } from "./community-profiles.ts";
import { connectedPublicResultsAction } from "./learning-public-results.ts";
import {
  fenceAuthorityRelay,
  type AuthorityAction,
} from "../packages/community-setup/authority-ledger.ts";
import {
  recoverCommunityAuthority,
  type AuthorityRecoveryPorts,
} from "../packages/community-setup/authority-recovery.ts";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  accountSession,
  authenticatedWrite,
  ensureCommunityIdentity,
  loginChallenge,
  loginVerify,
  type VerifyLogin,
} from "../packages/community/accounts.ts";
import {
  bytes32,
  CommunityError,
  cookie,
  insist,
  jsonBody,
  requestOrigin,
  text,
} from "../packages/community/common.ts";
import { readConfigurationHistory } from "../packages/community/directory-reader.ts";
import { directoryHistoryCache } from "../packages/community/configuration-index.ts";
import { publicResultManifest } from "../packages/records/result-manifest.ts";
import { megaethReadClient } from "../packages/community/chain.ts";
import { RequestTiming } from "./request-timing.ts";
import { publicIpfsCache } from "./public-ipfs-cache.ts";
import {
  beginCreatorConnection,
  completeCreatorConnection,
  pendingCreatorConnection,
  type CreatorConnectionService,
} from "../packages/community/creator-connections.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type {
  CommunityCapabilities,
  CommunityClientConfig,
  CommunityFeed,
  CommunitySessionView,
} from "../packages/community/application-api.ts";
import { RELEASE_POLICY } from "../packages/community/manifest-core.ts";
import { readCommunityDeploymentProfile, communityIpfsTransport, type CommunityDeploymentProfile } from "./community-deployment-profile.ts";
import { firstSong } from "./first-song-profile.ts";
import { learningPolicyPage } from "./learning-policy-pages.ts";
import { learningV3Disclosure } from "./learning-policy-v3.ts";
import { learningV4Disclosure } from "./learning-policy-v4.ts";
import { configurationHealth } from "./configuration-health.ts";
import { serveInputCapability } from "../packages/community/input-capabilities.ts";
import { communityReleaseApi } from "./community-release-api.ts";
import { adoptCuratedPublication } from "../packages/community/adopt-curated.ts";
import {
  firstSongRuntime,
  publicPostsProfile,
  type FirstSongRuntimeEnv,
} from "./first-song-runtime.ts";
import {
  firstSongPublicReady,
  publicSongViews,
  publicSongResource,
  type PublicReadPorts,
} from "./community-public.ts";
import { runCommunityJob, recoverCommunityJobs } from "./community-jobs.ts";
import type { ProviderTransport } from "../packages/moderation/provider-http.ts";
import {
  instrumentalResponse,
  publishedKaraoke,
  runSongAlignment,
} from "./karaoke-song.ts";
import {
  karaokeAttempt,
  karaokeEnrollment,
  karaokeEnrollments,
  karaokeRevokeEnrollment,
  karaokeHistory,
  karaokeConsent,
  karaokePurchase,
  karaokeTicket,
  type KaraokeEnv,
} from "./karaoke-community.ts";
import { studyCommunityApi } from "./study-community-api.ts";
import { liveStudy, studyAvailable, type StudyEnv } from "./study-community.ts";
import {
  turnOffPublicResults,
  turnOnPublicResults,
  publicationSignInAtLogin,
} from "./learning-public-results.ts";
import {
  publicResults,
  relayPendingSignIns,
  signInV4,
  v4LearningRecords,
} from "./learning-sign-in.ts";
import { StudyError } from "../packages/study/contracts.ts";
import { recoverStudyLessons } from "./study-recovery.ts";
import { deleteExpiredStudyHistory } from "./study-retention.ts";
import {
  rewardsCommunityApi,
  type RewardsApiPorts,
} from "./rewards-community-api.ts";
import { rewardProfile } from "../packages/rewards/validation.ts";
import { rewardChain } from "../packages/rewards/chain.ts";
import { rewardVeryProvider } from "../packages/rewards/very-provider.ts";
import {
  liveRewardSources,
  resultSource,
  rewardResultSources,
} from "./reward-sources.ts";
import { selectedDanceRewardSource } from "../packages/dance-chain/source-selection.ts";
import type {
  CommunityPrivateDance,
  CommunityQueueJob,
} from "./community-private-dance.ts";
import { canonicalDanceRewardSource } from "./dance-reward-source.ts";
import { songKeyOf } from "../packages/protocol/records.ts";
import { reconcileRewardPayments } from "./reward-payment-recovery.ts";
import type { FirstSongDriverPorts } from "./first-song-driver.ts";
import {
  ownerCurated,
  ownerOnly,
} from "../packages/community/owner-policy.ts";
import { requireAuthorizedOwner } from "../packages/community/owner-authorization.ts";
import { confirmedRewardTimestamp } from "./reward-close-clock.ts";
import { requireCuratedOwner } from "../packages/community/curated-amendment.ts";
import { createDanceProductionDefaults, type DanceProductionRuntimeInputs } from "./dance-production-defaults.ts";

export interface CommunityEnv extends FirstSongRuntimeEnv, StudyEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  JOBS: Queue<CommunityQueueJob>;
  ASSETS: Fetcher;
  COMMUNITY_NAME: string;
  PLAN_ID: string;
  APPLICATION_PROFILE_HASH: string;
  /** Registered release policy only; owner-only publishing has no creator service. */
  CREATOR_PROFILE_HASH?: string;
  COMMUNITY_PUBLISHER_PRIVATE_KEY: string;
  /** Pirate's provider key for the one forced alignment per lyric revision. */
  ALIGNMENT_ELEVENLABS_API_KEY?: string;
  REWARDS_PROFILE_JSON?: string;
  REWARDS_RESULT_SOURCE_JSON?: string;
  /** Result sources appended after the original, in order; absent before V4. */
  REWARDS_RESULT_SUCCESSORS_JSON?: string;
  /** Set only by an admitted categorical release; the base rewards release has neither. */
  DANCE_REWARD_SOURCE_JSON?: string;
  DANCE_REWARD_SOURCE_SELECTION_HASH?: string;
  /** In-process Root composition only: NOT a deployable JSON/env permission.
   * Root must bind the reviewed actual producers after independent admission. */
  DANCE_PRODUCTION_INPUTS?: DanceProductionRuntimeInputs;
  COMMUNITY_DEPLOYMENT_PROFILE_JSON?: string;
  NATIVE_APPLICATION_ORIGINAL_JSON?: string;
  NATIVE_READBACK_KEY?: string;
}
export interface CommunityDependencies {
  deployment?: CommunityDeploymentProfile;
  /** Fresh canonical read for asynchronous publication fences; no request memo. */
  freshConfiguration?():Promise<CommunityConfig>;
  /** Required server-side connected composition: authenticate explicit action,
   * reconstruct account/wallet/scope/cutoff/nonce, compare predecessor, and
   * retain the same actionId across uncertain retries. Never trust body facts. */
  linkedAuthority?: {
    action(
      session: { account_id: string; wallet: string },
      body: Record<string, unknown>,
      kind: "off" | "on",
      now: number,
    ): Promise<AuthorityAction>;
    ports: AuthorityRecoveryPorts;
  };
  configuration(): Promise<CommunityConfig>;
  verifyLogin: VerifyLogin;
  creatorHealth(): Promise<boolean>;
  creatorTransport?: CreatorConnectionService["transport"];
  releaseRuntime?(config: CommunityConfig): FirstSongDriverPorts;
  publicReads?: PublicReadPorts;
  alignmentTransport?: ProviderTransport;
  now?: () => number;
  rewards?: Omit<RewardsApiPorts, "db" | "profile" | "now">;
  /** Admitted private Dance runtime. Absent until source, authority and renderer are selected. */
  privateDance?(config: CommunityConfig): CommunityPrivateDance | Promise<CommunityPrivateDance>;
}
export function communityPrivateDanceDefaults(env: CommunityEnv) {
  const factory = createDanceProductionDefaults({
    db: env.DB, bucket: env.MEDIA, enqueue: async job => { await env.JOBS.send(job); },
    selected: env.DANCE_PRODUCTION_INPUTS,
  });
  return async (config: CommunityConfig) => {
    if (env.DANCE_REWARD_SOURCE_JSON || env.DANCE_REWARD_SOURCE_SELECTION_HASH) {
      insist(env.DANCE_REWARD_SOURCE_JSON && env.DANCE_REWARD_SOURCE_SELECTION_HASH &&
        env.DANCE_PRODUCTION_INPUTS?.selectionHash === env.DANCE_REWARD_SOURCE_SELECTION_HASH,
        "dance_production_source_selection_changed", 503);
      selectedDanceRewardSource(env.DANCE_REWARD_SOURCE_JSON, env.DANCE_REWARD_SOURCE_SELECTION_HASH);
    }
    return factory(config);
  };
}
function deploymentProfile(env:CommunityEnv) {
  return env.COMMUNITY_DEPLOYMENT_PROFILE_JSON ? readCommunityDeploymentProfile(env.COMMUNITY_DEPLOYMENT_PROFILE_JSON) : firstSong;
}
function dependencies(
  env: CommunityEnv,
  timing = new RequestTiming(),
): CommunityDependencies {
  const deployment=deploymentProfile(env);
  const client = megaethReadClient((method, ms) =>
    timing.record(`rpc_${method}`, ms),deployment.rpcUrl
  );
  const content=communityIpfsTransport(deployment);
  const transport = (request: Request) =>
    timing.measure("ipfs", () => content(request));
  const directory = {
    ...deployment.directoryProfile,
    deploymentBlock: BigInt(deployment.directoryProfile.deploymentBlock),
  };
  // Both exact Directory ABIs retain their own closed authenticated reader.
  const readHistory=()=>{
    if("schema" in directory)return readConfigurationHistory(client,directory,transport,directoryHistoryCache(env.DB,client,directory));
    return readConfigurationHistory(client,directory,transport,directoryHistoryCache(env.DB,client,directory));
  };
  let history:Promise<CommunityConfig[]>|undefined;
  const configurationHistory=()=>history??=timing.measure("configuration",readHistory);
  return {
    deployment,
    freshConfiguration:async()=> (await readHistory()).at(-1)!,
    privateDance: communityPrivateDanceDefaults(env),
    async configuration() {
      return (await configurationHistory()).at(-1)!;
    },
    publicReads: {
      client,
      transport,
      profile: publicPostsProfile(deployment),
      contentCache: publicIpfsCache(env.MEDIA),
      configurationHistory,
      manifestAvailable: async (hash) => !!(await publicResultManifest(hash)),
    },
    async verifyLogin(address, proof, signature) {
      const client = megaethReadClient(undefined,deployment.rpcUrl);
      insist((await client.getChainId()) === deployment.directoryProfile.chainId, "wrong_moss_network", 503);
      // The plain and the V4 sign-in are both personal-sign texts; this
      // covers EOAs and ERC-1271/6492 smart accounts such as MOSS.
      return client.verifyMessage({ address, message: proof, signature });
    },
    async creatorHealth() {
      try {
        const response = await timing.measure("creator", () =>
            fetch(deployment.creatorOrigin + "/api/health", {
              redirect: "manual",
              signal: AbortSignal.timeout(15000),
            }),
          ),
          body = await jsonBody(response);
        return (
          response.ok &&
          body.profileHash === env.CREATOR_PROFILE_HASH &&
          body.testnet === true
        );
      } catch {
        return false;
      }
    },
  };
}
function headers(env: Pick<KaraokeEnv, "KARAOKE_OPERATOR_ORIGIN">) {
  // The learner's Karaoke socket connects to the operator's origin.
  let operatorSocket = "";
  try {
    if (env.KARAOKE_OPERATOR_ORIGIN) {
      const origin = new URL(env.KARAOKE_OPERATOR_ORIGIN);
      origin.protocol = origin.protocol === "http:" ? "ws:" : "wss:";
      operatorSocket = ` ${origin.origin}`;
    }
  } catch {
    /* An invalid origin leaves Karaoke without a socket, never the page. */
  }
  return new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin",
    "x-frame-options": "DENY",
    "permissions-policy":
      'publickey-credentials-create=(self "https://account.megaeth.com"), publickey-credentials-get=(self "https://account.megaeth.com")',
    "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' https://gateway.pinata.cloud; font-src 'self'; connect-src 'self' https://*.megaeth.com${operatorSocket}; frame-src https://*.megaeth.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
  });
}
export async function communityFetch(request:Request,env:CommunityEnv,provided?:CommunityDependencies):Promise<Response>{
  const actual=provided??dependencies(env);
  try {
    return await nativeBusinessResponse({request,env,
      configuration:actual.freshConfiguration??actual.configuration,
      privateDance:actual.privateDance,
      business:()=>communityFetchBusiness(request,env,actual)});
  } catch(error) {
    if(error instanceof CommunityError)return Response.json({error:error.code},{status:error.status,headers:{"cache-control":"no-store"}});
    throw error;
  }
}
async function communityFetchBusiness(
  request: Request,
  env: CommunityEnv,
  ports?: CommunityDependencies,
): Promise<Response> {
  const deployment=ports?.deployment??deploymentProfile(env);
  const timing = new RequestTiming();
  ports ??= dependencies(env, timing);
  const url = new URL(request.url),
    security = headers(env),
    reply = (value: unknown, status = 200) => {
      security.set("server-timing", timing.header());
      return Response.json(value, { status, headers: security });
    };
  try {
    insist(url.origin === deployment.origin, "wrong_community_host", 403);
    const policy = learningPolicyPage(
      url.pathname,
      !!env.STUDY_RESULTS_V4_CONTRACT,
    );
    if (policy) return policy;
    const context = {
      communityId: deployment.directoryProfile.communityId,
      origin: deployment.origin,
    };
    const publicReads = ports.publicReads ?? {
      client: megaethReadClient(),
      profile: publicPostsProfile(deployment),
    };
    const configuration = async () => {
      const config = await ports.configuration();
      insist(
        config.communityId === context.communityId &&
          config.app.origin === context.origin,
        "community_configuration_changed",
        503,
      );
      return config;
    };
    if (
      ports.privateDance &&
      (url.pathname === "/api/media" ||
        url.pathname.startsWith("/api/media/") ||
        url.pathname.startsWith("/api/dance/"))
    ) {
      const runtime = await ports.privateDance(await configuration());
      const response = await runtime.fetch(request, context, security);
      if (response) return response;
    }
    // Owner-only publishing has no creator connection; its service is never
    // contacted for status or capabilities under that policy.
    const creatorAvailable = async (known?: CommunityConfig) => {
      // A deployment carrying the owner grant never contacts the creator
      // service, before or after the owner policy is activated.
      if (env.OWNER_GRANT_JSON) return false;
      let config = known;
      if (!config)
        try {
          config = await configuration();
        } catch {
          // A registered deployment still reports its creator health
          // without the policy. Status only.
          return ports.creatorHealth();
        }
      return ownerOnly(config.policies.admission)
        ? false
        : ports.creatorHealth();
    };
    const ready = async () => {
      const config = await configuration();
      const runtime =
        ports.releaseRuntime?.(config) ??
        firstSongRuntime(env, config, ports.freshConfiguration??ports.configuration,deployment);
      await runtime.checkServices();
      return { config, ports: runtime };
    };
    // Display only: whether this account sees release controls. The release
    // API checks the same authority again before every reservation and seal.
    const sessionPublisher = async (accountId: string, wallet: string) => {
      try {
        const config = await configuration();
        if (ownerOnly(config.policies.admission)) {
          const runtime =
            ports.releaseRuntime?.(config) ??
            firstSongRuntime(env, config, ports.freshConfiguration??ports.configuration,deployment);
          await requireAuthorizedOwner(
            runtime.ownerAuthorization,
            config,
            wallet,
          );
          return true;
        }
        if (ownerCurated(config.policies.admission)) {
          await requireCuratedOwner(env.DB, config, wallet);
          return true;
        }
        // A registered release still needs an existing creator binding.
        return !!(await env.DB.prepare(
          "SELECT 1 FROM creator_bindings WHERE account_id=?",
        )
          .bind(accountId)
          .first());
      } catch {
        return false;
      }
    };
    if (
      url.pathname.startsWith("/api/rewards/") ||
      url.pathname.startsWith("/api/operator/rewards")
    ) {
      insist(env.REWARDS_PROFILE_JSON, "rewards_not_configured", 503);
      const profile = rewardProfile(env.REWARDS_PROFILE_JSON);
      const config = await configuration();
      const danceRaw = env.DANCE_REWARD_SOURCE_JSON;
      const danceHash = env.DANCE_REWARD_SOURCE_SELECTION_HASH;
      insist(
        !!danceRaw === !!danceHash &&
          (!danceRaw ||
            (profile.mode === "live-testnet" &&
              env.REWARDS_RESULT_SOURCE_JSON)),
        "dance_reward_source_unavailable",
        503,
      );
      const categorical =
        danceRaw && danceHash
          ? (() => {
              const source = selectedDanceRewardSource(danceRaw, danceHash);
              return new Map([
                [
                  source.sourceHash,
                  canonicalDanceRewardSource({
                    db: env.DB,
                    source,
                    reads: publicReads,
                    configuration: config,
                  }),
                ],
              ]);
            })()
          : undefined;
      const sources =
        ports.rewards?.sources ??
        (profile.mode === "live-testnet" && env.REWARDS_RESULT_SOURCE_JSON
          ? liveRewardSources({
              db: env.DB,
              profile,
              sources: rewardResultSources(
                resultSource(env.REWARDS_RESULT_SOURCE_JSON, profile),
                env.REWARDS_RESULT_SUCCESSORS_JSON,
              ),
              config,
              reads: publicReads,
              categorical,
            })
          : undefined);
      const result = await rewardsCommunityApi(
        request,
        {
          db: env.DB,
          profile,
          chain: ports.rewards?.chain ?? rewardChain(),
          verification: ports.rewards?.verification ?? rewardVeryProvider(),
          sources,
          now: ports.now,
          confirmedCutoffTimestamp:
            ports.rewards?.confirmedCutoffTimestamp ??
            (ports.rewards
              ? undefined
              : () =>
                  confirmedRewardTimestamp(
                    {
                      chainId: () => publicReads.client.getChainId(),
                      safeTimestampSeconds: async () =>
                        (
                          await publicReads.client.getBlock({
                            blockTag: "safe",
                          })
                        ).timestamp,
                    },
                    profile.chainId,
                  )),
          songs:
            ports.rewards?.songs ??
            (async () =>
              (await publicSongViews(env.DB, config, publicReads)).map(
                (song) => ({
                  title: song.manifest.title,
                  postId: song.manifest.postId,
                  songKey: songKeyOf({
                    chainId: 6343,
                    posts: config.postsContract,
                    communityId: config.communityId,
                    postId: bytes32(song.manifest.postId),
                  }),
                }),
              )),
        },
        context,
        security,
      );
      insist(result, "reward_route_not_found", 404);
      return result;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      const schema = await env.DB.prepare(
        "SELECT version FROM setup_schema WHERE version=1",
      ).first();
      insist(
        schema && /^0x[0-9a-f]{64}$/.test(env.APPLICATION_PROFILE_HASH),
        "application_schema_unavailable",
        503,
      );
      await ensureCommunityIdentity(env.DB, context);
      const creatorHealth = creatorAvailable().catch(() => false);
      let publicReady = false;
      try {
        publicReady = await firstSongPublicReady(
          env.DB,
          await configuration(),
          publicReads,
        );
      } catch {
        /* A private job is never public readiness evidence. */
      }
      return reply({
        schema: "pirate.community-application/1",
        planId: env.PLAN_ID,
        profileHash: env.APPLICATION_PROFILE_HASH,
        infrastructure: "provisioned",
        firstSong: publicReady ? "ready" : "not_ready",
        signIn: "available",
        creatorConnection: (await creatorHealth) ? "available" : "unavailable",
      });
    }
    if (
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/.well-known/")
    ) {
      insist(
        request.method === "GET" || request.method === "HEAD",
        "method_not_allowed",
        405,
      );
      const asset = await env.ASSETS.fetch(request),
        assetHeaders = new Headers(asset.headers);
      for (const [name, value] of security) assetHeaders.set(name, value);
      return new Response(asset.body, {
        status: asset.status,
        statusText: asset.statusText,
        headers: assetHeaders,
      });
    }
    const profileResponse = await communityProfilesApi(request, {
      db: env.DB,
      context,
      publicPosts: async () => {
        const current = await configuration();
        return {
          communityId: current.communityId,
          posts: await publicSongViews(env.DB, current, publicReads),
        };
      },
      now: ports.now,
      // No publicMediaExists default: no admitted public profile-media service.
    });
    if (profileResponse) {
      for (const [name, value] of security)
        profileResponse.headers.set(name, value);
      profileResponse.headers.set("cache-control", "no-store");
      if (url.pathname.startsWith("/api/profile/"))
        profileResponse.headers.set("vary", "Cookie");
      profileResponse.headers.set("server-timing", timing.header());
      return profileResponse;
    }
    if (request.method === "GET" && url.pathname === "/api/session") {
      const session = await accountSession(request, env.DB, context),
        creator = await env.DB.prepare(
          "SELECT evm_address,verified_at FROM creator_bindings WHERE account_id=?",
        )
          .bind(session.account_id)
          .first<{ evm_address: string; verified_at: number }>();
      const view: CommunitySessionView = {
        authenticated: true,
        authorId: session.author_id,
        mossAddress: session.wallet,
        csrf: session.csrf_token,
        creator: creator
          ? { evmAddress: creator.evm_address, verifiedAt: creator.verified_at }
          : null,
        pendingConnection: await pendingCreatorConnection(env.DB, session),
        // Only a V4 community has public results by sign-in; no RPC
        // otherwise. With V4 configured, a failed configuration read is
        // "pending", never "unavailable", which would offer V3 enrollment.
        publicResults: !env.STUDY_RESULTS_V4_CONTRACT
          ? "unavailable"
          : await configuration().then(
              (config) =>
                publicResults(
                  env.DB,
                  session.account_id,
                  !!signInV4(env, config),
                ),
              () => "pending" as const,
            ),
        publisher: await sessionPublisher(session.account_id, session.wallet),
      };
      return reply(view);
    }
    if (url.pathname === "/api/logout") {
      insist(request.method === "POST", "method_not_allowed", 405);
      const session = await authenticatedWrite(request, env.DB, context);
      await env.DB.prepare(
        "DELETE FROM community_sessions WHERE session_hash=?",
      )
        .bind(session.session_hash)
        .run();
      security.set("set-cookie", cookie("", 0));
      return reply({ signedOut: true });
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/public/configuration-diagnostics"
    )
      return reply({ gateways: await configurationHealth() });
    if (url.pathname.startsWith("/api/moderation/inputs/"))
      return await serveInputCapability(
        request,
        env.DB,
        env.MEDIA,
        context.origin,
      );
    if (url.pathname === "/api/operator/owner-curated") {
      insist(request.method === "POST" && !url.search, "not_found", 404);
      requestOrigin(request, context.origin);
      const signed = await jsonBody(request, 256 * 1024),
        config = await configuration();
      // Only the current controller's exact-job signature authorizes adoption.
      // A creator cookie and an ordinary resume never grant this authority.
      const result = await adoptCuratedPublication(
        env.DB,
        env.MEDIA,
        signed,
        config,
      );
      await env.JOBS.send({
        jobId: String((signed.amendment as Record<string, unknown>).jobId),
      });
      return reply(result);
    }
    if (url.pathname === "/api/operator/song-alignment") {
      insist(request.method === "POST" && !url.search, "not_found", 404);
      requestOrigin(request, context.origin);
      // Only the community controller's short-lived signed request buys the
      // one forced alignment of a published lyric revision.
      const signed = await jsonBody(request, 16 * 1024);
      return reply(
        await runSongAlignment(
          env.DB,
          env.MEDIA,
          await configuration(),
          publicReads,
          signed,
          {
            apiKey: env.ALIGNMENT_ELEVENLABS_API_KEY,
            transport: ports.alignmentTransport,
            now: ports.now,
            beforeSend:
              env.KARAOKE_SERVICE_MODE === "internal"
                ? async () => {
                    insist(
                      env.KARAOKE_SPEECH_BUDGET,
                      "speech_budget_unconfigured",
                      503,
                    );
                    await env.KARAOKE_SPEECH_BUDGET.getByName(
                      "elevenlabs-service",
                    ).claim();
                  }
                : undefined,
          },
        ),
      );
    }
    const release = await communityReleaseApi(
      request,
      env,
      context,
      ready,
      reply,
    );
    if (release) return release;
    const config = await configuration();
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/pirate-community.json"
    )
      return reply(config);
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/pirate-client.json"
    ) {
      const boot: CommunityClientConfig = {
        schema: "pirate.community-client-config/1",
        communityId: config.communityId,
        canonicalOrigin: config.app.origin,
        apiBase: "/api",
        protocolVersions: [1],
        defaultLanguage: "en",
        supportedLanguages: ["en"],
        mirrors: [],
      };
      return reply(boot);
    }
    if (request.method === "GET" && url.pathname === "/api/capabilities") {
      let releaseReady = false;
      try {
        await ready();
        releaseReady = true;
      } catch {
        /* Fail closed while a required peer is unavailable. */
      }
      const capabilities: CommunityCapabilities = {
        ...(env.REWARDS_PROFILE_JSON ? { rewards: true } : {}),
        study: studyAvailable(env, config),
        schema: "pirate.community-capabilities/1",
        signIn: true,
        ...(env.KARAOKE_SERVICE_MODE === "internal"
          ? { learningServiceMode: "internal" as const }
          : {}),
        // The learning documents of the community's actual version, for the
        // site footer: exercise surfaces carry no links in any mode. A V4
        // sign-in accepts them; a V3 community's enrollment did.
        ...(signInV4(env, config)
          ? {
              learningPolicy: {
                version: 4 as const,
                termsUrl: learningV4Disclosure.termsUrl,
                privacyUrl: learningV4Disclosure.privacyUrl,
              },
            }
          : env.STUDY_RESULTS_V3_CONTRACT?.toLowerCase() ===
              config.learningRecords.toLowerCase()
            ? {
                learningPolicy: {
                  version: 3 as const,
                  termsUrl: learningV3Disclosure.termsUrl,
                  privacyUrl: learningV3Disclosure.privacyUrl,
                },
              }
            : {}),
        creatorConnection: await creatorAvailable(config),
        upload: releaseReady,
        publication: releaseReady,
        policyVersion: config.policies.admission.version,
      };
      return reply(capabilities);
    }
    if (request.method === "GET" && url.pathname === "/api/public/community")
      return reply({
        communityId: config.communityId,
        name: env.COMMUNITY_NAME,
        description: "Songs released by this community.",
        lang: "en",
        dir: "ltr",
        revision: 1,
        posts: await publicSongViews(env.DB, config, publicReads),
      });
    if (request.method === "GET" && url.pathname === "/api/feed") {
      const feed: CommunityFeed = {
        schema: "pirate.community-feed/1",
        communityId: config.communityId,
        posts: await publicSongViews(env.DB, config, publicReads),
      };
      return reply(feed);
    }
    const publicResource = await publicSongResource(
      request,
      env.DB,
      config,
      publicReads,
    );
    if (publicResource) {
      publicResource.headers.set("server-timing", timing.header());
      return publicResource;
    }
    const karaokePorts = {
      env,
      db: env.DB,
      config,
      reads: publicReads,
      now: ports.now,
    };
    const timed = /^\/api\/public\/posts\/(0x[0-9a-f]{64})\/karaoke$/.exec(
      url.pathname,
    );
    if (timed) {
      insist(
        request.method === "GET" && !url.search,
        "method_not_allowed",
        405,
      );
      return reply(
        await publishedKaraoke(env.DB, config, publicReads, timed[1] as Hex),
      );
    }
    const instrumental =
      /^\/api\/karaoke\/posts\/(0x[0-9a-f]{64})\/instrumental$/.exec(
        url.pathname,
      );
    if (instrumental) {
      insist(
        request.method === "GET" && !url.search,
        "method_not_allowed",
        405,
      );
      await accountSession(request, env.DB, context);
      const stem = await instrumentalResponse(
          env.DB,
          env.MEDIA,
          config,
          instrumental[1] as Hex,
          request.headers.get("range"),
        ),
        stemHeaders = new Headers(stem.headers);
      for (const [name, value] of security)
        if (name !== "cache-control") stemHeaders.set(name, value);
      stemHeaders.set("server-timing", timing.header());
      return new Response(stem.body, {
        status: stem.status,
        headers: stemHeaders,
      });
    }
    if (url.pathname === "/api/karaoke/attempt") {
      insist(request.method === "GET", "method_not_allowed", 405);
      const session = await accountSession(request, env.DB, context);
      insist(
        request.headers.get("x-study-account")?.toLowerCase() ===
          session.wallet.toLowerCase(),
        "study_account_changed",
        409,
      );
      const requestPorts = withKaraokeRequestSession(
        karaokePorts,
        request,
        context,
        session,
      );
      await requestPorts.requestSession.check(session);
      const view = await karaokeAttempt(
        requestPorts,
        session,
        bytes32(url.searchParams.get("postId")),
      );
      return await requestPorts.requestSession.expose(session, () => {
        if (view.state === "open")
          insist(
            Math.floor((ports.now ?? Date.now)() / 1000) <
              view.ticket.body.expiresAt,
            "karaoke_reservation_expired",
            409,
          );
        return reply(view);
      });
    }
    const study = await studyCommunityApi(
      request,
      { ...karaokePorts, env },
      context,
      security,
    );
    if (study) return study;
    if (url.pathname.startsWith("/api/")) {
      insist(request.method === "POST", "method_not_allowed", 405);
      requestOrigin(request, context.origin);
      const body = await jsonBody(request);
      if (url.pathname === "/api/auth/challenge") {
        const loginAt = (ports.now ?? Date.now)();
        const v4 = await publicationSignInAtLogin(
          env,
          env.DB,
          body.address,
          signInV4(env, config),
        );
        // SIWE keeps the wall clock. A V4 sign-in's issuedAt comes from the
        // application's own clock, backdated by at most a minute for wallet
        // clocks behind it and never to or before the account's last
        // withdrawal. If it is ahead of the chain, the operator answers
        // sign_in_not_yet_valid and the relay is retried.
        return reply(
          await loginChallenge(env.DB, context, body.address, loginAt, v4),
        );
      }
      if (url.pathname === "/api/auth/verify") {
        const verified = await loginVerify(
          env.DB,
          context,
          text(body.id, 64),
          text(body.signature, 32768),
          ports.verifyLogin,
          (ports.now ?? Date.now)(),
        );
        // The V4 sign-in is only stored: it is relayed when the learner
        // first starts Study or Karaoke work, never at login.
        security.set("set-cookie", verified.cookie);
        return reply({ authenticated: true, csrf: verified.csrf });
      }
      const session = await authenticatedWrite(request, env.DB, context);
      if (url.pathname.startsWith("/api/karaoke/"))
        insist(
          request.headers.get("x-study-account")?.toLowerCase() ===
            session.wallet.toLowerCase(),
          "study_account_changed",
          409,
        );
      if (url.pathname === "/api/karaoke/history")
        return reply(await karaokeHistory(karaokePorts, session, body));
      if (url.pathname === "/api/karaoke/enrollments")
        return reply(await karaokeEnrollments(karaokePorts, session));
      if (url.pathname === "/api/karaoke/enrollment/revoke")
        return reply(
          await karaokeRevokeEnrollment(karaokePorts, session, body),
        );
      if (url.pathname === "/api/karaoke/enrollment") {
        // V4 learning records: the sign-in is the permission, so the V3
        // enrollment request and signature are refused. Listing and stopping
        // an earlier V3 enrollment stay available.
        insist(!v4LearningRecords(env, config), "enrollment_unavailable", 409);
        return reply(await karaokeEnrollment(karaokePorts, session, body));
      }
      // A withdrawal, in settings or found on chain, closes the account's
      // open Study lessons in this community.
      const endStudyLessons = async () => {
        if (studyAvailable(env, config))
          await liveStudy({ ...karaokePorts, env }, session).endForWithdrawal();
      };
      // V4 account settings; never reached from an exercise.
      if (
        ports.linkedAuthority &&
        [
          "/api/learning/public-results/off",
          "/api/learning/public-results/on",
        ].includes(url.pathname)
      ) {
        if (url.pathname.endsWith("/off") && body.signature === undefined)
          return reply(
            await turnOffPublicResults(
              env,
              env.DB,
              config,
              session,
              body,
              (ports.now ?? Date.now)(),
            ),
          );
        const kind = url.pathname.endsWith("/off")
          ? ("off" as const)
          : ("on" as const);
        const action = await ports.linkedAuthority.action(
          session,
          body,
          kind,
          (ports.now ?? Date.now)(),
        );
        return reply(
          await connectedPublicResultsAction(
            env.DB,
            action,
            ports.linkedAuthority.ports,
          ),
        );
      }
      if (url.pathname === "/api/learning/public-results/off")
        return reply(
          await turnOffPublicResults(
            env,
            env.DB,
            config,
            session,
            body,
            (ports.now ?? Date.now)(),
          ),
        );
      if (url.pathname === "/api/learning/public-results/on")
        return reply(await turnOnPublicResults(env, env.DB, config, session));
      if (url.pathname === "/api/karaoke/tickets") {
        const requestPorts = withKaraokeRequestSession(
          karaokePorts,
          request,
          context,
          session,
        );
        await requestPorts.requestSession.check(session);
        const issued = await karaokeTicket(
          requestPorts,
          session,
          body,
          endStudyLessons,
        );
        return await requestPorts.requestSession.expose(session, () => {
          insist(
            Math.floor((ports.now ?? Date.now)() / 1000) <
              issued.ticket.body.expiresAt,
            "karaoke_reservation_expired",
            409,
          );
          return reply(issued);
        });
      }
      if (url.pathname === "/api/karaoke/purchases")
        return reply(await karaokePurchase(karaokePorts, session, body));
      if (url.pathname === "/api/karaoke/consent")
        return reply(await karaokeConsent(karaokePorts, session, body));
      if (
        url.pathname === "/api/creator/connect" ||
        url.pathname === "/api/creator/complete"
      ) {
        // The connection code is preserved for the deferred integration; an
        // owner deployment refuses it before contacting the creator service.
        insist(!env.OWNER_GRANT_JSON, "creator_connection_unavailable", 503);
        insist(await ports.creatorHealth(), "creator_service_unavailable", 503);
        insist(
          /^0x[0-9a-f]{64}$/i.test(env.COMMUNITY_PUBLISHER_PRIVATE_KEY),
          "community_publisher_unavailable",
          503,
        );
        const service = {
          config,
          transport: ports.creatorTransport,
          publisher: privateKeyToAccount(
            env.COMMUNITY_PUBLISHER_PRIVATE_KEY as Hex,
          ),
        };
        if (url.pathname.endsWith("/connect"))
          return reply(await beginCreatorConnection(env.DB, session, service));
        return reply(
          await completeCreatorConnection(
            env.DB,
            session,
            service,
            text(body.connectionId, 36),
            text(body.state, 43),
          ),
        );
      }
      insist(false, "release_processing_unavailable", 503);
    }
    insist(
      request.method === "GET" || request.method === "HEAD",
      "method_not_allowed",
      405,
    );
    const asset = await env.ASSETS.fetch(request),
      assetHeaders = new Headers(asset.headers);
    for (const [name, value] of security) assetHeaders.set(name, value);
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers: assetHeaders,
    });
  } catch (error) {
    return reply(
      {
        error:
          error instanceof CommunityError || error instanceof StudyError
            ? error.code
            : "community_service_unavailable",
      },
      error instanceof CommunityError || error instanceof StudyError
        ? error.status
        : 503,
    );
  }
}
export async function communityScheduled(
  env: CommunityEnv,
  provided?: CommunityDependencies,
) {
  const deployment=provided?.deployment??deploymentProfile(env);
  const failures: unknown[] = [];
  if (provided?.linkedAuthority) {
    try {
      await recoverCommunityAuthority(env.DB, provided.linkedAuthority.ports);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await deleteExpiredStudyHistory(
      env.DB,
      deployment.directoryProfile.communityId,
      provided?.now,
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    await recoverCommunityJobs(env.DB, env.JOBS);
  } catch (error) {
    failures.push(error);
  }
  let ports: CommunityDependencies | undefined;
  if (env.STUDY_RESULTS_V4_CONTRACT) {
    try {
      ports ??= provided ?? dependencies(env);
      const config = await ports.configuration();
      insist(
        config.communityId === deployment.directoryProfile.communityId &&
          config.app.origin === deployment.origin,
        "community_configuration_changed",
        503,
      );
      // Pending sign-ins are relayed even if V4 was since unconfigured: the
      // relay window then closes them as refused.
      await relayPendingSignIns(
        env,
        env.DB,
        ports.now?.() ?? Date.now(),
        10,
        ports.linkedAuthority
          ? (account, id) => fenceAuthorityRelay(env.DB, account, id)
          : undefined,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  // Study recovery covers V3 lessons and, when configured, V4 lessons.
  if (env.STUDY_RESULTS_V3_CONTRACT || env.STUDY_RESULTS_V4_CONTRACT) {
    try {
      ports ??= provided ?? dependencies(env);
      const config = await ports.configuration();
      insist(
        config.communityId === deployment.directoryProfile.communityId &&
          config.app.origin === deployment.origin,
        "community_configuration_changed",
        503,
      );
      await recoverStudyLessons({
        env,
        db: env.DB,
        config,
        reads: ports.publicReads ?? {
          client: megaethReadClient(),
          profile: publicPostsProfile(deployment),
        },
        now: ports.now,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (provided?.privateDance || env.DANCE_PRODUCTION_INPUTS || env.DANCE_REWARD_SOURCE_JSON ||
    env.DANCE_REWARD_SOURCE_SELECTION_HASH) {
    try {
      ports ??= provided ?? dependencies(env);
      const config = await ports.configuration();
      insist(
        config.communityId === deployment.directoryProfile.communityId &&
          config.app.origin === deployment.origin,
        "community_configuration_changed",
        503,
      );
      insist(ports.privateDance, "dance_production_inputs_unavailable", 503);
      const runtime = await ports.privateDance(config);
      insist(
        runtime.communityId === config.communityId,
        "media_wrong_community",
        403,
      );
      await runtime.tick();
    } catch (error) {
      failures.push(error);
    }
  }
  // Read-only payment reconciliation runs last so a slow or failing reward
  // RPC cannot hold Study retention, job recovery or lesson recovery. It never
  // submits or retries a payment.
  if (env.REWARDS_PROFILE_JSON) {
    try {
      await reconcileRewardPayments(
        env.DB,
        rewardProfile(env.REWARDS_PROFILE_JSON),
        provided?.rewards?.chain,
        provided?.now,
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "community_scheduled_failed");
}

/** Keep existing song envelopes intact and dispatch private media explicitly. */
export async function communityQueue(
  batch: Pick<MessageBatch<CommunityQueueJob>, "messages">,
  env: CommunityEnv,
  provided?: CommunityDependencies,
) {
  const deployment=provided?.deployment??deploymentProfile(env);
  const ports = provided ?? dependencies(env),
    config = await ports.configuration();
  insist(
    config.communityId === deployment.directoryProfile.communityId &&
      config.app.origin === deployment.origin,
    "community_configuration_changed",
    503,
  );
  let publication: FirstSongDriverPorts | undefined;
  let privateDance: CommunityPrivateDance | undefined;
  for (const message of batch.messages) {
    try {
      const job = message.body;
      if (job.kind === "community-media/1") {
        privateDance ??= await ports.privateDance?.(config);
        insist(
          privateDance && privateDance.communityId === config.communityId,
          "media_processor_unavailable",
          503,
        );
        await privateDance.process(job);
      } else {
        publication ??=
          ports.releaseRuntime?.(config) ??
          firstSongRuntime(env, config, ports.freshConfiguration??ports.configuration,deployment);
        await runCommunityJob(publication, env.JOBS, job.jobId);
      }
      message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}

export default {
  fetch(request, env) {
    return communityFetch(request, env);
  },
  async queue(batch: MessageBatch<CommunityQueueJob>, env: CommunityEnv) {
    await communityQueue(batch, env);
  },
  async scheduled(_event, env) {
    await communityScheduled(env);
  },
} satisfies ExportedHandler<CommunityEnv, CommunityQueueJob>;
