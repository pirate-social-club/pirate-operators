// Song picker for a video's soundtrack: the community's published songs,
// loaded a feed page at a time and filtered as the author types. Tapping a
// song plays a preview; "Use" commits it. Pasting a song link in the same
// field loads that song instead, so there is no separate "paste a link" step.
// The search field filters only loaded rows, so while a search is typed and
// more pages remain the list says so rather than implying a community-wide
// search.

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";

import {
  Button,
  IconButton,
  IconLink,
  IconMagnifyingGlass,
  IconPause,
  IconPlay,
  IconX,
  Input,
  Spinner,
  Type,
} from "../../../design-system.ts";
import { looksLikeSongLink } from "./song-excerpt-link.ts";

export interface SongPickerItem {
  readonly postId: string;
  readonly title: string;
  readonly artist: string;
  readonly artworkSrc: string | null;
}

/** One page of the community's songs plus the cursor of the next page, so the
 * picker can offer more without pretending the list was complete. */
export interface SongPickerPage {
  readonly songs: readonly SongPickerItem[];
  readonly nextCursor: string | null;
}

export type SongPickerSource = (
  communityId: string,
  cursor: string | null,
  personaId?: string,
) => Promise<SongPickerPage>;

export async function filterVideoReadySongs(
  candidates: readonly SongPickerItem[],
  read: (
    postId: string,
  ) => Promise<Readonly<{ can_post_with_song: boolean; video_ready: boolean }>>,
): Promise<readonly SongPickerItem[]> {
  const ready = Array.from({ length: candidates.length }, () => false);
  let index = 0;
  // A feed page is bounded, but checking all its songs at once would burst
  // authenticated policy reads and exact-object HEADs at the API.
  await Promise.all(
    Array.from({ length: Math.min(4, candidates.length) }, async () => {
      while (index < candidates.length) {
        const at = index++;
        const policy = await read(candidates[at]!.postId);
        ready[at] =
          policy.can_post_with_song === true && policy.video_ready === true;
      }
    }),
  );
  return candidates.filter((_, at) => ready[at]);
}

/** Resolves a song's playable audio for a preview; an empty string means the
 * song has no audio yet. */
export type SongPreviewSource = (
  postId: string,
  signal: AbortSignal,
) => Promise<string>;

type PreviewState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly postId: string }
  | { readonly kind: "playing"; readonly postId: string }
  | { readonly kind: "paused"; readonly postId: string }
  | { readonly kind: "unavailable"; readonly postId: string };

