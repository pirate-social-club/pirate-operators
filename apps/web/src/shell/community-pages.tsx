import { fragmentNavigationHref } from "./routing.ts";
import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { CommunityFeed, CommunitySessionView } from "../api-contract.ts";
import type { RewardAvailableOffers } from "../../../../packages/rewards/contracts.ts";
import {
  Avatar,
  Button,
  Card,
  CardContent,
  IconArrowLeft,
  IconButton,
  MobilePageHeader,
  Type,
  buttonVariants,
} from "./design-system.ts";
import { CommunityPageShell } from "./reference/community-page-shell.tsx";
import { CommunityPostCard } from "./reference/community-post-card.tsx";
import { ProfileLayout } from "./reference/profile-layout.tsx";
import { ProfileActivity } from "./reference/profile-activity.tsx";
import { YourSongsPage } from "./reference/your-songs-page.tsx";
import { projectSongPosts, songLibrary } from "./decentralized-adapter.ts";
import type { ShellFeatureContext, ShellIntegrations } from "./interfaces.ts";
import type { AppView } from "./routing.ts";

export interface CommunityPagesProps {
  view: AppView;
  hash: string;
  name: string;
  communityId: string;
  feed: CommunityFeed | null;
  session: CommunitySessionView | null;
  settling: boolean;
  busy: boolean;
  error: boolean;
  study: boolean;
  publisher: boolean;
  canSignIn: boolean;
  rewards: boolean;
  offers: RewardAvailableOffers | null;
  integrations?: ShellIntegrations;
  context: () => ShellFeatureContext;
  composer?: () => JSX.Element;
  pendingSongs?: () => JSX.Element;
  pendingSongCount?: number;
  onSignIn: () => void;
  onSignOut: () => void;
  onRefresh: () => void;
  onNavigate: (href: string) => void;
  onLearningLink: (href: string) => void;
  onDownload?: () => void;
}

const back = () =>
  history.length > 1 ? history.back() : location.assign("/#/");

