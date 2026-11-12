import { SongContentFrame } from "../player/song-content-frame.tsx";
// Independently owned presentation from src/features/community/page-shell/page-shell.tsx @ c7cb87835a1858a1955c820b03d566365e6d42db
// Exact extraction/adapter boundaries: docs/v1-shell-owner-correction-20261111.md.
import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { CommunityAvatar, IconMusicNote, Type } from "../design-system.ts";
import { SongPlayer } from "./song-player.tsx";
import {
  ContentOverflowMenu,
  type ContentAction,
} from "./content-overflow-menu.tsx";
import { compactRelativeTime } from "./relative-time.ts";
import type { CommunityPost } from "./community-model.ts";
export const communityFeedListClass =
  "flex flex-col [&>*:first-child_[data-community-post]]:pt-0 [&>[data-community-post]:first-child]:pt-0 [&>*:last-child_[data-community-post]]:border-b-0 [&>[data-community-post]:last-child]:border-b-0";
function SongPost(props: {
  post: CommunityPost;
  titleHref?: string;
  nativeNavigation?: boolean;
  isolatePlayback?: boolean;
}) {
  return (
    <SongContentFrame
      title={props.post.mediaTitle ?? props.post.title}
      artworkSrc={props.post.mediaSrc}
      artist={props.post.mediaArtist}
      titleHref={props.titleHref}
      nativeNavigation={props.nativeNavigation}
    >
      <SongPlayer
        compact
        postId={props.post.id}
        title={props.post.mediaTitle ?? props.post.title}
        cacheAccess={false}
        readAccess={props.post.readPlayback}
      />
    </SongContentFrame>
  );
}

export function CommunityPostCard(props: {
  post: CommunityPost;
  communityId?: string;
  titleHref?: string;
  nativeNavigation?: boolean;
  actions?: JSX.Element;
  menuActions?: readonly ContentAction[];
  flush?: boolean;
  detail?: boolean;
  isolatePlayback?: boolean;
}) {
  const author = () => props.post.authorHandle ?? "Unknown author";
  return (
    <article
      class={
        props.flush
          ? "relative flex flex-col gap-3"
          : "relative flex flex-col gap-3 border-b border-border-soft py-5"
      }
      data-community-post={props.post.id}
    >
      <div class="flex items-center gap-2">
        <CommunityAvatar
          avatarSrc={props.post.authorAvatarSrc}
          communityId={props.post.authorPersonaId ?? props.post.id}
          displayName={author()}
          size="xs"
        />
        <Type
          as="span"
          class="min-w-0 truncate text-sm leading-5"
          variant="label"
        >
          <Show when={props.post.authorHref} fallback={author()}>
            {(href) => (
              <a href={href()} class="relative z-10 hover:underline">
                {author()}
              </a>
            )}
          </Show>
        </Type>
        <Show when={compactRelativeTime(props.post.publishedAt ?? "")}>
          {(age) => (
            <Type as="span" class="shrink-0 text-sm" variant="caption">
              <time
                datetime={props.post.publishedAt}
                title={new Date(props.post.publishedAt!).toUTCString()}
              >
                {age()}
              </time>
            </Type>
          )}
        </Show>
        <div class="relative z-10 ml-auto flex shrink-0 items-center">
          <ContentOverflowMenu
            inline
            label="Post options"
            actions={props.menuActions}
          />
        </div>
      </div>
      <Show when={props.post.kind === "video"}>
        <Show when={props.post.body.trim()}>
          {(body) => (
            <Type variant="body">
              <Show when={props.titleHref} fallback={body()}>
                {(href) => (
                  <a
                    href={href()}
                    rel={props.nativeNavigation ? "external" : undefined}
                    class="hover:underline after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                  >
                    {body()}
                  </a>
                )}
              </Show>
            </Type>
          )}
        </Show>
        <Show when={!props.post.body.trim() && props.titleHref}>
          {(href) => (
            <a
              class="sr-only"
              href={href()}
              rel={props.nativeNavigation ? "external" : undefined}
            >
              Open video post
            </a>
          )}
        </Show>
        <Show when={props.post.kind === "video" ? props.post : undefined}>
          {(video) => (
            <div
              class="relative z-10 aspect-[9/16] w-[252px] max-w-full overflow-hidden rounded-xl bg-muted"
              data-community-video={video().id}
            >
              {video().video}
            </div>
          )}
        </Show>
      </Show>
      <Show when={props.post.kind !== "video"}>
        <Show
          when={props.post.kind === "song"}
          fallback={
            <>
              <Type
                as={props.detail ? "h1" : undefined}
                class={props.detail ? "break-words leading-7" : undefined}
                variant="h3"
              >
                <Show when={props.titleHref} fallback={props.post.title}>
                  {(href) => (
                    <a
                      href={href()}
                      aria-label={
                        props.post.title.trim()
                          ? undefined
                          : props.post.body
                              .trim()
                              .replace(/\s+/gu, " ")
                              .slice(0, 120) || "Open post"
                      }
                      rel={props.nativeNavigation ? "external" : undefined}
                      class="hover:underline after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                    >
                      {props.post.title}
                    </a>
                  )}
                </Show>
              </Type>
              <Show when={!props.detail || props.post.body.trim()}>
                <Type
                  as={props.detail ? "p" : undefined}
                  class={
                    props.detail ? "whitespace-pre-wrap break-words" : undefined
                  }
                  variant="body"
                >
                  {props.post.body}
                </Type>
              </Show>
            </>
          }
        >
          {/* The card names the song and the player plays it; a body that only
            repeats the song title is not commentary and is not shown. */}
          <Show
            when={
              props.post.body &&
              props.post.body !== (props.post.mediaTitle ?? props.post.title)
            }
          >
            <Type variant="body">{props.post.body}</Type>
          </Show>
          <SongPost
            post={props.post}
            titleHref={props.titleHref}
            nativeNavigation={props.nativeNavigation}
            isolatePlayback={props.isolatePlayback}
          />
        </Show>
      </Show>
      <div
        class={props.titleHref ? "relative z-10 w-fit max-w-full" : undefined}
      >
        <Show when={props.actions}>
          <div
            class="flex flex-wrap items-center gap-2 pt-1"
            role="group"
            aria-label="Post actions"
          >
            {props.actions}
          </div>
        </Show>
      </div>
    </article>
  );
}
