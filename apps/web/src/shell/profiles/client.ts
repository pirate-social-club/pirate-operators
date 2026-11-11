import type {
  OwnerProfile,
  PublicProfile,
  ProfileMutation,
  ProfileMutationReceipt,
  ProfileActivityPage,
} from "../../../../../packages/community-profile/contracts.ts";
import type { PublicSongView } from "../../api-contract.ts";

export class ProfileRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const fail = (): never => {
  throw new ProfileRequestError(503, "profile_response_unavailable");
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const nullable = (value: unknown, max: number): string | null =>
  value === null
    ? null
    : typeof value === "string" && value.length <= max
      ? value
      : fail();
const author = (value: unknown): string =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) ? value : fail();
const media = (value: unknown) => {
  const path = nullable(value, 512);
  if (path !== null) {
    const parsed = new URL(path, "https://profile.invalid");
    if (
      parsed.origin !== "https://profile.invalid" ||
      parsed.pathname !== path ||
      /%2f|%5c/i.test(path)
    )
      fail();
  }
  if (
    path !== null &&
    (!path.startsWith("/api/public/") ||
      path.includes("\\") ||
      path.includes("?") ||
      path.includes("#"))
  )
    fail();
  return path;
};
export function decodeProfile(
  value: unknown,
  communityId: string,
  authorId?: string,
): PublicProfile {
  const row = record(value);
  if (
    row.schema !== "pirate.community-profile/1" ||
    row.communityId !== communityId ||
    (authorId !== undefined && row.authorId !== authorId) ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 0
  )
    fail();
  return {
    schema: "pirate.community-profile/1",
    communityId,
    authorId: author(row.authorId),
    revision: Number(row.revision),
    displayName: nullable(row.displayName, 160),
    bio: nullable(row.bio, 4000),
    avatarRef: media(row.avatarRef),
    coverRef: media(row.coverRef),
  };
}
export interface ProfileClient {
  owner(signal: AbortSignal): Promise<OwnerProfile>;
  public(authorId: string, signal: AbortSignal): Promise<PublicProfile>;
  authors(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<PublicProfile[]>;
  activity(
    authorId: string,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<ProfileActivityPage<PublicSongView>>;
  save(
    body: ProfileMutation,
    csrf: string,
    signal: AbortSignal,
  ): Promise<ProfileMutationReceipt>;
  receipt(
    id: string,
    signal: AbortSignal,
  ): Promise<ProfileMutationReceipt | null>;
}
/** Same-origin cookies only. No central session, credential or storage fallback. */
export function createProfileClient(
  communityId: string,
  fetcher: typeof fetch = fetch,
): ProfileClient {
  const request = async (
    path: string,
    signal: AbortSignal,
    body?: ProfileMutation,
    csrf?: string,
  ) => {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: body ? "PUT" : "GET",
        signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(body
            ? { "content-type": "application/json", "x-csrf-token": csrf! }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProfileRequestError(0, "profile_outcome_unknown");
    }
    const value = await response.json().catch(() => fail());
    if (!response.ok)
      throw new ProfileRequestError(
        response.status,
        typeof value?.error === "string" ? value.error : "profile_unavailable",
      );
    return value as unknown;
  };
  const receipt = (value: unknown): ProfileMutationReceipt => {
    const row = record(value);
    if (
      row.schema !== "pirate.community-profile-mutation/1" ||
      typeof row.mutationId !== "string"
    )
      fail();
    return {
      schema: "pirate.community-profile-mutation/1",
      mutationId: row.mutationId as string,
      profile: decodeProfile(row.profile, communityId),
    };
  };
  return {
    async owner(signal) {
      const row = record(await request("/api/profile/owner", signal));
      if (
        row.schema !== "pirate.community-profile-owner/1" ||
        row.communityId !== communityId ||
        typeof row.accountId !== "string" ||
        row.accountId.length < 1 ||
        row.accountId.length > 128
      )
        fail();
      const capabilities = record(row.capabilities);
      if (
        capabilities.metadata !== true ||
        capabilities.handles !== false ||
        typeof capabilities.publicMedia !== "boolean"
      )
        fail();
      return {
        schema: "pirate.community-profile-owner/1",
        communityId,
        accountId: row.accountId as string,
        profile: decodeProfile(row.profile, communityId),
        capabilities: {
          metadata: true,
          publicMedia: capabilities.publicMedia as boolean,
          handles: false,
        },
      };
    },
    async public(id, signal) {
      author(id);
      return decodeProfile(
        await request(`/api/public/authors/${id}`, signal),
        communityId,
        id,
      );
    },
    async authors(ids, signal) {
      if (ids.length === 0) return [];
      if (ids.length > 32 || new Set(ids).size !== ids.length) fail();
      ids.forEach(author);
      const row = record(
        await request(`/api/public/authors?ids=${ids.join(",")}`, signal),
      );
      if (
        row.schema !== "pirate.community-profile-list/1" ||
        row.communityId !== communityId ||
        !Array.isArray(row.profiles) ||
        row.profiles.length > ids.length
      )
        fail();
      const profiles = (row.profiles as unknown[]).map((value) =>
        decodeProfile(value, communityId),
      );
      if (
        profiles.some((profile) => !ids.includes(profile.authorId)) ||
        new Set(profiles.map((profile) => profile.authorId)).size !==
          profiles.length
      )
        fail();
      return profiles;
    },
    async activity(id, cursor, signal) {
      author(id);
      const row = record(
        await request(
          `/api/public/authors/${id}/activity?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          signal,
        ),
      );
      if (
        row.schema !== "pirate.community-profile-activity/1" ||
        row.communityId !== communityId ||
        row.authorId !== id ||
        row.window !== "current-public-catalogue" ||
        !Array.isArray(row.items) ||
        row.items.length > 20 ||
        !(
          row.nextCursor === null ||
          (typeof row.nextCursor === "string" &&
            /^[0-9a-f]{64}$/.test(row.nextCursor))
        )
      )
        fail();
      const items = (row.items as unknown[]).map((value) => {
        const post = record(value),
          manifest = record(post.manifest),
          postId = author(manifest.postId);
        if (
          manifest.authorId !== id ||
          ![
            "pirate.community-post/1",
            "pirate.community-post/2",
            "pirate.community-post/3",
          ].includes(String(manifest.schema)) ||
          typeof manifest.title !== "string" ||
          manifest.title.length > 1024 ||
          typeof manifest.language !== "string" ||
          !["general", "adult"].includes(String(manifest.rating)) ||
          post.audioUrl !== `/api/public/posts/${postId}/audio` ||
          post.postUrl !== `/#song-${postId}` ||
          typeof post.transactionHash !== "string" ||
          !(
            post.lyricsText === undefined || typeof post.lyricsText === "string"
          )
        )
          fail();
        return {
          manifest: {
            schema: manifest.schema,
            postId,
            authorId: id,
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
        } as PublicSongView;
      });
      return {
        schema: "pirate.community-profile-activity/1",
        communityId,
        authorId: id,
        profile: decodeProfile(row.profile, communityId, id),
        items,
        nextCursor: row.nextCursor as string | null,
        window: "current-public-catalogue",
      };
    },
    async save(body, csrf, signal) {
      return receipt(await request("/api/profile/owner", signal, body, csrf));
    },
    async receipt(id, signal) {
      if (!/^[0-9a-f-]{36}$/.test(id)) fail();
      const row = record(
        await request(`/api/profile/owner/mutations/${id}`, signal),
      );
      if (row.schema !== "pirate.community-profile-receipt-read/1") fail();
      return row.receipt === null ? null : receipt(row.receipt);
    },
  };
}
