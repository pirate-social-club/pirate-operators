/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";

import {
  Button,
  CommunityAvatar,
  IconMusicNote,
  Type,
} from "../../../design-system.ts";
import type { SongSubmissionView } from "../media-submission/projection.ts";
import type { SongSubmissionItem } from "./song-submission-store.tsx";

export interface PendingSongsProps {
  readonly items: readonly SongSubmissionItem[];
  readonly onCheck: (submissionId: string) => void;
  readonly onRetry: (submissionId: string) => void;
  readonly onRetryOriginal?: (submissionId: string) => void;
  readonly onBindOriginal?: (submissionId: string, link: string) => void;
  readonly onDismiss: (submissionId: string) => void;
  /**
   * Opens the song's status on this page. When given, each card gets a
   * separate Status button beside its other controls; the host decides what
   * may open. Left out where the card is itself shown inside a status.
   */
  readonly onOpenStatus?: (submissionId: string) => void;
}

/** The selector a host uses to return focus to a card's Status button. */
export function pendingSongStatusSelector(submissionId: string): string {
  return `[data-pending-song-open-status="${CSS.escape(submissionId)}"]`;
}

/**
 * What a submitted song says while the server works on it. One plain line:
 * the server's phases are not steps the author takes, and naming them, with a
 * step count, made a wait of about a minute read like a procedure. The
 * progress bar still advances with the phases. Owner wording, 2026-10-08.
 */
export const SONG_PROCESSING_TEXT =
  "Processing your song. This usually takes about a minute.";

/** How many server phases the progress bar spans. */
export const SONG_PROCESSING_PHASES = 4;

/**
 * Which stage the server is on, or null when the song is not being processed.
 * Reserve and upload happen inside the composer and are over by the time a
 * song is shown here, so they read as the first stage.
 */
export function songStageIndex(view: SongSubmissionView): number | null {
  if (view.status !== "processing") return null;
  switch (view.phase) {
    case "reserve":
    case "awaiting_upload":
    case "finalize":
      return 0;
    case "analysis":
      return 1;
    case "decision":
      return 2;
    case "publish":
      return 3;
  }
}

function songTitle(title: string): string {
  return title.trim() === "" ? "Untitled song" : title;
}

/** What to say about a song that is not simply moving through its stages. */
function attention(
  view: SongSubmissionView,
): { readonly text: string; readonly tone: "status" | "alert" } | null {
  switch (view.status) {
    case "manual_review":
      // Review is a decision waiting to be made, not the server working: say
      // so, so the author does not read it as a stuck upload. Which of the
      // two reasons applies is the server's word, and nothing more is known.
      return {
        text:
          view.reasonCode === "moderation_unavailable"
            ? "This song is waiting for review because automatic checks aren't available right now."
            : "This song is waiting for a moderator's review before it can be published.",
        tone: "status",
      };
    case "action_required":
      return {
        text: "The original song this one is based on has to be named before it can be published.",
        tone: "alert",
      };
    case "processing_failed":
      return {
        text: view.retryable
          ? "Processing stopped before this song was published."
          : "This song couldn't be processed and wasn't published.",
        tone: "alert",
      };
    case "blocked":
      return {
        text: "This song was blocked by policy and wasn't published.",
        tone: "alert",
      };
    case "abandoned":
      return {
        text: "This song submission ended before it was published.",
        tone: "alert",
      };
    default:
      return null;
  }
}

/**
 * The author's own songs that the server has accepted and not yet published,
 * shown at the top of the feed where the song will be. Each says which stage
 * the server is on. A wait for a moderator is worded differently from
 * processing, because it is a different kind of wait.
 */
