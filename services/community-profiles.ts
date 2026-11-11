import {
  accountSession,
  authenticatedWrite,
  type AuthContext,
} from "../packages/community/accounts.ts";
import {
  bytes32,
  CommunityError,
  insist,
  jsonBody,
} from "../packages/community/common.ts";
import type { PublicSongView } from "../packages/community/application-api.ts";
import { CommunityProfileStore } from "../packages/community-profile/store.ts";
import {
  mutationId,
  profileMutation,
} from "../packages/community-profile/validation.ts";

export interface CommunityProfilePorts {
  db: D1Database;
  context: AuthContext;
  /** Exact canonical publicSongViews producer; no private DB/journal fallback. */
  publicPosts: () => Promise<{
    communityId: string;
    posts: readonly PublicSongView[];
  }>;
  publicMediaExists?: (path: string) => Promise<boolean>;
  now?: () => number;
}
/** Exact-base HTTP mount is coordinator-owned. Public DTOs are allowlisted. */
export async function communityProfilesApi(
  request: Request,
  ports: CommunityProfilePorts,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    !url.pathname.startsWith("/api/profile/") &&
    !url.pathname.startsWith("/api/public/authors")
  )
    return null;
  const headers = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  const reply = (body: unknown, status = 200) =>
    Response.json(body, { status, headers });
  try {
    insist(
      url.origin === ports.context.origin && url.protocol === "https:",
      "wrong_host",
      403,
    );
    insist(url.search.length <= 4096, "invalid_profile_query");
    const store = new CommunityProfileStore(ports.db, ports.context);
    await store.assertContext();
    const now = (ports.now ?? Date.now)();
    if (url.pathname.startsWith("/api/profile/")) {
      headers.set("vary", "Cookie");
      const site = request.headers.get("sec-fetch-site");
      insist(
        site === null || site === "same-origin" || site === "none",
        "cross_site_profile",
        403,
      );
      const origin = request.headers.get("origin");
      insist(
        origin === null || origin === ports.context.origin,
        "wrong_origin",
        403,
      );
      insist(!url.search, "invalid_profile_query");
      const ownerPath = url.pathname === "/api/profile/owner";
      const receiptPath = /^\/api\/profile\/owner\/mutations\/([^/]+)$/.exec(
        url.pathname,
      );
      insist(ownerPath || receiptPath, "profile_route_not_found", 404);
      if (ownerPath && request.method === "PUT") {
        const session = await authenticatedWrite(
          request,
          ports.db,
          ports.context,
        );
        const body = await profileMutation(
          await jsonBody(request, 12_000),
          ports.context.origin,
          ports.publicMediaExists,
        );
        return reply(await store.write(session, body, now));
      }
      insist(request.method === "GET", "method_not_allowed", 405);
      const session = await accountSession(
        request,
        ports.db,
        ports.context,
        now,
      );
      if (receiptPath) {
        const receipt = await store.receipt(
          session,
          mutationId(receiptPath[1]),
        );
        return reply({
          schema: "pirate.community-profile-receipt-read/1",
          receipt,
        });
      }
      return reply({
        schema: "pirate.community-profile-owner/1",
        communityId: ports.context.communityId,
        accountId: session.account_id,
        profile: await store.owner(session),
        capabilities: {
          metadata: true,
          publicMedia: !!ports.publicMediaExists,
          handles: false,
        },
      });
    }
    insist(request.method === "GET", "method_not_allowed", 405);
    if (url.pathname === "/api/public/authors") {
      insist(
        [...url.searchParams.keys()].every((key) => key === "ids") &&
          url.searchParams.getAll("ids").length === 1,
        "invalid_profile_query",
      );
      const ids = url.searchParams.get("ids")!.split(",");
      insist(
        ids.length > 0 && ids.length <= 32 && new Set(ids).size === ids.length,
        "invalid_profile_authors",
      );
      const profiles = [];
      for (const author of ids) {
        bytes32(author);
        try {
          profiles.push(await store.public(author));
        } catch (error) {
          if (!(error instanceof CommunityError && error.status === 404))
            throw error;
        }
      }
      return reply({
        schema: "pirate.community-profile-list/1",
        communityId: ports.context.communityId,
        profiles,
      });
    }
    const match =
      /^\/api\/public\/authors\/(0x[0-9a-f]{64})(\/activity)?$/.exec(
        url.pathname,
      );
    insist(match, "profile_route_not_found", 404);
    const profile = await store.public(bytes32(match[1]));
    if (!match[2]) {
      insist(!url.search, "invalid_profile_query");
      return reply(profile);
    }
    insist(
      [...url.searchParams.keys()].every(
        (key) => key === "limit" || key === "cursor",
      ) &&
        url.searchParams.getAll("limit").length <= 1 &&
        url.searchParams.getAll("cursor").length <= 1,
      "invalid_profile_query",
    );
    const rawLimit = url.searchParams.get("limit") ?? "20";
    insist(/^(?:[1-9]|1[0-9]|20)$/.test(rawLimit), "invalid_profile_limit");
    const catalogue = await ports.publicPosts();
    insist(
      catalogue.communityId === ports.context.communityId,
      "profile_public_catalogue_unavailable",
      503,
    );
    const records = catalogue.posts;
    insist(
      records.length <= 100 &&
        new Set(records.map((post) => post.manifest.postId)).size ===
          records.length &&
        records.every(
          (post) =>
            post.manifest.authorId &&
            /^0x[0-9a-f]{64}$/.test(post.manifest.postId),
        ),
      "profile_public_catalogue_unavailable",
      503,
    );
    const items = records
      .filter((post) => post.manifest.authorId === profile.authorId)
      .map((post) => {
        const { manifest } = post;
        bytes32(manifest.authorId);
        insist(
          post.audioUrl === `/api/public/posts/${manifest.postId}/audio` &&
            post.postUrl === `/#song-${manifest.postId}`,
          "profile_public_catalogue_unavailable",
          503,
        );
        // Never spread a producer record into a public response: private additions
        // in a future adapter must not silently cross the public boundary.
        return {
          manifest: {
            schema: manifest.schema,
            postId: manifest.postId,
            authorId: manifest.authorId,
            title: manifest.title,
            language: manifest.language,
            rating: manifest.rating,
          },
          audioUrl: post.audioUrl,
          postUrl: post.postUrl,
          transactionHash: post.transactionHash,
          ...(post.lyricsText !== undefined
            ? { lyricsText: post.lyricsText }
            : {}),
        };
      });
    const page = await store.page(
      profile.authorId,
      items,
      Number(rawLimit),
      url.searchParams.get("cursor"),
      profile.revision,
      now,
    );
    return reply({
      schema: "pirate.community-profile-activity/1",
      communityId: ports.context.communityId,
      authorId: profile.authorId,
      profile,
      ...page,
      window: "current-public-catalogue",
    });
  } catch (error) {
    if (error instanceof CommunityError)
      return reply({ error: error.code }, error.status);
    return reply({ error: "profile_unavailable" }, 503);
  }
}
