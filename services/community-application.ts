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
import {
  beginCreatorConnection,
  completeCreatorConnection,
  pendingCreatorConnection,
  type CreatorConnectionService,
} from "../packages/community/creator-connections.ts";
import { creatorServiceOrigin } from "../packages/community/creator-receipt.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type {
  CommunityCapabilities,
  CommunityClientConfig,
  CommunityFeed,
  CommunitySessionView,
} from "../packages/community/application-api.ts";
import { RELEASE_POLICY } from "../packages/community/manifest-core.ts";
import { firstSong } from "./first-song-profile.ts";
import { learningPolicyPage } from "./learning-policy-pages.ts";
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
  karaokeRevokeEnrollment,
  karaokeHistory,
  karaokeConsent,
  karaokePurchase,
  karaokeTicket,
  type KaraokeEnv,
} from "./karaoke-community.ts";
import type { FirstSongDriverPorts } from "./first-song-driver.ts";

export interface CommunityEnv extends FirstSongRuntimeEnv, KaraokeEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  JOBS: Queue<{ jobId: string }>;
  ASSETS: Fetcher;
  COMMUNITY_NAME: string;
  PLAN_ID: string;
  APPLICATION_PROFILE_HASH: string;
  CREATOR_PROFILE_HASH: string;
  COMMUNITY_PUBLISHER_PRIVATE_KEY: string;
  /** Pirate's provider key for the one forced alignment per lyric revision. */
  ALIGNMENT_ELEVENLABS_API_KEY?: string;
}
export interface CommunityDependencies {
  configuration(): Promise<CommunityConfig>;
  verifyLogin: VerifyLogin;
  creatorHealth(): Promise<boolean>;
  creatorTransport?: CreatorConnectionService["transport"];
  releaseRuntime?(config: CommunityConfig): FirstSongDriverPorts;
  publicReads?: PublicReadPorts;
  alignmentTransport?: ProviderTransport;
  now?: () => number;
}
function dependencies(
  env: CommunityEnv,
  timing = new RequestTiming(),
): CommunityDependencies {
  const client = megaethReadClient((method, ms) =>
    timing.record(`rpc_${method}`, ms),
  );
  const transport = (request: Request) =>
    timing.measure("ipfs", () => fetch(request));
  const directory = {
    ...firstSong.directoryProfile,
    deploymentBlock: BigInt(firstSong.directoryProfile.deploymentBlock),
  };
  let history: ReturnType<typeof readConfigurationHistory> | undefined;
  const configurationHistory = () =>
    (history ??= timing.measure("configuration", () =>
      readConfigurationHistory(
        client,
        directory,
        transport,
        directoryHistoryCache(env.DB, client, directory),
      ),
    ));
  return {
    async configuration() {
      return (await configurationHistory()).at(-1)!;
    },
    publicReads: {
      client,
      transport,
      profile: publicPostsProfile(),
      configurationHistory,
      manifestAvailable: async (hash) => !!(await publicResultManifest(hash)),
    },
    async verifyLogin(address, message, signature) {
      const client = megaethReadClient();
      insist((await client.getChainId()) === 6343, "wrong_moss_network", 503);
      return client.verifyMessage({ address, message, signature });
    },
    async creatorHealth() {
      try {
        const response = await timing.measure("creator", () =>
            fetch(creatorServiceOrigin + "/api/health", {
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
export async function communityFetch(
  request: Request,
  env: CommunityEnv,
  ports?: CommunityDependencies,
): Promise<Response> {
  const timing = new RequestTiming();
  ports ??= dependencies(env, timing);
  const url = new URL(request.url),
    security = headers(env),
    reply = (value: unknown, status = 200) => {
      security.set("server-timing", timing.header());
      return Response.json(value, { status, headers: security });
    };
  try {
    insist(url.origin === firstSong.origin, "wrong_community_host", 403);
    const policy = learningPolicyPage(url.pathname);
    if (policy) return policy;
    const context = {
      communityId: firstSong.directoryProfile.communityId,
      origin: firstSong.origin,
    };
    const publicReads = ports.publicReads ?? {
      client: megaethReadClient(),
      profile: publicPostsProfile(),
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
    const ready = async () => {
      const config = await configuration();
      const runtime =
        ports.releaseRuntime?.(config) ??
        firstSongRuntime(env, config, configuration);
      await runtime.checkServices();
      return { config, ports: runtime };
    };
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
      const creatorHealth = ports.creatorHealth().catch(() => false);
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
      return serveInputCapability(request, env.DB, env.MEDIA, context.origin);
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
        schema: "pirate.community-capabilities/1",
        signIn: true,
        ...(env.KARAOKE_SERVICE_MODE === "internal"
          ? { learningServiceMode: "internal" as const }
          : {}),
        creatorConnection: await ports.creatorHealth(),
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
      return reply(
        await karaokeAttempt(
          karaokePorts,
          session,
          bytes32(url.searchParams.get("postId")),
        ),
      );
    }
    if (url.pathname.startsWith("/api/")) {
      insist(request.method === "POST", "method_not_allowed", 405);
      requestOrigin(request, context.origin);
      const body = await jsonBody(request);
      if (url.pathname === "/api/auth/challenge")
        return reply(await loginChallenge(env.DB, context, body.address));
      if (url.pathname === "/api/auth/verify") {
        const verified = await loginVerify(
          env.DB,
          context,
          text(body.id, 64),
          text(body.signature, 32768),
          ports.verifyLogin,
        );
        security.set("set-cookie", verified.cookie);
        return reply({ authenticated: true, csrf: verified.csrf });
      }
      const session = await authenticatedWrite(request, env.DB, context);
      if (url.pathname === "/api/karaoke/history")
        return reply(await karaokeHistory(karaokePorts, session, body));
      if (url.pathname === "/api/karaoke/enrollment/revoke")
        return reply(
          await karaokeRevokeEnrollment(karaokePorts, session, body),
        );
      if (url.pathname === "/api/karaoke/enrollment")
        return reply(await karaokeEnrollment(karaokePorts, session, body));
      if (url.pathname === "/api/karaoke/tickets")
        return reply(await karaokeTicket(karaokePorts, session, body));
      if (url.pathname === "/api/karaoke/purchases")
        return reply(await karaokePurchase(karaokePorts, session, body));
      if (url.pathname === "/api/karaoke/consent")
        return reply(await karaokeConsent(karaokePorts, session, body));
      if (
        url.pathname === "/api/creator/connect" ||
        url.pathname === "/api/creator/complete"
      ) {
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
          error instanceof CommunityError
            ? error.code
            : "community_service_unavailable",
      },
      error instanceof CommunityError ? error.status : 503,
    );
  }
}
export default {
  fetch(request, env) {
    return communityFetch(request, env);
  },
  async queue(batch: MessageBatch<{ jobId: string }>, env: CommunityEnv) {
    const ports = dependencies(env),
      config = await ports.configuration();
    insist(
      config.communityId === firstSong.directoryProfile.communityId &&
        config.app.origin === firstSong.origin,
      "community_configuration_changed",
      503,
    );
    const runtime = firstSongRuntime(env, config, ports.configuration);
    for (const message of batch.messages) {
      try {
        await runCommunityJob(runtime, env.JOBS, message.body.jobId);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_event, env) {
    await recoverCommunityJobs(env.DB, env.JOBS);
  },
} satisfies ExportedHandler<CommunityEnv, { jobId: string }>;