export function PendingSongs(props: PendingSongsProps): JSX.Element {
  return (
    <For each={props.items.map((item) => item.submissionId)}>
      {(submissionId) => {
        const initial = props.items.find(
          (candidate) => candidate.submissionId === submissionId,
        );
        if (initial === undefined) return null;
        const item = () =>
          props.items.find(
            (candidate) => candidate.submissionId === submissionId,
          ) ?? initial;
        const [originalLink, setOriginalLink] = createSignal(
          initial.originalLink ?? "",
        );
        const postHref = () => {
          const view = item().view;
          return view.status === "published" ? view.postHref : null;
        };
        const retryable = () => {
          const view = item().view;
          return view.status === "processing_failed" && view.retryable;
        };
        const stage = () => songStageIndex(item().view);
        const note = () => attention(item().view);
        const author = () => item().authorHandle ?? "You";
        // The card is named by its title and described by its status, and the
        // Status button says which song it opens and refers to that status.
        const titleId = `pending-song-title-${submissionId}`;
        const statusId = `pending-song-status-${submissionId}`;
        const statusText = () => {
          if (item().view.status === "published") return "Published";
          if (stage() !== null) return SONG_PROCESSING_TEXT;
          return note()?.text ?? null;
        };
        return (
          <article
            aria-busy={item().view.status === "processing" ? "true" : "false"}
            aria-describedby={statusText() === null ? undefined : statusId}
            aria-labelledby={titleId}
            class="relative flex flex-col gap-3 border-b border-border-soft px-0 py-5 first:pt-0"
            data-pending-song={item().submissionId}
            data-pending-song-status={item().view.status}
          >
            <div class="flex items-center gap-2">
              <CommunityAvatar
                avatarSrc={item().authorAvatarSrc}
                communityId={item().submissionId}
                displayName={author()}
                size="xs"
              />
              <Type as="span" variant="label">
                {author()}
              </Type>
            </div>
            <div class="flex items-center gap-3 rounded-xl border border-border-soft bg-muted/30 p-3">
              <div class="grid size-14 shrink-0 place-items-center rounded-lg bg-secondary">
                <IconMusicNote class="size-7 text-muted-foreground" />
              </div>
              <div class="min-w-0 flex-1">
                <Type class="block truncate" id={titleId} variant="body-strong">
                  <Show when={postHref()} fallback={songTitle(item().title)}>
                    {/* A full page load, as publishing a song has always ended:
                        the post page is server-rendered for its canonical
                        address, which a client-side route change would skip. */}
                    {(href) => (
                      <a class="hover:underline" href={href()} rel="external">
                        {songTitle(item().title)}
                      </a>
                    )}
                  </Show>
                </Type>
                <Show when={item().view.status === "published"}>
                  <Type
                    class="block"
                    id={statusId}
                    role="status"
                    variant="caption"
                  >
                    Published
                  </Type>
                </Show>
                <Show when={stage() !== null}>
                  <Type
                    class="block"
                    id={statusId}
                    role="status"
                    variant="caption"
                  >
                    {SONG_PROCESSING_TEXT}
                  </Type>
                  <div
                    aria-label="Song processing"
                    aria-valuemax={SONG_PROCESSING_PHASES}
                    aria-valuemin={0}
                    aria-valuenow={(stage() ?? 0) + 1}
                    aria-valuetext="Processing your song"
                    class="mt-2 h-1 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                  >
                    <div
                      class="h-full rounded-full bg-primary"
                      style={{
                        width: `${(((stage() ?? 0) + 1) / SONG_PROCESSING_PHASES) * 100}%`,
                      }}
                    />
                  </div>
                </Show>
              </div>
            </div>
            <Show when={item().slow}>
              <div class="flex flex-wrap items-center gap-2" role="status">
                <Type variant="caption">
                  Checking on this song is taking longer than usual. Still
                  trying.
                </Type>
                <Button
                  onClick={() => props.onCheck(item().submissionId)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Check now
                </Button>
                {/* Not a cancel: the server goes on with the song either way. */}
                <Button
                  onClick={() => props.onDismiss(item().submissionId)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Stop watching here
                </Button>
              </div>
            </Show>
            <Show
              when={
                item().view.status === "action_required" &&
                item().canBindOriginal &&
                props.onBindOriginal
              }
            >
              <form
                aria-label="Name the original song"
                class="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  props.onBindOriginal?.(item().submissionId, originalLink());
                }}
              >
                <label class="grid gap-1 text-sm">
                  Original song link
                  <input
                    class="rounded-lg border border-input bg-background px-3 py-2"
                    value={
                      item().bindingOriginal || item().originalUnconfirmed
                        ? (item().originalLink ?? originalLink())
                        : originalLink()
                    }
                    onInput={(event) =>
                      setOriginalLink(event.currentTarget.value)
                    }
                    disabled={
                      item().bindingOriginal || item().originalUnconfirmed
                    }
                    inputmode="url"
                    required
                    placeholder="Paste the song's link"
                  />
                </label>
                <Type variant="caption">
                  The server will check that this song can use that original.
                </Type>
                <Button
                  disabled={
                    item().bindingOriginal ||
                    item().originalUnconfirmed ||
                    originalLink().trim() === ""
                  }
                  loading={item().bindingOriginal}
                  type="submit"
                  size="sm"
                >
                  Use this original song
                </Button>
                <Show when={item().originalUnconfirmed}>
                  <Type role="status" variant="caption">
                    This original song request is still unconfirmed. Check it or
                    repeat the same request before choosing another.
                  </Type>
                  <Button
                    disabled={item().bindingOriginal}
                    onClick={() => props.onRetryOriginal?.(item().submissionId)}
                    type="button"
                    size="sm"
                  >
                    Try this original again
                  </Button>
                  <Button
                    disabled={item().bindingOriginal}
                    onClick={() => props.onCheck(item().submissionId)}
                    type="button"
                    size="sm"
                    variant="outline"
                  >
                    Check original song request
                  </Button>
                </Show>
                <Show when={item().originalError}>
                  {(error) => (
                    <Type role="alert" variant="caption">
                      {error()}
                    </Type>
                  )}
                </Show>
              </form>
            </Show>
            <Show when={note()}>
              {(current) => (
                <div
                  class="flex flex-wrap items-center gap-2"
                  role={current().tone}
                >
                  <Type id={statusId} variant="caption">
                    {current().text}
                  </Type>
                  <Show when={retryable()}>
                    <Button
                      disabled={item().rerunning}
                      loading={item().rerunning}
                      onClick={() => props.onRetry(item().submissionId)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Try processing again
                    </Button>
                  </Show>
                  <Show when={item().view.status !== "manual_review"}>
                    <Button
                      onClick={() => props.onDismiss(item().submissionId)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Dismiss
                    </Button>
                  </Show>
                </div>
              )}
            </Show>
            {/* Status sits on its own row, after the card's controls and never
                around them, so each control stays a sibling of the others. */}
            <Show when={props.onOpenStatus}>
              {(open) => (
                <div class="flex justify-end">
                  <Button
                    aria-describedby={
                      statusText() === null ? undefined : statusId
                    }
                    aria-label={`Status for ${songTitle(item().title)}`}
                    data-pending-song-open-status={item().submissionId}
                    onClick={() => open()(item().submissionId)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Status
                  </Button>
                </div>
              )}
            </Show>
          </article>
        );
      }}
    </For>
  );
}
