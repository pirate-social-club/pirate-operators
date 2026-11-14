// Independently owned presentation from src/features/community/page-shell/page-shell.tsx @ c7cb87835a1858a1955c820b03d566365e6d42db
// Exact extraction/adapter boundaries: docs/v1-shell-owner-correction-20261111.md.
import {
  For,
  Loading,
  Show,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  Button,
  Card,
  CardContent,
  CommunityAvatar,
  FlatTabBar,
  FlatTabButton,
  IconArrowLeft,
  IconButton,
  Type,
  createMediaQuery,
} from "../design-system.ts";
import {
  CommunityMoreMenu,
  shareCommunityLink,
  type CommunityManageAuthority,
  type CommunityMoreAction,
} from "./community-more-menu.tsx";
import {
  CommunityPostCard,
  communityFeedListClass,
} from "./community-post-card.tsx";
import type { ContentAction } from "./content-overflow-menu.tsx";
import {
  orderedCommunityRules,
  orderedReferenceLinks,
  safeCommunityHref,
  type CommunityData,
  type CommunityFeed,
  type CommunityPost,
} from "./community-model.ts";
export interface CommunityPageShellProps {
  community: CommunityData;
  following?: boolean;
  joined?: boolean;
  onFollowToggle?: () => void;
  onJoin?: () => void;
  followBusy?: boolean;
  joinBusy?: boolean;
  joinDisabled?: boolean;
  joinLabel?: string;
  onManage?: () => void;
  /**
   * The viewer's profile for this community, drawn as a round button in the
   * banner beside More. The host owns what it opens.
   */
  profileControl?: JSX.Element;
  /** The community's public address for Share; the current page when absent. */
  shareUrl?: string;
  onCreatePost?: () => void;
  createPostBusy?: boolean;
  createPostLabel?: string;
  onBack?: () => void;
  canJoin?: boolean;
  /**
   * The feed, read inside this shell's own loading boundary. Reading it may
   * suspend, which is why it is a function and not a value: the surrounding
   * chrome stays rendered while the region it belongs to waits.
   */
  feed?: () => CommunityFeed;
  onRetry?: () => void;
  /**
   * True while the viewer's session or membership is still settling. Controls
   * that depend on it hold their space without claiming what they do not know.
   */
  authorityPending?: boolean;
  /**
   * True while the viewer's membership was read and the read failed. The
   * controls stay actionable so a retry is possible, but they say only that
   * the state needs checking, never that the viewer is or is not a member.
   */
  viewerUnknown?: boolean;
  /**
   * True while management authority alone is still settling. Separate from
   * authorityPending, because a slow moderation read must not hold the follow,
   * join, post or persona controls that no longer depend on anything.
   */
  managePending?: boolean;
  /**
   * The open text composer replaces the feed in the main content column.
   * It stays in the page flow at every width.
   */
  composer?: () => JSX.Element;
  /** The viewer's own posts still being delivered, shown above the feed. */
  feedLead?: () => JSX.Element;
  /** How many entries the lead holds, so an empty feed is not called empty. */
  feedLeadCount?: number;
  /** Server-backed activity summary supplied by the owning activity lane. */
  aboutLeaderboard?: () => JSX.Element;
  initialTab?: "feed" | "songs" | "about";
  /** Feed posts kept first whatever the sort, newest pin first. */
  pinnedPostIds?: readonly string[];
  renderPost?: (
    post: CommunityPost,
    render: (
      actions?: JSX.Element,
      menuActions?: readonly ContentAction[],
    ) => JSX.Element,
  ) => JSX.Element;
}

type CommunityTab = "feed" | "songs" | "about";
const primaryShadowClass = "shadow-[0_8px_22px_#0000000F]";
const formatCount = (value: number) => value.toLocaleString("en-US");
function FeedPending() {
  return (
    <Card>
      <CardContent class="p-6">
        <Type aria-live="polite" role="status" variant="body">
          Loading community posts…
        </Type>
      </CardContent>
    </Card>
  );
}

