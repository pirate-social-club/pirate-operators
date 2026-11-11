/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { Match, Show, Switch, createMemo } from "solid-js";

import {
  Button,
  Card,
  IconButton,
  IconCheckCircle,
  IconClock,
  IconWarningCircle,
  IconX,
  Spinner,
  Type,
  buttonVariants,
  cn,
} from "../../../design-system.ts";
import { createPhoneLayout } from "../../shell/composing-surface.tsx";
import { PendingSongs } from "./pending-songs.tsx";
import type { SongSubmissionItem } from "./song-submission-store.tsx";

/** The song a page's after-Post state names: who posted it, and which one. */
export interface PostedSongKey {
  readonly accountId: string;
  readonly submissionId: string;
}

/**
 * The posted song to show, if any. It belongs to the account that posted it:
 * under any other account, or none, there is nothing to show. The store's
 * entry wins; the kept last report stands in only for that same song and
 * account once the store has let it go.
 */
export function selectPostedSong(
  key: PostedSongKey | null,
  account: string | undefined,
  items: readonly SongSubmissionItem[],
  last: SongSubmissionItem | null,
): SongSubmissionItem | null {
  if (key === null || account !== key.accountId) return null;
  const current = items.find(
    (item) =>
      item.submissionId === key.submissionId &&
      item.accountId === key.accountId,
  );
  if (current !== undefined) return current;
  return last !== null &&
    last.accountId === key.accountId &&
    last.submissionId === key.submissionId
    ? last
    : null;
}

export interface PostedSongProps {
  /** The song as the store last reported it; kept by the host after the store lets it go. */
  readonly item: SongSubmissionItem;
  readonly onClose: () => void;
  readonly onCheck: (submissionId: string) => void;
  readonly onRetry: (submissionId: string) => void;
  readonly onRetryOriginal?: (submissionId: string) => void;
  readonly onBindOriginal?: (submissionId: string, link: string) => void;
  readonly onDismiss: (submissionId: string) => void;
}

/**
 * What the author sees right after posting a song: one vertically centred
 * state on the same page, not a card in the feed (Paper ruling 14,
 * Flows/Posts/Song 137-140). It follows the same store entry the feed's
 * pending card does, so closing it while the song is still being processed
 * leaves that card in the feed to carry the song from there.
 *
 * Paper draws processing, published, failed and waiting for review. The
 * states it does not draw (naming an original song, blocked, ended) keep the
 * pending card's own wording and controls inside this page.
 */
