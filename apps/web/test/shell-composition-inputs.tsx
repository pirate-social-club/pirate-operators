/** Explicit offline component inputs for coordinator-isolated rendering.
 * No production mount, API/auth/storage client, camera or signing service.
 * Import the live stylesheet in the isolated harness and render this export.
 */
import { createMemo, createSignal } from "solid-js";
import type {
  CommunityFeed,
  CommunitySessionView,
} from "../src/api-contract.ts";
import { CommunityAppShell } from "../src/live/app-shell.tsx";
import { CommunityPages } from "../src/shell/community-pages.tsx";
import { projectSongPosts } from "../src/shell/decentralized-adapter.ts";
import type { ShellIntegrations } from "../src/shell/interfaces.ts";
import type { ProfileActivityDependencies } from "../src/shell/reference/profile-activity.tsx";
import type { AppView } from "../src/shell/routing.ts";

export const shellCompositionCases = [
  "community-empty",
  "community-song",
  "community-publisher",
  "song-detail",
  "library-unknown-history",
  "library-streaks",
  "profile-missing-data",
  "profile-loaded",
  "settings",
] as const;
export type ShellCompositionCase = (typeof shellCompositionCases)[number];

const account: CommunitySessionView = {
  authenticated: true,
  authorId: "0x" + "1".repeat(64),
  mossAddress: "0x" + "2".repeat(40),
  csrf: "offline-fixture-csrf",
  creator: null,
  pendingConnection: null,
  publicResults: "on",
  publisher: false,
};
const feed: CommunityFeed = {
  schema: "pirate.community-feed/1",
  communityId: "offline-fixture",
  posts: ["a", "b", "c"].map((id) => ({
    manifest: {
      schema: "pirate.community-post/3",
      postId: id,
      authorId: "published-fixture-author-id",
      title: `Fixture song ${id}`,
      language: "en",
      rating: "general",
    },
    audioUrl: `/fixture-audio/${id}.wav`,
    postUrl: `/posts/${id}`,
    transactionHash: "offline-fixture-receipt",
    lyricsText: "Fixture lyric line",
  })),
};

/** Pass a controllable loader to exercise abort/retry/stale-page assertions.
 * Omitting it supplies an explicitly offline empty page, never product data.
 */
export function ShellCompositionPreview(props: {
  scenario: ShellCompositionCase;
  activity?: ProfileActivityDependencies;
  onAction?: (name: string) => void;
}) {
  const [action, setAction] = createSignal("");
  const record = (name: string) => {
    setAction(name);
    props.onAction?.(name);
  };
  const view = (): AppView => {
    if (props.scenario === "song-detail") return "song";
    if (props.scenario.startsWith("profile-")) return "account";
    if (props.scenario.startsWith("library-")) return "songs";
    return props.scenario === "settings" ? "settings" : "home";
  };
  const session = () =>
    props.scenario === "community-empty" || props.scenario === "community-song"
      ? null
      : account;
  const projection = createMemo<ShellIntegrations>(() => ({
    version: 1,
    ...(props.scenario === "profile-loaded"
      ? {
          profile: {
            communityId: feed.communityId,
            account: account.mossAddress,
            name: "Fixture profile",
            handle: "fixture-profile",
            bio: "Explicit offline profile projection.",
            activitySource: props.activity ?? {
              loadPage: async () => ({ items: [], next_cursor: null }),
            },
          },
        }
      : {}),
    ...(props.scenario === "library-streaks"
      ? {
          songProgress: {
            communityId: feed.communityId,
            account: account.mossAddress,
            rows: [
              { postId: "a", currentStreak: 2 },
              { postId: "b", currentStreak: 0 },
              { postId: "c", currentStreak: 4 },
            ],
          },
        }
      : {}),
  }));
  const currentFeed = () =>
    props.scenario === "community-empty" ? { ...feed, posts: [] } : feed;
  const context = () => ({
    version: 1 as const,
    communityId: feed.communityId,
    session: session(),
    songs: currentFeed().posts,
  });
  return (
    <div data-shell-preview={props.scenario} data-last-action={action()}>
      <CommunityAppShell
        name="Fixture Community"
        communityId={feed.communityId}
        view={view()}
        walletPage={false}
        rewards={false}
        practiceOpen={false}
        signedIn={session() !== null}
        ready
        busy={false}
        canSignIn
        accountSeed={session()?.mossAddress}
        onSignIn={() => record("sign-in")}
      >
        <CommunityPages
          view={view()}
          hash={view() === "song" ? "#song-a" : `#/${view()}`}
          name="Fixture Community"
          communityId={feed.communityId}
          feed={currentFeed()}
          session={session()}
          settling={false}
          busy={false}
          error={false}
          study
          publisher={props.scenario === "community-publisher"}
          canSignIn
          rewards={false}
          offers={null}
          integrations={projection()}
          context={context}
          onNavigate={(href) => record(href)}
          onLearningLink={(href) => record(href)}
          onSignIn={() => record("sign-in")}
          onSignOut={() => record("sign-out")}
          onRefresh={() => record("refresh")}
        />
      </CommunityAppShell>
    </div>
  );
}

/** Authoritative fixture page for retry/pagination harnesses, with source cards. */
export function fixtureProfileActivityPage(cursor: string | null) {
  const post = projectSongPosts(feed)[cursor === null ? 0 : 1]!;
  return {
    items: [
      {
        kind: "post" as const,
        activity_id: post.id,
        community_id: feed.communityId,
        post,
        href: `/#song-${post.id}`,
      },
    ],
    next_cursor: cursor === null ? "fixture-page-2" : null,
  };
}
