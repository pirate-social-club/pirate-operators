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
  CommunityError,
  cookie,
  insist,
  jsonBody,
  requestOrigin,
  text,
} from "../packages/community/common.ts";
import { readConfiguration } from "../packages/community/directory-reader.ts";
import { megaethReadClient } from "../packages/community/chain.ts";
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

export interface CommunityEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  JOBS: Queue<{ jobId: string }>;
  ASSETS: Fetcher;
  COMMUNITY_NAME: string;
  PLAN_ID: string;
  APPLICATION_PROFILE_HASH: string;
  CREATOR_PROFILE_HASH: string;
  COMMUNITY_PUBLISHER_PRIVATE_KEY: string;
}
export interface CommunityDependencies {
  configuration(): Promise<CommunityConfig>;
  verifyLogin: VerifyLogin;
  creatorHealth(): Promise<boolean>;
  creatorTransport?: CreatorConnectionService["transport"];
}
function dependencies(env: CommunityEnv): CommunityDependencies {
  return {
    async configuration() {
      return readConfiguration(megaethReadClient(), {
        ...firstSong.directoryProfile,
        deploymentBlock: BigInt(firstSong.directoryProfile.deploymentBlock),
      });
    },
    async verifyLogin(address, message, signature) {
      const client = megaethReadClient();
      insist((await client.getChainId()) === 6343, "wrong_moss_network", 503);
      return client.verifyMessage({ address, message, signature });
    },
    async creatorHealth() {
      try {
        const response = await fetch(creatorServiceOrigin + "/api/health", {
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          }),
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
function headers() {
  return new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    "permissions-policy":
      'publickey-credentials-create=(self "https://account.megaeth.com"), publickey-credentials-get=(self "https://account.megaeth.com")',
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' https://gateway.pinata.cloud; font-src 'self'; connect-src 'self' https://*.megaeth.com; frame-src https://*.megaeth.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  });
}
export async function communityFetch(
  request: Request,
  env: CommunityEnv,
  ports = dependencies(env),
): Promise<Response> {
  const url = new URL(request.url),
    security = headers(),
    reply = (value: unknown, status = 200) =>
      Response.json(value, { status, headers: security });
  try {
    insist(url.origin === firstSong.origin, "wrong_community_host", 403);
    const context = {
      communityId: firstSong.directoryProfile.communityId,
      origin: firstSong.origin,
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
      return reply({
        schema: "pirate.community-application/1",
        planId: env.PLAN_ID,
        profileHash: env.APPLICATION_PROFILE_HASH,
        infrastructure: "provisioned",
        firstSong: "not_ready",
        signIn: "available",
        creatorConnection: (await ports.creatorHealth())
          ? "available"
          : "unavailable",
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
    const config = await ports.configuration();
    insist(
      config.communityId === context.communityId &&
        config.app.origin === context.origin,
      "community_configuration_changed",
      503,
    );
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
      const capabilities: CommunityCapabilities = {
        schema: "pirate.community-capabilities/1",
        signIn: true,
        creatorConnection: await ports.creatorHealth(),
        upload: false,
        publication: false,
        policyVersion: RELEASE_POLICY,
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
        posts: [],
      });
    if (request.method === "GET" && url.pathname === "/api/feed") {
      const feed: CommunityFeed = {
        schema: "pirate.community-feed/1",
        communityId: config.communityId,
        posts: [],
      };
      return reply(feed);
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
} satisfies ExportedHandler<CommunityEnv>;
