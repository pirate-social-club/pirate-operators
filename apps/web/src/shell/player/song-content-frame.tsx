// SongPost tile @ c7cb87835a1858a1955c820b03d566365e6d42db,
// aligned with Paper Screens/Posts/Post and Parts/Posts/PostCard.
// Playback/access remain in SongPlayer. Unknown artwork/artist stays absent.
import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { IconMusicNote, Type } from "../design-system.ts";
export function SongContentFrame(props: {
  title: string;
  detail?: boolean;
  artworkSrc?: string;
  artist?: string;
  titleHref?: string;
  nativeNavigation?: boolean;
  children: JSX.Element;
}) {
  return (
    <div
      class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] border border-border-soft bg-muted p-3 text-start"
      data-song-tile
    >
      <div class="relative col-start-1 row-start-1 grid size-14 shrink-0 place-items-center overflow-hidden rounded-xl bg-secondary">
        <Show
          when={props.artworkSrc}
          fallback={<IconMusicNote class="size-7 text-muted-foreground" />}
        >
          {(source) => (
            <img
              alt=""
              aria-hidden="true"
              class="size-full object-cover"
              src={source()}
            />
          )}
        </Show>
      </div>
      <div class="col-start-2 row-start-1 min-w-0">
        <div class="min-w-0">
          <div class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0 leading-tight">
            <Type
              as={props.detail ? "h1" : "span"}
              class={
                props.detail
                  ? "max-w-full break-words font-semibold text-foreground"
                  : "max-w-full truncate font-semibold text-foreground"
              }
              variant="body-strong"
            >
              <Show when={props.titleHref} fallback={props.title}>
                {(href) => (
                  <a
                    href={href()}
                    rel={props.nativeNavigation ? "external" : undefined}
                    class="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {props.title}
                  </a>
                )}
              </Show>
            </Type>
          </div>
          <Show when={props.artist}>
            {(artist) => (
              <Type
                as="p"
                class="mt-1 truncate text-muted-foreground"
                variant="caption"
              >
                {artist()}
              </Type>
            )}
          </Show>
        </div>
      </div>
      {props.children}
    </div>
  );
}