export function SongPicker(props: {
  communityId?: string;
  personaId?: string;
  source: SongPickerSource;
  preview?: SongPreviewSource;
  onPick: (postId: string) => void;
  onLink: (value: string) => void;
  onClose?: () => void;
  linkProblem?: string;
}) {
  const source = props.source;
  const previewSource = props.preview;
  const [songs, setSongs] = createSignal<readonly SongPickerItem[]>([], {
    ownedWrite: true,
  });
  const [state, setState] = createSignal<
    "loading" | "ready" | "failed" | "choose_profile"
  >("loading", { ownedWrite: true });
  const [nextCursor, setNextCursor] = createSignal<string | null>(null, {
    ownedWrite: true,
  });
  const [moreState, setMoreState] = createSignal<"idle" | "loading" | "failed">(
    "idle",
    { ownedWrite: true },
  );
  const [query, setQuery] = createSignal("");
  const [preview, setPreview] = createSignal<PreviewState>(
    { kind: "idle" },
    { ownedWrite: true },
  );
  let audio: HTMLAudioElement | undefined;
  let pending: AbortController | undefined;
  let loadGeneration = 0;

  const load = (
    communityId: string | undefined,
    personaId: string | undefined,
  ) => {
    const generation = ++loadGeneration;
    if (communityId === undefined) {
      setSongs([]);
      setState("ready");
      return;
    }
    setSongs([]);
    setNextCursor(null);
    if (!personaId?.trim()) {
      setState("choose_profile");
      return;
    }
    setState("loading");
    setMoreState("idle");
    void source(communityId, null, personaId).then(
      (page) => {
        if (generation !== loadGeneration) return;
        setSongs(page.songs);
        setNextCursor(page.nextCursor);
        setState("ready");
      },
      () => {
        if (generation === loadGeneration) setState("failed");
      },
    );
  };
  createEffect(
    () => [props.communityId, props.personaId] as const,
    ([communityId, personaId]) => load(communityId, personaId),
  );

  const loadMore = () => {
    const communityId = props.communityId;
    const personaId = props.personaId;
    const cursor = nextCursor();
    if (
      communityId === undefined ||
      cursor === null ||
      moreState() === "loading"
    )
      return;
    const generation = loadGeneration;
    setMoreState("loading");
    void source(communityId, cursor, personaId).then(
      (page) => {
        if (generation !== loadGeneration) return;
        setSongs((current) => [...current, ...page.songs]);
        setNextCursor(page.nextCursor);
        setMoreState("idle");
      },
      () => {
        if (generation === loadGeneration) setMoreState("failed");
      },
    );
  };

  const stopPreview = () => {
    pending?.abort();
    pending = undefined;
    audio?.pause();
  };
  onCleanup(() => {
    ++loadGeneration;
    stopPreview();
  });

  /** The row the author last tapped, whether or not its audio is playing. */
  const activeId = () => {
    const current = preview();
    return current.kind === "idle" ? undefined : current.postId;
  };

  const togglePreview = (postId: string) => {
    const current = preview();
    if (current.kind !== "idle" && current.postId === postId) {
      if (current.kind === "playing") {
        audio?.pause();
        setPreview({ kind: "paused", postId });
        return;
      }
      if (current.kind === "paused" && audio) {
        setPreview({ kind: "playing", postId });
        void audio
          .play()
          .catch(() => setPreview({ kind: "unavailable", postId }));
        return;
      }
      if (current.kind === "loading" || current.kind === "unavailable") return;
    }
    stopPreview();
    if (!previewSource || !audio) {
      setPreview({ kind: "unavailable", postId });
      return;
    }
    const element = audio;
    const controller = new AbortController();
    pending = controller;
    setPreview({ kind: "loading", postId });
    void previewSource(postId, controller.signal).then(
      (url) => {
        if (controller.signal.aborted) return;
        if (url === "") {
          setPreview({ kind: "unavailable", postId });
          return;
        }
        element.src = url;
        element.currentTime = 0;
        setPreview({ kind: "playing", postId });
        void element.play().catch(() => {
          if (!controller.signal.aborted)
            setPreview({ kind: "unavailable", postId });
        });
      },
      () => {
        if (!controller.signal.aborted)
          setPreview({ kind: "unavailable", postId });
      },
    );
  };

  const use = (postId: string) => {
    stopPreview();
    props.onPick(postId);
  };

  const isLink = () => looksLikeSongLink(query());
  const searching = () => query().trim() !== "";
  const matches = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (needle === "" || isLink()) return songs();
    return songs().filter((song) =>
      `${song.title} ${song.artist}`.toLowerCase().includes(needle),
    );
  });

  return (
    <div class="grid gap-3">
      <audio
        class="hidden"
        onEnded={() => {
          const current = preview();
          if (current.kind === "playing")
            setPreview({ kind: "paused", postId: current.postId });
        }}
        preload="none"
        ref={(element) => {
          audio = element;
        }}
      />
      <div class="flex items-center gap-2">
        <Show when={props.onClose}>
          {(close) => (
            <IconButton
              aria-label="Close"
              onClick={() => {
                stopPreview();
                close()();
              }}
              variant="ghost"
            >
              <IconX class="size-5" />
            </IconButton>
          )}
        </Show>
        <div class="relative min-w-0 flex-1">
          <IconMagnifyingGlass
            aria-hidden="true"
            class="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search songs or paste a link"
            class="ps-9"
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search songs or paste a link"
            type="search"
            value={query()}
          />
        </div>
      </div>

      <Show when={isLink()}>
        <button
          class="flex min-h-14 items-center gap-3 rounded-[var(--radius-lg)] px-2 text-start transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            stopPreview();
            props.onLink(query());
          }}
          type="button"
        >
          <span class="grid size-12 shrink-0 place-items-center rounded-[var(--radius-md)] bg-muted text-muted-foreground">
            <IconLink class="size-5" />
          </span>
          <Type as="span" variant="body-strong">
            Use the song at this link
          </Type>
        </button>
      </Show>
      <Show when={props.linkProblem}>
        {(problem) => (
          <Type as="p" variant="caption" role="alert">
            {problem()}
          </Type>
        )}
      </Show>

      <Show when={state() === "loading" && !isLink()}>
        <div class="grid min-h-48 place-items-center">
          <Spinner label="Loading songs" />
        </div>
      </Show>
      <Show when={state() === "choose_profile" && !isLink()}>
        <Type
          as="p"
          variant="caption"
          class="px-2 text-muted-foreground"
          role="status"
        >
          Songs you can use appear here once a posting profile is chosen for
          this community.
        </Type>
      </Show>
      <Show when={state() === "failed" && !isLink()}>
        <div class="flex items-center justify-between gap-3 px-2">
          <Type
            as="p"
            variant="caption"
            class="text-muted-foreground"
            role="alert"
          >
            Songs couldn’t load.
          </Type>
          <Button
            onClick={() => load(props.communityId, props.personaId)}
            size="sm"
            type="button"
            variant="secondary"
          >
            Try again
          </Button>
        </div>
      </Show>
      <Show when={state() === "ready" && !isLink()}>
        <Show
          when={matches().length > 0}
          fallback={
            <Type
              as="p"
              variant="caption"
              class="px-2 text-muted-foreground"
              role="status"
            >
              {songs().length === 0
                ? nextCursor() !== null
                  ? "None of the songs loaded so far can be used in a video yet. Load more, or paste a song link."
                  : "No songs here can be used in a video yet. Paste a song link to use one from elsewhere."
                : nextCursor() !== null
                  ? "No songs match yet. Load more, or paste a song link."
                  : "No songs match."}
            </Type>
          }
        >
          <ul aria-label="Songs" class="grid gap-1">
            <For each={matches()}>
              {(song) => {
                const active = () => activeId() === song.postId;
                const status = () => (active() ? preview().kind : "idle");
                return (
                  <li
                    class={`flex items-center gap-2 rounded-[var(--radius-lg)] pe-2 transition-colors ${active() ? "bg-muted" : ""}`}
                    data-song-row={song.postId}
                  >
                    <button
                      aria-label={
                        status() === "playing"
                          ? `Pause ${song.title}`
                          : `Play ${song.title}${song.artist ? ` by ${song.artist}` : ""}`
                      }
                      aria-pressed={status() === "playing" ? "true" : "false"}
                      class="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-lg)] p-2 text-start hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => togglePreview(song.postId)}
                      type="button"
                    >
                      <span
                        class={`relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-md)] ${active() ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}
                      >
                        <Show when={song.artworkSrc}>
                          {(src) => (
                            <img
                              alt=""
                              class="absolute inset-0 size-full object-cover"
                              src={src()}
                            />
                          )}
                        </Show>
                        <span
                          class={`relative grid size-full place-items-center ${song.artworkSrc ? "bg-black/35 text-white" : ""} ${status() === "loading" ? "animate-pulse" : ""}`}
                        >
                          <Show
                            when={status() === "playing"}
                            fallback={<IconPlay class="size-5" />}
                          >
                            <IconPause class="size-5" />
                          </Show>
                        </span>
                      </span>
                      <span class="min-w-0">
                        <Type
                          as="span"
                          class="block truncate"
                          variant="body-strong"
                        >
                          {song.title}
                        </Type>
                        <Type
                          as="span"
                          class="block truncate text-muted-foreground"
                          variant="caption"
                        >
                          {status() === "unavailable"
                            ? "Preview unavailable"
                            : song.artist}
                        </Type>
                      </span>
                    </button>
                    <Show when={active()}>
                      <Button
                        aria-label={`Use ${song.title}`}
                        onClick={() => use(song.postId)}
                        size="sm"
                        type="button"
                      >
                        Use
                      </Button>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
        {/* Outside the matched-rows gate: an empty first page or a search
            with no match among loaded songs is exactly when more pages may
            still hold the song the author is looking for. */}
        <Show when={nextCursor() !== null}>
          <div class="flex flex-wrap items-center justify-between gap-2 px-2">
            <Show when={moreState() === "failed" || searching()}>
              <Type
                as="p"
                variant="caption"
                class="text-muted-foreground"
                role={moreState() === "failed" ? "alert" : undefined}
              >
                {moreState() === "failed"
                  ? "More songs couldn’t load."
                  : "Search covers the songs loaded so far."}
              </Type>
            </Show>
            <Button
              disabled={moreState() === "loading"}
              onClick={loadMore}
              size="sm"
              type="button"
              variant="secondary"
            >
              {moreState() === "loading"
                ? "Loading…"
                : moreState() === "failed"
                  ? "Try again"
                  : "Load more songs"}
            </Button>
          </div>
        </Show>
      </Show>
    </div>
  );
}
