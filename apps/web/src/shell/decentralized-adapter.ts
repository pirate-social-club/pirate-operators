import type { CommunityFeed } from "../api-contract.ts";
import type { LibrarySong } from "./reference/your-songs-page.tsx";
import type { CommunityPost } from "./reference/community-model.ts";
import type { ShellIntegrations } from "./interfaces.ts";
import { publicPlaybackAccess } from "./playback-access.ts";
import { activityUrl } from "./routing.ts";

const publicProfilePath = (value?: string) => {
  const path = value?.trim();
  return path?.startsWith("/") && !path.startsWith("//") && !path.includes("\\")
    ? path
    : undefined;
};

/** Preserve server ordering. No rating, time, engagement or profile is inferred. */
export function projectSongPosts(
  feed: CommunityFeed,
  authors?: ShellIntegrations["postAuthors"],
): CommunityPost[] {
  const rows =
    authors && authors.communityId === feed.communityId ? authors.rows : [];
  const profiles = new Map(rows.map((row) => [row.authorId, row]));
  // An ambiguous projection is not an authoritative public identity.
  const unambiguous = profiles.size === rows.length;
  return feed.posts.map((song): CommunityPost => {
    const profile = unambiguous
      ? profiles.get(song.manifest.authorId)
      : undefined;
    const label = profile?.publicHandle?.trim() || profile?.displayName?.trim();
    return {
      id: song.manifest.postId,
      kind: "song",
      title: song.manifest.title,
      mediaTitle: song.manifest.title,
      body: "",
      technicalAuthorId: song.manifest.authorId,
      authorHandle: label || undefined,
      // No avatar/profile link is asserted when no public identity was supplied.
      authorAvatarSrc: label
        ? publicProfilePath(profile?.avatarRef)
        : undefined,
      authorHref: label ? publicProfilePath(profile?.profileHref) : undefined,
      readPlayback: async () => publicPlaybackAccess(song.audioUrl),
    };
  });
}

export function songLibrary(input: {
  feed: CommunityFeed;
  communityId: string;
  account?: string;
  progress?: ShellIntegrations["songProgress"];
  currentUrl: URL;
  study: boolean;
}): {
  state: "ready" | "not-yet-available";
  active: LibrarySong[];
  remaining: LibrarySong[];
} {
  const progress = input.progress;
  const rows = new Map(
    progress?.rows.map((row) => [row.postId, row.currentStreak]),
  );
  const valid =
    progress !== undefined &&
    input.account !== undefined &&
    progress.communityId === input.communityId &&
    progress.account.toLowerCase() === input.account.toLowerCase() &&
    rows.size === progress.rows.length &&
    progress.rows.every(
      (row) =>
        Number.isSafeInteger(row.currentStreak) && row.currentStreak >= 0,
    ) &&
    input.feed.posts.every((song) => rows.has(song.manifest.postId));
  const songs: LibrarySong[] = input.feed.posts.map((song) => ({
    id: song.manifest.postId,
    title: song.manifest.title,
    studyPath: input.study
      ? activityUrl(input.currentUrl, "study", song.manifest.postId).href
      : undefined,
    karaokePath: activityUrl(input.currentUrl, "sing", song.manifest.postId)
      .href,
    currentStreak: valid ? rows.get(song.manifest.postId) : undefined,
    activities: input.study ? ["study", "karaoke"] : ["karaoke"],
  }));
  return {
    state: valid ? "ready" : "not-yet-available",
    active: valid
      ? songs
          .filter((song) => song.currentStreak! > 0)
          .sort((a, b) => b.currentStreak! - a.currentStreak!)
      : [],
    remaining: valid ? songs.filter((song) => song.currentStreak === 0) : songs,
  };
}