/** Pure page assembly. Reference layout/markup lives in the copied components. */
export function CommunityPages(props: CommunityPagesProps) {
  const posts = () =>
    props.feed
      ? projectSongPosts(
          props.feed,
          props.integrations?.postAuthors?.communityId === props.communityId
            ? props.integrations.postAuthors
            : undefined,
        )
      : [];
  const community = () => ({
    id: props.communityId,
    name: props.name,
    posts: posts(),
  });
  const post = () =>
    props.feed?.posts.find(
      (song) => song.manifest.postId === props.hash.slice(6),
    );
  const cardPost = () =>
    posts().find((song) => song.id === props.hash.slice(6));
  const canPost = () =>
    !props.settling &&
    props.session !== null &&
    (props.publisher ||
      (props.integrations?.publicPosting === "allowed" &&
        props.integrations.publicComposer !== undefined));
  const profile = () => {
    const value = props.integrations?.profile;
    return value &&
      value.communityId === props.communityId &&
      value.account.toLowerCase() === props.session?.mossAddress.toLowerCase()
      ? value
      : undefined;
  };
  const feedLead = () => (
    <>
      {props.pendingSongs?.()}
      {props.integrations?.drawSummary?.(props.context())}
      {props.integrations?.publicFeed?.(props.context())}
    </>
  );
  const library = () =>
    props.feed
      ? songLibrary({
          feed: props.feed,
          communityId: props.communityId,
          account: props.session?.mossAddress,
          progress: props.integrations?.songProgress,
          currentUrl: new URL(location.href),
          study: props.study,
        })
      : null;
  return (
    <>
      <Show when={props.view === "home" || props.view === "publish"}>
        <CommunityPageShell
          community={community()}
          feed={() =>
            props.feed
              ? { kind: "ready", posts: posts() }
              : { kind: props.error ? "error" : "loading" }
          }
          onRetry={props.onRefresh}
          onBack={back}
          onCreatePost={
            canPost() ? () => props.onNavigate("/#/publish") : undefined
          }
          createPostBusy={props.busy}
          createPostLabel="Post"
          profileControl={
            <Show
              when={props.session}
              fallback={
                <Show when={props.canSignIn}>
                  <Button
                    class="md:hidden"
                    size="sm"
                    variant="ghost"
                    onClick={props.onSignIn}
                  >
                    Sign in
                  </Button>
                </Show>
              }
            >
              <IconButton
                aria-label="Open profile"
                class="size-10 rounded-full bg-background/75 p-0 text-foreground backdrop-blur-sm"
                onClick={() => props.onNavigate("/#/account")}
                variant="ghost"
              >
                <Avatar
                  fallback="Profile"
                  fallbackSeed={props.session?.mossAddress}
                  size="sm"
                />
              </IconButton>
            </Show>
          }
          composer={
            props.view === "publish" && props.session
              ? props.composer
              : undefined
          }
          feedLeadCount={props.pendingSongCount ?? 0}
          feedLead={
            (props.pendingSongCount ?? 0) > 0 ||
            props.integrations?.drawSummary ||
            props.integrations?.publicFeed
              ? feedLead
              : undefined
          }
        />
      </Show>
      <Show when={props.view === "songs"}>
        <Show
          when={library()}
          fallback={
            <YourSongsPage
              songs={[]}
              state={props.error ? "unavailable" : "loading"}
              navigate={props.onLearningLink}
              onRetry={props.onRefresh}
            />
          }
        >
          {(collection) => (
            <YourSongsPage
              songs={collection().active}
              state={props.session ? collection().state : "signed-out"}
              trending={collection().remaining}
              trendingState="ready"
              navigate={props.onLearningLink}
              onSignIn={props.onSignIn}
              onRetry={props.onRefresh}
            />
          )}
        </Show>
      </Show>
      <Show when={props.view === "song"}>
        {/* Authored public-post route frame and song activity row from c7cb8783
          public-post-route-view.tsx. The media/card is the same component as feed. */}
        <main
          class="mx-auto w-full min-w-0 max-w-[704px] px-5 pt-[calc(env(safe-area-inset-top)+4.5rem)] pb-12 md:px-8 md:pb-12 md:pt-6"
          data-public-post-state={post() ? "content" : "unavailable"}
        >
          <MobilePageHeader
            class="md:hidden"
            density="compact"
            onBackClick={back}
            onTitleClick={() => props.onNavigate("/#/")}
            title={props.name}
            titleActionAriaLabel={`Open ${props.name}`}
            titleAvatarFallback={props.name}
          />
          <div
            class="hidden h-14 items-center gap-2 md:flex"
            data-post-page-header
          >
            <IconButton
              aria-label="Back"
              class="size-10"
              onClick={back}
              variant="ghost"
            >
              <IconArrowLeft class="size-5" />
            </IconButton>
            <a
              class="flex min-w-0 items-center gap-2 rounded-full hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href="/#/"
            >
              <Avatar
                class="text-[10px] leading-3"
                fallback={props.name}
                size="xs"
              />
              <span class="truncate text-base font-semibold leading-6 text-foreground">
                {props.name}
              </span>
            </a>
          </div>
          <Show
            when={cardPost()}
            fallback={
              <>
                <Type as="h1" variant="h2">
                  Post unavailable
                </Type>
                <a class={buttonVariants({ variant: "secondary" })} href="/#/">
                  Go home
                </a>
              </>
            }
          >
            {(song) => (
              <article class="min-w-0" lang={post()?.manifest.language}>
                <div class="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 border-b border-border-soft pb-5">
                  <h1 class="sr-only">{song().title}</h1>
                  <CommunityPostCard
                    flush
                    post={song()}
                    menuActions={[
                      {
                        label: "Publication receipt",
                        run: () => {
                          window.open(
                            `/api/public/posts/${song().id}/proof`,
                            "_blank",
                            "noopener,noreferrer",
                          );
                        },
                      },
                    ]}
                  />
                  <nav
                    aria-label="Song activities"
                    class="grid grid-cols-2 gap-3"
                  >
                    <Show when={props.study}>
                      <a
                        class={buttonVariants({
                          variant: "secondary",
                          class: "min-w-0 justify-center",
                        })}
                        href={`/?study=${song().id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          props.onLearningLink(event.currentTarget.href);
                        }}
                      >
                        Study
                      </a>
                    </Show>
                    <a
                      class={buttonVariants({
                        variant: "secondary",
                        class: "min-w-0 justify-center",
                      })}
                      href={`/?sing=${song().id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        props.onLearningLink(event.currentTarget.href);
                      }}
                    >
                      Karaoke
                    </a>
                  </nav>
                  {/* The reference activity row follows the card/available
                    activity slots. Published lyrics are supplemental API data,
                    kept below those actions rather than delaying them. */}
                  <Show when={post()?.lyricsText}>
                    {(lyrics) => (
                      <Type
                        as="p"
                        variant="body"
                        class="whitespace-pre-wrap break-words"
                      >
                        {lyrics()}
                      </Type>
                    )}
                  </Show>
                  <Show when={props.session && props.rewards && props.offers}>
                    <For
                      each={props.offers?.offers.filter(
                        (offer) => offer.postId === song().id,
                      )}
                    >
                      {(offer) => (
                        <details>
                          <summary>
                            Lottery reward · {offer.ticketCount}{" "}
                            {offer.ticketCount === 1 ? "ticket" : "tickets"}
                          </summary>
                          <p>
                            Practice rewards have no cash value in this pilot.
                            Complete Study with at least 70% correct on the
                            first try, or Karaoke with a score of at least 70%
                            and at least 90% of lines measured. One entry per
                            account.
                          </p>
                          <p>
                            Complete and publish your result between{" "}
                            {new Date(offer.opensAt).toLocaleString()} and{" "}
                            {new Date(offer.cutoffAt).toLocaleString()}.
                            Winnings are shared equally among qualifying
                            accounts. There may be no prize. Any remainder stays
                            with the operator.
                          </p>
                          <p>
                            Winning shares appear in your wallet. Scan your palm
                            to claim; payments are approved daily. Unclaimed
                            shares stay available. If nobody qualifies, winnings
                            stay with the operator.
                          </p>
                        </details>
                      )}
                    </For>
                  </Show>
                </div>
              </article>
            )}
          </Show>
        </main>
      </Show>
      <Show when={props.view === "account"}>
        <Show
          when={props.session && profile() ? props.session : null}
          fallback={<AccountSettings {...props} profile />}
        >
          {(account) => (
            <ProfileLayout
              name={profile()!.name}
              handle={profile()?.handle}
              avatarRef={profile()?.avatarRef}
              coverRef={profile()?.coverRef}
              bio={profile()?.bio}
              servingOrigin={location.origin}
              settingsControl={
                <a
                  class={buttonVariants({ variant: "outline" })}
                  href={fragmentNavigationHref(
                    "/#/settings",
                    typeof location === "undefined"
                      ? undefined
                      : new URL(location.href),
                  )}
                >
                  Settings
                </a>
              }
            >
              <Show when={profile()?.activitySource}>
                {(dependencies) => (
                  <ProfileActivity
                    profileId={account().mossAddress}
                    dependencies={dependencies()}
                  />
                )}
              </Show>
              {profile()?.activity?.(props.context())}
            </ProfileLayout>
          )}
        </Show>
        <Show when={!props.settling && props.session?.mossAddress} keyed>
          {(_account) => (
            <>{props.integrations?.privateDance?.(props.context())}</>
          )}
        </Show>
      </Show>
      <Show when={props.view === "settings"}>
        <AccountSettings {...props} />
      </Show>
      <Show when={props.view === "missing"}>
        <main class="mx-auto w-full max-w-3xl px-4 py-8">
          <Type as="h1" variant="h2">
            Post unavailable
          </Type>
          <a class={buttonVariants({ variant: "secondary" })} href="/#/">
            Go home
          </a>
        </main>
      </Show>
    </>
  );
}

