import type {
  CommunityCapabilities,
  CommunityFeed,
  CommunitySessionView,
} from "../api-contract.ts";

export const RELEASE_POLICY = "pirate-release/2026-08-29";
export const OWNER_RELEASE_POLICY = "pirate-owner-curated/2026-11-08/1";
export const SINGLE_CURATED_RELEASE = "pirate-owner-curated/2026-11-05/1";
export const SONG_BYTES = 25 * 1024 * 1024;
export interface CommunityHostContext {
  community: { id: string; name: string; origin: string };
  language: string;
  session: CommunitySessionView;
  /** Genuine private owner projection supplied by the host, never inferred. */
  owner: {
    accountId: string;
    authorId: string;
    communityId: string;
    generation: string;
  };
  capabilities: CommunityCapabilities;
  feed: CommunityFeed;
}
export function requireHost(
  value: CommunityHostContext | null,
): CommunityHostContext {
  if (
    !value ||
    !value.session.authenticated ||
    !/^[a-f0-9-]{36}$/i.test(value.owner.accountId) ||
    !value.owner.generation ||
    value.owner.communityId !== value.community.id ||
    value.feed.communityId !== value.community.id ||
    value.owner.authorId !== value.session.authorId ||
    value.owner.accountId === value.session.authorId ||
    value.owner.accountId === value.session.mossAddress ||
    !value.session.csrf ||
    !value.language ||
    new URL(value.community.origin).origin !== value.community.origin
  )
    throw new Error("Private community account authority is unavailable.");
  return value;
}
export function captureCommunityOwner(
  current: () => CommunityHostContext | null,
) {
  const initial = requireHost(current());
  const identity = JSON.stringify([
    initial.community.id,
    initial.owner.accountId,
    initial.session.authorId,
    initial.owner.generation,
  ]);
  const abort = new AbortController();
  const active = () => {
    try {
      const next = requireHost(current());
      return (
        !abort.signal.aborted &&
        identity ===
          JSON.stringify([
            next.community.id,
            next.owner.accountId,
            next.session.authorId,
            next.owner.generation,
          ])
      );
    } catch {
      return false;
    }
  };
  return {
    communityId: initial.community.id,
    accountId: initial.owner.accountId,
    authorId: initial.session.authorId,
    identity,
    signal: abort.signal,
    active,
    get current() {
      if (!active())
        throw new Error(
          "Community account or route changed. Reopen the saved release explicitly.",
        );
      return requireHost(current());
    },
    assert() {
      if (!active())
        throw new Error(
          "Community account or route changed. Reopen the saved release explicitly.",
        );
    },
    dispose() {
      abort.abort();
    },
  };
}
export type CommunityOwner = ReturnType<typeof captureCommunityOwner>;
export function songCapability(context: CommunityHostContext) {
  const policy = context.capabilities.policyVersion;
  return {
    allowed:
      context.session.publisher &&
      context.capabilities.upload &&
      context.capabilities.publication &&
      [RELEASE_POLICY, OWNER_RELEASE_POLICY].includes(policy),
    reason:
      policy === SINGLE_CURATED_RELEASE
        ? "This curated release accepts no new submission."
        : "Song release requires the authorized publisher and an available release service.",
  };
}
export async function fileHash(file: Blob) {
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return (
    "0x" +
    Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}
export function mp3Issue(file: File): string | null {
  return !file.size ||
    file.size > SONG_BYTES ||
    !file.name.toLowerCase().endsWith(".mp3") ||
    (file.type && file.type !== "audio/mpeg")
    ? "Choose an MP3 of up to 25 MiB."
    : null;
}
