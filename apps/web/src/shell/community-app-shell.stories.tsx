import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { expect, fn, within } from "storybook/test";
import { CommunityAppShell } from "../live/app-shell.tsx";
import { CommunityPages } from "./community-pages.tsx";
import { danceUrl } from "./routing.ts";
import type { CommunityFeed, CommunitySessionView } from "../api-contract.ts";

const postId = "0x" + "12".repeat(32);
const communityId = "0x" + "34".repeat(32);
const authorId = "0x" + "56".repeat(32);
const fixtureLyrics = "A fixture lyric line\nA second fixture lyric line";
const feed: CommunityFeed = {
  schema: "pirate.community-feed/1",
  communityId,
  posts: [
    {
      manifest: {
        schema: "pirate.community-post/4",
        postId,
        authorId,
        title: "Sample song",
        language: "en",
        rating: "general",
      },
      audioUrl: "/storybook-no-audio",
      lyricsText: fixtureLyrics,
      postUrl: "/#song-" + postId,
      transactionHash: "0x" + "78".repeat(32),
    },
  ],
};
const session: CommunitySessionView = {
  authenticated: true,
  authorId,
  mossAddress: "0x" + "12".repeat(20),
  csrf: "storybook-fixture",
  creator: null,
  pendingConnection: null,
  publicResults: "off",
  publisher: true,
};

function ShellFixture(props: {
  signedIn: boolean;
  ready: boolean;
  busy: boolean;
  onSignIn: () => void;
  view: "home" | "song";
  hasPublicAuthor: boolean;
}) {
  return (
    <CommunityAppShell
      name="Catalog community"
      communityId={communityId}
      view={props.view}
      walletPage={false}
      rewards={false}
      practiceOpen={false}
      signedIn={props.signedIn}
      ready={props.ready}
      busy={props.busy}
      canSignIn
      accountSeed="catalog-preview"
      onSignIn={props.onSignIn}
    >
      <CommunityPages
        view={props.view}
        hash={props.view === "song" ? "#song-" + postId : "#/"}
        name="Catalog community"
        communityId={communityId}
        feed={props.ready ? feed : null}
        session={props.signedIn ? session : null}
        settling={!props.ready}
        busy={props.busy}
        error={false}
        study
        publisher={props.signedIn}
        canSignIn
        rewards={false}
        offers={null}
        integrations={{
          version: 1,
          postAuthors: props.hasPublicAuthor
            ? {
                communityId,
                rows: [{ authorId, displayName: "Publisher" }],
              }
            : undefined,
          danceNavigation: {
            postHref: (id) =>
              danceUrl(new URL("/", location.origin), communityId, {
                kind: "post",
                postId: id,
              }).href,
            open: fn(),
          },
        }}
        context={() => ({
          version: 1,
          communityId,
          session: props.signedIn ? session : null,
          songs: feed.posts,
        })}
        onSignIn={props.onSignIn}
        onSignOut={fn()}
        onRefresh={fn()}
        onNavigate={fn()}
        onLearningLink={fn()}
      />
    </CommunityAppShell>
  );
}

const meta = {
  title: "Screens/Shell/Community app shell",
  component: ShellFixture,
  args: {
    signedIn: false,
    ready: true,
    busy: false,
    onSignIn: fn(),
    view: "home",
    hasPublicAuthor: true,
  },
  render: (args) => <ShellFixture {...args} />,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Renders the production CommunityAppShell and CommunityPages used by the live entry. Paper references: Screens/Community/CommunityPage and Screens/Posts/Post. Community/song/account values are labelled story fixtures; no SDK, authentication, audio or service runs. Optional social/reward data is absent. Visual comparison and real routing remain separate checks.",
      },
    },
  },
} satisfies Meta<typeof ShellFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Anonymous: Story = {};
export const SignedIn: Story = { args: { signedIn: true } };
export const ResolvingSession: Story = { args: { ready: false } };
export const Busy: Story = { args: { busy: true } };

export const Song: Story = {
  args: { signedIn: true, view: "song" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Sample song" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("navigation", { name: "Song activities" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Play Sample song" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("link", { name: /^Terms$/ }),
    ).not.toBeInTheDocument();
    const post = canvas.getByRole("main");
    await expect(post.getByText("Publisher", { exact: true })).toBeVisible();
    await expect(
      post.getByRole("heading", { level: 1, name: "Sample song" }),
    ).toBeVisible();
    await expect(
      post.getByRole("heading", { level: 2, name: "Lyrics" }),
    ).toBeVisible();
    await expect(
      post.getByText("A fixture lyric line A second fixture lyric line", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      post.getByRole("button", { name: "Post options" }),
    ).toBeVisible();
    const activities = post.getByRole("navigation", {
      name: "Song activities",
    });
    for (const [label, query] of [
      ["Study", "study"],
      ["Karaoke", "sing"],
    ]) {
      await expect(
        activities.getByRole("link", { name: label }),
      ).toHaveAttribute("href", "/?" + query + "=" + postId);
    }
    const dance = activities.getByRole("link", { name: /^Dance$/u });
    const danceHref = new URL(
      dance.getAttribute("href")!,
      canvasElement.ownerDocument.URL,
    );
    const origin = new URL(canvasElement.ownerDocument.URL).origin;
    await expect(danceHref.origin).toBe(origin);
    await expect(danceHref.pathname).toBe(
      "/dance/" + communityId + "/posts/" + postId,
    );
    const documentElement = canvasElement.ownerDocument.documentElement;
    await expect(documentElement.scrollWidth).toBeLessThanOrEqual(
      documentElement.clientWidth,
    );
  },
};
export const AnonymousSong: Story = { args: { view: "song" } };

export const SongWithoutPublicAuthor: Story = {
  args: { signedIn: true, view: "song", hasPublicAuthor: false },
  play: async ({ canvasElement }) => {
    const post = within(canvasElement).getByRole("main");
    await expect(post.getByText("Unknown author")).toBeVisible();
    await expect(post.queryByRole("link", { name: "Unknown author" })).toBeNull();
    await expect(post.queryByText("Publisher")).toBeNull();
  },
};