/** AccountPage presentation from c7cb8783 shell/account-page.tsx. Centralized
 * persona/session/deletion services are replaced with the existing MOSS actions.
 * Profile identity/activity are supplied separately, never inferred from balance.
 */
function AccountSettings(props: CommunityPagesProps & { profile?: boolean }) {
  return (
    <main
      class="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-8"
      data-route-path={props.profile ? "/me" : "/settings"}
    >
      <Type as="h1" variant="h1">
        {props.profile ? "Profile" : "Settings"}
      </Type>
      <Card>
        <CardContent class="flex flex-col gap-4 p-5">
          <Show
            when={props.session}
            fallback={
              <>
                <Type>Sign in to manage your profiles.</Type>
                <Show when={props.canSignIn}>
                  <Button class="self-start" onClick={props.onSignIn}>
                    Sign in with MOSS
                  </Button>
                </Show>
              </>
            }
          >
            {(account) => (
              <>
                <Type as="p" variant="caption" class="break-all">
                  {account().mossAddress}
                </Type>
                <div class="flex flex-wrap gap-2">
                  <Show when={props.rewards}>
                    <Button
                      variant="outline"
                      onClick={() => props.onNavigate("/wallet")}
                    >
                      Wallet
                    </Button>
                  </Show>
                  <Button
                    variant="outline"
                    onClick={() =>
                      props.onNavigate(
                        props.profile ? "/#/settings" : "/#/account",
                      )
                    }
                  >
                    {props.profile ? "Settings" : "View profile"}
                  </Button>
                </div>
                <Show when={props.onDownload}>
                  <Button
                    class="self-start"
                    variant="outline"
                    disabled={props.busy}
                    onClick={props.onDownload}
                  >
                    Download private history
                  </Button>
                </Show>
                {props.integrations?.accountSettings?.(props.context())}
                <Button
                  class="self-start"
                  variant="ghost"
                  onClick={props.onSignOut}
                  disabled={props.busy}
                >
                  Sign out
                </Button>
              </>
            )}
          </Show>
        </CardContent>
      </Card>
    </main>
  );
}