export function PostedSong(props: PostedSongProps): JSX.Element {
  const phone = createPhoneLayout();
  const view = () => props.item.view;
  const title = () =>
    props.item.title.trim() === "" ? "Untitled song" : props.item.title;
  const drawn = createMemo(() => {
    const status = view().status;
    return (
      status === "processing" ||
      status === "reconciling" ||
      status === "uploading" ||
      status === "published" ||
      status === "processing_failed" ||
      status === "manual_review"
    );
  });

  const reviewDetail = () => {
    const current = view();
    return current.status === "manual_review" &&
      current.reasonCode === "moderation_unavailable"
      ? "Automatic checks aren't available right now, so a moderator will check this song."
      : "A moderator will check this song.";
  };

  const header = () => (
    <header
      class={
        phone()
          ? "sticky top-0 z-20 -mx-4 grid min-h-14 grid-cols-[2.75rem_1fr_2.75rem] items-center bg-background px-3 pt-[env(safe-area-inset-top)]"
          : "-ms-2 flex items-center gap-2"
      }
    >
      <IconButton
        aria-label="Close song status"
        data-posted-song-close
        onClick={() => props.onClose()}
        type="button"
        variant="ghost"
      >
        <IconX class="size-5" />
      </IconButton>
      <Type
        as="h2"
        class={phone() ? "text-center" : undefined}
        variant={phone() ? "h3" : "h2"}
      >
        Song
      </Type>
    </header>
  );

  const state = (
    icon: JSX.Element,
    heading: string,
    detail: string,
    tone: "status" | "alert",
  ) => (
    <div class="flex flex-col items-center gap-3 text-center" role={tone}>
      {icon}
      <Type as="h3" variant="h3">
        {heading}
      </Type>
      <Type class="text-muted-foreground" variant="caption">
        {detail}
      </Type>
    </div>
  );

  const body = () => (
    <Show
      when={drawn()}
      fallback={
        <div class="w-full max-w-md">
          <PendingSongs
            items={[props.item]}
            onBindOriginal={props.onBindOriginal}
            onCheck={props.onCheck}
            onDismiss={props.onDismiss}
            onRetry={props.onRetry}
            onRetryOriginal={props.onRetryOriginal}
          />
        </div>
      }
    >
      <Switch>
        <Match when={view().status === "published"}>
          {state(
            <IconCheckCircle aria-hidden="true" class="size-10 text-success" />,
            "Published",
            title(),
            "status",
          )}
        </Match>
        <Match when={view().status === "processing_failed"}>
          {state(
            <IconWarningCircle
              aria-hidden="true"
              class="size-10 text-destructive-text"
            />,
            "Couldn't process this song",
            "Nothing was published.",
            "alert",
          )}
        </Match>
        <Match when={view().status === "manual_review"}>
          {state(
            <IconClock
              aria-hidden="true"
              class="size-10 text-muted-foreground"
            />,
            "Waiting for review",
            reviewDetail(),
            "status",
          )}
        </Match>
        <Match when={true}>
          <div
            aria-busy="true"
            class="flex flex-col items-center gap-3 text-center"
            role="status"
          >
            <Spinner class="size-10 text-primary" decorative size="lg" />
            <Type as="h3" variant="h3">
              Processing your song
            </Type>
            <Type class="text-muted-foreground" variant="caption">
              You can leave this page.
            </Type>
            <Show when={props.item.slow}>
              <Type class="text-muted-foreground" variant="caption">
                Checking on this song is taking longer than usual. Still trying.
              </Type>
              <Button
                onClick={() => props.onCheck(props.item.submissionId)}
                size="sm"
                type="button"
                variant="outline"
              >
                Check now
              </Button>
            </Show>
          </div>
        </Match>
      </Switch>
    </Show>
  );

  const action = () => {
    const current = view();
    if (current.status === "published") {
      // A full page load, as the pending card's link does: the post page is
      // server-rendered for its canonical address.
      return (
        <a
          class={cn(
            buttonVariants({ size: "lg" }),
            phone() ? "h-12 w-full" : "min-w-40",
          )}
          href={current.postHref}
          rel="external"
        >
          View song
        </a>
      );
    }
    if (current.status === "processing_failed" && current.retryable) {
      return (
        <Button
          class={phone() ? "h-12 w-full" : "min-w-40"}
          disabled={props.item.rerunning}
          loading={props.item.rerunning}
          onClick={() => props.onRetry(props.item.submissionId)}
          size="lg"
          type="button"
        >
          Try again
        </Button>
      );
    }
    return null;
  };

  return (
    <div
      class="w-full min-w-0"
      data-posted-song={props.item.submissionId}
      data-posted-song-status={view().status}
    >
      <Show
        when={phone()}
        fallback={
          <Card class="flex min-h-[28rem] w-full flex-col gap-5 p-5 md:p-6">
            {header()}
            <div class="flex flex-1 items-center justify-center py-8">
              {body()}
            </div>
            <Show when={action()}>
              {(button) => <div class="flex justify-center">{button()}</div>}
            </Show>
          </Card>
        }
      >
        <div class="flex min-h-dvh flex-col">
          {header()}
          <div class="flex flex-1 items-center justify-center py-8">
            {body()}
          </div>
          <Show when={action()}>
            {(button) => (
              <footer class="sticky bottom-0 z-20 -mx-4 border-t border-border-soft bg-background px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3">
                {button()}
              </footer>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