const aboutCardClass =
  "md:rounded-[var(--radius-3xl)] md:shadow-none max-md:rounded-none max-md:border-0 max-md:bg-transparent max-md:shadow-none";
const aboutHeadingClass = "leading-7 tracking-normal";

function CommunityAbout(props: {
  community: CommunityData;
  leaderboard?: () => JSX.Element;
}) {
  const community = () => props.community;
  return (
    <div class="flex flex-col gap-4 max-md:gap-8">
      <Card class={aboutCardClass}>
        <CardContent class="flex flex-col gap-3 p-5 max-md:p-0">
          <Type class={aboutHeadingClass} variant="h3">
            About
          </Type>
          <Type variant="body">{community().description}</Type>
        </CardContent>
      </Card>
      <Show when={props.leaderboard}>{(board) => board()()}</Show>
      <Show when={community().rules?.length}>
        <Card class={aboutCardClass}>
          <CardContent class="flex flex-col gap-4 p-5 max-md:p-0">
            <Type class={aboutHeadingClass} variant="h3">
              Rules
            </Type>
            <ol class="flex flex-col gap-4">
              <For each={orderedCommunityRules(community().rules ?? [])}>
                {(rule, index) => (
                  <li class="flex gap-3">
                    <span class="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold leading-4 text-foreground">
                      {index() + 1}
                    </span>
                    <div class="flex flex-col gap-0.5">
                      <Type variant="body-strong">{rule.title}</Type>
                      <Type class="text-sm" variant="caption">
                        {rule.body}
                      </Type>
                    </div>
                  </li>
                )}
              </For>
            </ol>
          </CardContent>
        </Card>
      </Show>
      <Show when={community().referenceLinks?.length}>
        <Card class={aboutCardClass}>
          <CardContent class="flex flex-col gap-3 p-5 max-md:p-0">
            <Type class={aboutHeadingClass} variant="h3">
              Links
            </Type>
            <nav aria-label="Community reference links">
              <ul class="flex flex-col gap-2">
                <For
                  each={orderedReferenceLinks(community().referenceLinks ?? [])}
                >
                  {(link) => (
                    <Show when={safeCommunityHref(link.href)}>
                      {(href) => (
                        <li>
                          <a
                            aria-label={`Open ${link.label}`}
                            class="text-foreground underline underline-offset-4"
                            href={href()}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {link.label}
                          </a>
                        </li>
                      )}
                    </Show>
                  )}
                </For>
              </ul>
            </nav>
          </CardContent>
        </Card>
      </Show>
    </div>
  );
}

const bannerGradientClass =
  "bg-linear-120/oklab from-[oklab(27.8%_-0.024_-0.018)] via-[oklab(53.9%_-0.028_0.008)] via-45% to-[oklab(78%_0.0007_0.062)]";

function CommunityBanner(props: {
  community: CommunityData;
  /** Reported on the More triggers so a surface can read it without opening them. */
  manage: CommunityManageAuthority;
  moreActions: readonly CommunityMoreAction[];
  onBack?: () => void;
  /** Feed sort, rendered left of More when the shell has one. */
  sortControl?: JSX.Element;
  /** The viewer's profile here, rendered right of More. */
  profileControl?: JSX.Element;
}) {
  return (
    <div
      class={`relative h-36 overflow-hidden md:h-56 ${bannerGradientClass}`}
      data-community-banner
    >
      <Show when={props.community.bannerSrc}>
        {(src) => (
          <>
            <img alt="" class="size-full object-cover" src={src()} />
            {/* A photo can be light or busy, so only a photo cover darkens
              beneath the overlay controls. */}
            <div
              aria-hidden="true"
              class="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/5 via-transparent to-black/45"
              data-community-banner-scrim
            />
          </>
        )}
      </Show>
      <div class="absolute inset-x-0 top-0 flex items-center justify-between px-3 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:p-5">
        <IconButton
          aria-label="Go back"
          class="size-10 bg-background/75 text-foreground backdrop-blur-sm"
          onClick={props.onBack}
          variant="ghost"
        >
          <IconArrowLeft class="size-5" />
        </IconButton>
        <div class="flex items-center gap-2" data-community-banner-actions>
          {props.sortControl}
          {/* More is there for every viewer; its rows follow the viewer:
              Share always, Unfollow for a follower, Manage for a manager. */}
          <CommunityMoreMenu
            actions={props.moreActions}
            manage={props.manage}
          />
          {props.profileControl}
        </div>
      </div>
    </div>
  );
}

