// SongPostContent presentation @ dca054847b3d48237780dcf834b7924c5fede0af.
// Playback/access remain in SongPlayer. Unknown artwork/artist stays absent.
import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { IconMusicNote, Type } from "../design-system.ts";
export function SongContentFrame(props: {
  title: string;
  artworkSrc?: string;
  artist?: string;
  titleHref?: string;
  nativeNavigation?: boolean;
  children: JSX.Element;
}) {
  return (
    <div class="flex flex-col gap-2 text-start">
      <div>
        <div class="grid items-start gap-x-3 gap-y-2 py-1 grid-cols-[auto_minmax(0,1fr)]">
          <div class="relative row-start-1 grid size-20 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted sm:row-span-2 sm:size-24 sm:self-center">
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
          <div class="col-start-2 row-start-1 min-w-0 self-center sm:self-end">
            <div class="min-w-0">
              <div class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0 leading-tight">
                <Type
                  as="span"
                  class="max-w-full truncate font-semibold text-foreground sm:text-lg"
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
          <div class="col-span-full row-start-2 sm:col-span-1 sm:col-start-2 sm:self-start">
            {props.children}
          </div>
        </div>
      </div>
    </div>
  );
}
