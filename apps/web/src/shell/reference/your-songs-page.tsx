// Independently owned presentation from src/features/songs/your-songs-page.tsx @ c7cb87835a1858a1955c820b03d566365e6d42db
// Exact extraction/adapter boundaries: docs/v1-shell-owner-correction-20261111.md.
const leaderboardLibraryHref = (href: string) => href;
// The live entry owns document.title; no new head-manager dependency.
import { createMemo, createSignal, For, Show } from "solid-js";
import { StreakCount } from "./streak-count.tsx";
import {
  Avatar,
  Button,
  Card,
  CardContent,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  IconFire,
  IconMicrophone,
  IconPlaylist,
  Input,
  Type,
} from "../design-system.ts";

export interface LibrarySong {
  id: string;
  title: string;
  artist?: string;
  artwork?: string;
  studyPath?: string;
  karaokePath?: string;
  /** Supplied by the song library when its server-backed progress read is available. */
  currentStreak?: number;
  leaderboardPath?: string;
  activities?: readonly ("study" | "karaoke" | "dance")[];
}

export interface YourSongsPageProps {
  songs: readonly LibrarySong[];
  /** `not-yet-available`: the song-history read has not been released. */
  state?:
    | "ready"
    | "loading"
    | "unavailable"
    | "signed-out"
    | "not-yet-available";
  navigate: (href: string) => void;
  onSignIn?: () => void;
  onRetry?: () => void;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  loadMoreFailed?: boolean;
  trending?: readonly LibrarySong[];
  trendingState?: "ready" | "loading" | "unavailable" | "not-yet-available";
  onTrendingRetry?: () => void;
}