export function CommunityPageShell(props: CommunityPageShellProps) {
  const [sort, setSort] = createSignal("Best");
  // ownedWrite: the width effect below returns a desktop viewer from About.
  const [tab, setTab] = createSignal<CommunityTab>(props.initialTab ?? "feed", {
    ownedWrite: true,
  });
  const community = () => props.community;
  const hasAbout = () =>
    !!(
      community().description ||
      community().rules?.length ||
      community().referenceLinks?.length ||
      props.aboutLeaderboard
    );
  // About is a tab on a phone and a card beside the feed on desktop, so a
  // viewer who widens the window on About returns to the feed it sits beside.
  const desktop = createMediaQuery("(min-width: 768px)");
  createEffect(
    () => desktop() && tab() === "about",
    (aboutOnDesktop) => {
      if (aboutOnDesktop) setTab("feed");
    },
  );
  // Reading this is what suspends; a host that passes no feed has its posts
  // already in hand, so nothing waits.
  // Both header slots are this size in every state, so a label change cannot
  // resize them and a viewport change cannot make them wrap.
  const slotClass = "h-11 w-full min-w-0 md:w-32";
  const settledViewer = () => !props.authorityPending && !props.viewerUnknown;
  const confirmedMember = () =>
    props.onCreatePost !== undefined && settledViewer();
  /**
   * A follower who has not joined has one thing left to do here, so Join takes
   * the whole row and Unfollow moves into More. An account that cannot join
   * keeps its follow control, which is then its only action.
   */
  const followerOnly = () =>
    props.following &&
    !props.joined &&
    settledViewer() &&
    props.canJoin !== false;
  const membershipSlotClass = () =>
    followerOnly() || props.onFollowToggle === undefined ? "col-span-2 h-11 w-full min-w-0" : slotClass;
  /**
   * More's rows for this viewer. Unfollow is offered only to a settled
   * follower who is not a member: a member may not unfollow (spec 016 §4.6).
   * Leave has no API endpoint yet, so it is not offered.
   */
  const moreActions = (): CommunityMoreAction[] => [
    {
      id: "share",
      label: "Share",
      run: () =>
        void shareCommunityLink(
          props.shareUrl ?? window.location.href,
          community().name,
        ),
    },
    ...(props.following &&
    !props.joined &&
    settledViewer() &&
    !props.followBusy &&
    props.onFollowToggle !== undefined
      ? [
          {
            id: "unfollow" as const,
            label: "Unfollow",
            run: () => props.onFollowToggle?.(),
          },
        ]
      : []),
    ...(props.onManage !== undefined
      ? [
          {
            id: "manage" as const,
            label: "Manage",
            run: () => props.onManage?.(),
          },
        ]
      : []),
  ];
  const feed = (): CommunityFeed =>
    props.feed?.() ?? { kind: "ready", posts: community().posts };
  const hasAgeLocks = () => false;
  const agePrompt = () => undefined;
  /**
   * What each viewer control says, and what it says to a screen reader. A
   * pending control reports that it is checking; a control whose read failed
   * asks to check again. Neither reports a membership or a follow direction.
   */
  const followLabel = () => {
    if (props.followBusy)
      return { text: "Saving…", description: "Saving your follow" };
    if (props.authorityPending)
      return { text: "Checking…", description: "Checking your follow state" };
    if (props.viewerUnknown)
      return {
        text: "Check follow",
        description: "Check your follow state again",
      };
    return props.following
      ? { text: "Following", description: "Unfollow this community" }
      : { text: "Follow", description: "Follow this community" };
  };
  const joinLabel = () => {
    if (props.authorityPending || props.joinBusy) {
      return { text: "Checking…", description: "Checking your membership" };
    }
    if (props.viewerUnknown)
      return {
        text: "Check membership",
        description: "Check your membership again",
      };
    if (props.joined)
      return {
        text: "Joined",
        description: "You are a member of this community",
      };
    return {
      text: props.joinLabel ?? "Join",
      description: props.joinLabel ?? "Join this community",
    };
  };
  const feedPosts = () => {
    const current = feed();
    return current.kind === "ready" ? current.posts : [];
  };
  // Ordering is the authoritative community feed order; no invented score/time.
  const sortedPosts = createMemo(feedPosts);
  const songs = createMemo(() =>
    sortedPosts().filter((post) => post.kind === "song"),
  );
  const renderPost = (post: CommunityPost) => {
    // The ID route redirects to the API-owned thread. Native navigation keeps
    // router preloading from starting a competing redirect.
    const render = (
      actions?: JSX.Element,
      menuActions?: readonly ContentAction[],
    ) => (
      <CommunityPostCard
        actions={actions}
        menuActions={menuActions}
        communityId={props.community.id}
        post={post}
        titleHref={`/#song-${post.id}`}
        nativeNavigation
      />
    );
    return props.renderPost?.(post, render) ?? render();
  };
  // Keep this owned subtree stable for SSR hydration key allocation.
  const sortControl = () => undefined;

  return (
    <div
      class="mx-auto w-full max-w-6xl bg-background"
      data-community-page
      data-composing={props.composer ? "true" : undefined}
    >
      {/* On a phone, writing is the whole screen: the banner and the community
          header give way to the composer's own action bar. Desktop keeps them
          beside the form, as accepted on 2026-10-07. */}
      <div
        class={props.composer ? "max-md:hidden" : "contents"}
        data-community-chrome
      >
        <CommunityBanner
          community={community()}
          manage={
            props.onManage !== undefined
              ? "available"
              : (props.managePending ?? props.authorityPending)
                ? "pending"
                : "unavailable"
          }
          moreActions={moreActions()}
          onBack={props.onBack}
          profileControl={props.profileControl}
          sortControl={
            props.composer || tab() === "about" ? undefined : sortControl()
          }
        />

        <section
          aria-label="Community overview"
          class="relative bg-background px-5 pb-5 pt-5 md:px-8 md:pb-6 md:pt-6"
        >
          <div class="md:flex md:items-center md:gap-4">
            <div class="min-w-0 md:flex-1">
              {/* The avatar sits below the banner rather than overlapping it, and
                the title and counts are centered against it. */}
              <div class="flex min-w-0 items-center gap-3 md:gap-4">
                <div class="shrink-0">
                  {/* Initials are 0.85em of the disc's font size: 24px on a
                    phone and 28px on desktop, both semibold. */}
                  <CommunityAvatar
                    avatarSrc={community().avatarSrc}
                    class="size-20 border-0 text-[calc(24px/0.85)] md:size-24 md:text-[calc(28px/0.85)]"
                    communityId={community().id ?? community().handle}
                    displayName={community().name}
                    size="lg"
                  />
                </div>
                <div class="min-w-0 flex-1">
                  <Type
                    as="h1"
                    class="line-clamp-2 text-2xl md:text-3xl"
                    variant="h1"
                  >
                    {community().name}
                  </Type>
                  <Type class="mt-1 block truncate text-sm" variant="caption">
                    <Show when={community().handle}>
                      {(handle) => (
                        <>{`@${handle().replace(/^c\//u, "").replace(/^@/u, "")}`}</>
                      )}
                    </Show>
                    <Show when={community().members !== undefined}>
                      <span>
                        {" "}
                        · {formatCount(community().members!)} members
                      </span>
                    </Show>
                    <Show when={community().followers !== undefined}>
                      <span class="hidden md:inline">
                        {" "}
                        · {formatCount(community().followers!)} followers
                      </span>
                    </Show>
                    <span
                      class={props.joined === true ? "" : "invisible"}
                      data-community-membership-status
                      aria-hidden={props.joined === true ? undefined : "true"}
                    >
                      {" "}
                      · Member
                    </span>
                  </Type>
                </div>
              </div>
              {/* The description is the About tab's on a phone and the About
                card's on desktop; the header carries none. */}
            </div>
            {/* The reserved group keeps its size while authority settles. A
              member gets one useful command spanning the two visitor slots. */}
            <Show
              when={props.onCreatePost || props.onFollowToggle || props.onJoin}
            >
              <div
                aria-label="Community actions"
                class={
                  props.composer
                    ? "hidden"
                    : "mt-5 grid h-11 grid-cols-2 gap-3 md:mt-0 md:w-[16.75rem] md:shrink-0"
                }
                data-community-actions-reserved
                role="group"
              >
                <Show
                  when={confirmedMember()}
                  fallback={
                    <>
                      <Show when={!followerOnly() && props.onFollowToggle !== undefined}>
                        <Button
                          aria-label={followLabel().description}
                          class={slotClass}
                          data-community-follow-slot
                          disabled={props.followBusy || props.authorityPending}
                          loading={props.followBusy || props.authorityPending}
                          onClick={() => props.onFollowToggle?.()}
                          variant={props.following ? "secondary" : "outline"}
                        >
                          <span
                            class={
                              props.followBusy || props.authorityPending
                                ? "sr-only"
                                : "truncate"
                            }
                          >
                            {followLabel().text}
                          </span>
                        </Button>
                      </Show>
                      <Show
                        when={props.canJoin !== false}
                        fallback={<div class={slotClass} aria-hidden="true" />}
                      >
                        <Show
                          when={
                            props.joinDisabled &&
                            !props.authorityPending &&
                            !props.viewerUnknown &&
                            !props.joinBusy
                          }
                          fallback={
                            <Button
                              aria-label={joinLabel().description}
                              class={`${membershipSlotClass()} ${primaryShadowClass}`}
                              data-community-membership-slot
                              disabled={
                                props.authorityPending || props.joinBusy
                              }
                              loading={props.authorityPending || props.joinBusy}
                              onClick={() => props.onJoin?.()}
                            >
                              <span
                                class={
                                  props.authorityPending || props.joinBusy
                                    ? "sr-only"
                                    : "truncate"
                                }
                              >
                                {joinLabel().text}
                              </span>
                            </Button>
                          }
                        >
                          <div
                            class={`${membershipSlotClass()} flex items-center justify-center`}
                            data-community-membership-slot
                            role="status"
                          >
                            <Type variant="caption" class="truncate">
                              {props.joinLabel ?? "Unavailable"}
                            </Type>
                          </div>
                        </Show>
                      </Show>
                    </>
                  }
                >
                  <Button
                    class={`col-span-2 h-11 w-full min-w-0 ${primaryShadowClass}`}
                    data-community-post-slot
                    disabled={
                      props.createPostBusy || props.composer !== undefined
                    }
                    loading={props.createPostBusy}
                    onClick={() => {
                      setTab("feed");
                      props.onCreatePost?.();
                    }}
                  >
                    {props.createPostBusy
                      ? "Opening…"
                      : (props.createPostLabel ?? "Post")}
                  </Button>
                </Show>
              </div>
            </Show>
          </div>
        </section>
      </div>

      <Show when={!props.composer}>
        <div data-community-tabs>
          {/* A phone shares the width among three tabs. Desktop keeps Feed and
            Songs at their own width on the left; About is the card beside
            the feed there. */}
          <FlatTabBar class="px-5 md:px-8 [&>div]:gap-0 max-md:[&>div]:flex-1 md:[&>div]:gap-2">
            <FlatTabButton
              active={tab() === "feed"}
              class="max-md:flex-1 md:px-4"
              onClick={() => setTab("feed")}
            >
              Feed
            </FlatTabButton>
            <FlatTabButton
              active={tab() === "songs"}
              class="max-md:flex-1 md:px-4"
              onClick={() => setTab("songs")}
            >
              Songs
            </FlatTabButton>
            <Show when={hasAbout()}>
              <FlatTabButton
                active={tab() === "about"}
                class="max-md:flex-1 md:hidden"
                onClick={() => setTab("about")}
              >
                About
              </FlatTabButton>
            </Show>
          </FlatTabBar>
        </div>
      </Show>

      <div
        class={
          props.composer
            ? "grid gap-8 px-4 pb-6 md:grid-cols-[minmax(0,1fr)_20rem] md:p-8"
            : tab() === "about"
              ? "grid gap-8 px-5 pb-8 pt-5 md:grid-cols-[minmax(0,1fr)_20rem] md:p-8"
              : "grid gap-8 p-5 md:grid-cols-[minmax(0,1fr)_20rem] md:p-8"
        }
      >
        {/* About is a view at every width. It used to be a mobile-only tab:
            at desktop the main column came back through md:block and rendered
            nothing, so asking for the community's details replaced the feed
            with a blank column beside an aside that was already there. */}
        <main
          class={!props.composer && tab() === "about" ? "hidden" : "min-w-0"}
          aria-label={props.composer ? "Create a post" : "Community feed"}
        >
          <Show
            when={props.composer}
            fallback={
              <>
                <Show when={tab() === "feed"}>
                  <Show when={props.feedLead}>
                    {(lead) => (
                      <div class="flex flex-col" data-community-feed-lead>
                        {lead()()}
                      </div>
                    )}
                  </Show>
                  <Loading fallback={<FeedPending />}>
                    <Show
                      when={feed().kind === "ready"}
                      fallback={
                        <Show
                          when={feed().kind === "loading"}
                          fallback={
                            <Card>
                              <CardContent class="p-6">
                                <Type role="alert" variant="body">
                                  Community posts are temporarily unavailable.
                                </Type>
                                <Button
                                  variant="outline"
                                  onClick={props.onRetry}
                                >
                                  Try again
                                </Button>
                              </CardContent>
                            </Card>
                          }
                        >
                          <FeedPending />
                        </Show>
                      }
                    >
                      {agePrompt()}
                      <Show
                        when={
                          sortedPosts().length > 0 ||
                          hasAgeLocks() ||
                          props.feedLead !== undefined
                        }
                        fallback={
                          <Card>
                            <CardContent class="p-6">
                              <Type variant="body">
                                No posts in this community yet.
                              </Type>
                            </CardContent>
                          </Card>
                        }
                      >
                        <div
                          class={
                            (props.feedLeadCount ?? 0) > 0
                              ? `${communityFeedListClass} pt-5`
                              : communityFeedListClass
                          }
                        >
                          <For each={sortedPosts()}>
                            {(post) => renderPost(post)}
                          </For>
                        </div>
                      </Show>
                    </Show>
                  </Loading>
                </Show>
                <Show when={tab() === "songs"}>
                  <Loading fallback={<FeedPending />}>
                    {agePrompt()}
                    <Show
                      when={songs().length > 0 || hasAgeLocks()}
                      fallback={
                        <Card>
                          <CardContent class="p-6">
                            <Type variant="body">
                              No songs in this community yet.
                            </Type>
                          </CardContent>
                        </Card>
                      }
                    >
                      <div class={communityFeedListClass}>
                        <For each={songs()}>{(post) => renderPost(post)}</For>
                      </div>
                    </Show>
                  </Loading>
                </Show>
              </>
            }
          >
            {(composer) => composer()()}
          </Show>
        </main>

        {/* Community information remains beside the main content on desktop. */}
        <aside
          aria-label="Community information"
          class={
            !props.composer && tab() === "about"
              ? "flex flex-col gap-4 md:col-span-2 md:max-w-3xl"
              : "max-md:contents md:flex md:min-w-0 md:flex-col md:gap-4"
          }
        >
          <div
            class={
              !props.composer && tab() === "about"
                ? "contents"
                : "hidden md:block"
            }
            data-community-about
          >
            <Show when={hasAbout()}>
              <CommunityAbout
                community={community()}
                leaderboard={props.aboutLeaderboard}
              />
            </Show>
          </div>
        </aside>
      </div>
    </div>
  );
}