function SongCollection(props: {
  label: string;
  songs: readonly LibrarySong[];
  navigate: (href: string) => void;
}) {
  const [selectedId, setSelectedId] = createSignal<string>();
  const selected = () => props.songs.find((song) => song.id === selectedId());
  let returnFocus: HTMLButtonElement | undefined;
  return (
    <>
      <ul aria-label={props.label} class="flex flex-col gap-3">
        <For each={props.songs}>
          {(song) => (
            <li>
              <Card>
                <CardContent class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
                  <div class="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar
                      fallback={song.title}
                      src={song.artwork}
                      class="rounded-lg"
                    />
                    <div class="min-w-0">
                      <Type as="h3" variant="h4" class="truncate">
                        <Show when={song.leaderboardPath} fallback={song.title}>
                          <button
                            type="button"
                            class="rounded text-left focus-visible:outline-2 focus-visible:outline-ring"
                            onClick={(event) => {
                              returnFocus = event.currentTarget;
                              setSelectedId(song.id);
                            }}
                          >
                            {song.title}
                          </button>
                        </Show>
                      </Type>
                      <Show when={song.artist}>
                        <Type as="p" class="truncate text-muted-foreground">
                          {song.artist}
                        </Type>
                      </Show>
                      <Show when={song.activities?.length}>
                        <Type
                          as="p"
                          variant="caption"
                          class="text-muted-foreground"
                        >
                          {song.activities
                            ?.map(
                              (activity) =>
                                ({
                                  study: "Study",
                                  karaoke: "Karaoke",
                                  dance: "Dance",
                                })[activity],
                            )
                            .join(" · ")}
                        </Type>
                      </Show>
                    </div>
                  </div>
                  <Show when={song.currentStreak !== undefined}>
                    <StreakCount count={song.currentStreak!} />
                  </Show>
                  <div class="flex shrink-0 flex-wrap gap-2">
                    <Button
                      class="flex-1 sm:flex-none"
                      disabled={!song.studyPath}
                      leadingIcon={<IconPlaylist class="size-4" />}
                      onClick={() =>
                        song.studyPath && props.navigate(song.studyPath)
                      }
                    >
                      Study
                    </Button>
                    <Button
                      class="flex-1 sm:flex-none"
                      variant="outline"
                      disabled={!song.karaokePath}
                      leadingIcon={<IconMicrophone class="size-4" />}
                      onClick={() =>
                        song.karaokePath && props.navigate(song.karaokePath)
                      }
                    >
                      Karaoke
                    </Button>
                    <Show when={song.leaderboardPath}>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          props.navigate(
                            leaderboardLibraryHref(song.leaderboardPath!),
                          )
                        }
                      >
                        Leaderboard
                      </Button>
                    </Show>
                  </div>
                </CardContent>
              </Card>
            </li>
          )}
        </For>
      </ul>
      <Sheet
        open={selected() !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelectedId(undefined);
        }}
      >
        <SheetContent
          side="bottom"
          class="mx-auto max-w-xl rounded-t-3xl p-6"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus?.focus();
          }}
        >
          <Show when={selected()}>
            {(song) => (
              <>
                <SheetHeader>
                  <SheetTitle>{song().title}</SheetTitle>
                  <SheetDescription>{song().artist}</SheetDescription>
                </SheetHeader>
                <Show when={song().currentStreak !== undefined}>
                  <div class="my-6 flex items-center gap-3 text-warning">
                    <IconFire filled class="size-11" />
                    <p>
                      <span class="text-4xl font-bold">
                        {song().currentStreak}
                      </span>
                      <span class="ml-2">day streak</span>
                    </p>
                  </div>
                </Show>
                <div class="mt-5 flex flex-wrap gap-3">
                  <Show when={song().studyPath}>
                    <Button onClick={() => props.navigate(song().studyPath!)}>
                      Study
                    </Button>
                  </Show>
                  <Show when={song().karaokePath}>
                    <Button
                      variant="secondary"
                      onClick={() => props.navigate(song().karaokePath!)}
                    >
                      Karaoke
                    </Button>
                  </Show>
                  <Show when={song().leaderboardPath}>
                    <Button
                      variant="outline"
                      onClick={() =>
                        props.navigate(
                          leaderboardLibraryHref(song().leaderboardPath!),
                        )
                      }
                    >
                      Leaderboard
                    </Button>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Collection presentation shared by the route and Storybook. */
export function YourSongsPage(props: YourSongsPageProps) {
  const [query, setQuery] = createSignal("");
  const ready = () => (props.state ?? "ready") === "ready";
  const songs = createMemo(() =>
    props.songs.filter((song) =>
      `${song.title} ${song.artist ?? ""}`
        .toLocaleLowerCase()
        .includes(query().trim().toLocaleLowerCase()),
    ),
  );
  return (
    <main
      data-route-path="/songs"
      class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8"
    >
      <div class="space-y-2">
        <Type as="h1" variant="h1">
          Your songs
        </Type>
        <Type class="text-muted-foreground">
          Pick up where you left off, or find something new.
        </Type>
      </div>
      <section aria-label="Recent activity" class="space-y-4">
        <Type as="h2" variant="h3">
          Recent activity
        </Type>
        <Show when={props.state === "loading"}>
          <Type role="status">Loading your songs…</Type>
        </Show>
        <Show when={props.state === "signed-out"}>
          <Card>
            <CardContent class="space-y-4 p-6">
              <Type>Sign in to see your songs.</Type>
              <Button onClick={props.onSignIn}>Sign in</Button>
            </CardContent>
          </Card>
        </Show>
        <Show when={props.state === "not-yet-available"}>
          <Card>
            <CardContent class="space-y-4 p-6">
              <Type as="h2" variant="h3">
                Song history is coming soon
              </Type>
              <Type>
                For now, open a song post and choose Study or Karaoke to
                practise it.
              </Type>
              <Button onClick={() => props.navigate("/")}>
                Browse For You
              </Button>
            </CardContent>
          </Card>
        </Show>
        <Show when={props.state === "unavailable"}>
          <Card>
            <CardContent class="space-y-4 p-6">
              <Type>Your songs could not be loaded.</Type>
              <Button variant="outline" onClick={props.onRetry}>
                Try again
              </Button>
            </CardContent>
          </Card>
        </Show>
        <Show when={ready()}>
          <Show
            when={props.songs.length > 0}
            fallback={
              <Card>
                <CardContent class="space-y-4 p-6">
                  <Type as="h2" variant="h3">
                    No songs yet
                  </Type>
                  <Type>
                    Start studying, singing, or dancing to a song and it will
                    appear here.
                  </Type>
                  <Button onClick={() => props.navigate("/")}>
                    Browse For You
                  </Button>
                </CardContent>
              </Card>
            }
          >
            <Input
              aria-label="Find a song"
              placeholder="Find a song"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
            <SongCollection
              label="Your songs"
              songs={songs()}
              navigate={props.navigate}
            />
            <Show when={songs().length === 0}>
              <Type>No matching songs.</Type>
            </Show>
          </Show>
          <Show when={props.loadMoreFailed}>
            <Type role="alert">
              More songs could not be loaded. Try Load more again.
            </Type>
          </Show>
          <Show when={props.onLoadMore}>
            <Button
              variant="outline"
              onClick={props.onLoadMore}
              disabled={props.loadingMore}
            >
              {props.loadingMore ? "Loading…" : "Load more"}
            </Button>
          </Show>
        </Show>
      </section>
      <Show
        when={
          props.trending?.length ||
          props.trendingState === "loading" ||
          props.trendingState === "unavailable"
        }
      >
        <section aria-labelledby="songs-to-learn-heading" class="space-y-4">
          <div>
            <Type as="h2" variant="h3" id="songs-to-learn-heading">
              Songs to learn
            </Type>
            <Type class="text-muted-foreground">
              Find something new to study or sing.
            </Type>
          </div>
          <Show when={props.trendingState === "not-yet-available"}>
            <Type>
              For now, find a song post in For You and choose Study or Karaoke.
            </Type>
            <Button variant="outline" onClick={() => props.navigate("/")}>
              Browse For You
            </Button>
          </Show>
          <Show when={props.trendingState === "loading"}>
            <Type role="status">Loading songs…</Type>
          </Show>
          <Show when={props.trendingState === "unavailable"}>
            <Type>Songs to learn could not be loaded.</Type>
            <Button variant="outline" onClick={props.onTrendingRetry}>
              Try again
            </Button>
          </Show>
          <Show when={(props.trendingState ?? "ready") === "ready"}>
            <Show
              when={props.trending?.length}
              fallback={
                <Type class="text-muted-foreground">
                  No songs to learn yet.
                </Type>
              }
            >
              <SongCollection
                label="Songs to learn"
                songs={props.trending ?? []}
                navigate={props.navigate}
              />
            </Show>
          </Show>
        </section>
      </Show>
    </main>
  );
}
