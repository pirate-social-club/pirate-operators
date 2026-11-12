// Independently owned source copy. src/features/profiles/profile-page/profile-layout.tsx @ c7cb87835a1858a1955c820b03d566365e6d42db
// Adapter differences: docs/v1-shell-owner-correction-20261111.md.
import { For, Show } from "solid-js";
import { getRequestEvent, type JSX } from "@solidjs/web";
import { Type } from "../design-system.ts";
// Settings are supplied by the community/MOSS adapter, not centralized services.

export interface ProfileLayoutProps {
  readonly name: string;
  readonly handle?: string | null;
  readonly personaId?: string;
  readonly avatarRef?: string | null;
  readonly coverRef?: string | null;
  readonly servingOrigin?: string;
  readonly bio?: string | null;
  readonly names?: readonly string[];
  readonly children?: JSX.Element;
  readonly settingsControl?: JSX.Element;
}

/** Profile media stays on the serving host, including cached public SSR. */
export function profileMediaUrl(
  reference: string | null | undefined,
  servingOrigin: string | undefined,
): string | undefined {
  if (!reference || !servingOrigin) return undefined;
  try {
    const origin = new URL(servingOrigin);
    const resolved = new URL(reference, origin);
    return (origin.protocol === "https:" || origin.protocol === "http:") &&
      resolved.origin === origin.origin
      ? resolved.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One profile page for both routes, after the Paper Profile sheet: a cover
 * across the page, then one column (640px on desktop, 20px gutters) holding
 * the identity block, the viewer's action and the posts feed.
 *
 * The label is the handle when there is one, otherwise the name, matching the
 * post card's author label. The sheet's community line under the label is
 * not drawn: no profile read projects the community's name, and it is not
 * derived from handle grants.
 */
export function ProfileLayout(props: ProfileLayoutProps) {
  const servingOrigin = () => {
    if (props.servingOrigin) return props.servingOrigin;
    const event = getRequestEvent();
    return event
      ? new URL(event.request.url).origin
      : typeof location === "undefined"
        ? undefined
        : location.origin;
  };
  const avatar = () => profileMediaUrl(props.avatarRef, servingOrigin());
  const cover = () => profileMediaUrl(props.coverRef, servingOrigin());
  const handle = () => props.handle?.trim() || undefined;
  const label = () => handle() ?? props.name;
  return (
    <section class="flex w-full min-w-0 flex-col" data-profile-layout>
      <div
        class="relative h-36 w-full overflow-hidden bg-muted md:h-[200px]"
        data-profile-cover
      >
        <Show when={cover()}>
          {(source) => (
            <img src={source()} alt="" class="size-full object-cover" />
          )}
        </Show>
      </div>
      <div class="mx-auto flex w-full min-w-0 max-w-[640px] flex-col">
        <section
          aria-label="Profile"
          class="flex flex-col gap-4 border-b border-border-soft px-5 pb-4 pt-5"
        >
          <div class="flex flex-wrap items-center gap-3">
            <div class="grid size-20 shrink-0 place-items-center overflow-hidden rounded-full bg-secondary">
              <Show
                when={avatar()}
                fallback={
                  <span
                    aria-hidden="true"
                    class="text-2xl font-semibold leading-6 text-foreground"
                  >
                    {label().slice(0, 1).toUpperCase()}
                  </span>
                }
              >
                {(source) => (
                  <img src={source()} alt="" class="size-full object-cover" />
                )}
              </Show>
            </div>
            <div class="flex min-w-0 flex-1 basis-0 flex-col gap-1">
              <Type
                as="h1"
                variant="h2"
                class="break-words leading-8"
                data-profile-handle={handle()}
              >
                {label()}
              </Type>
            </div>
            <Show when={props.bio}>
              {(bio) => (
                <Type
                  as="p"
                  variant="body"
                  class="basis-full whitespace-pre-wrap break-words"
                >
                  {bio()}
                </Type>
              )}
            </Show>
            <Show when={props.names?.length}>
              <section
                aria-labelledby="profile-names-heading"
                class="flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1"
              >
                <Type
                  as="h2"
                  variant="label"
                  class="text-sm"
                  id="profile-names-heading"
                >
                  Names
                </Type>
                <ul aria-label="Names" class="flex flex-wrap gap-x-3 gap-y-1">
                  <For each={props.names}>
                    {(name) => (
                      <li>
                        <Type variant="caption" class="break-all text-sm">
                          {name}
                        </Type>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          </div>
          <div class="flex w-full empty:hidden">{props.settingsControl}</div>
        </section>
        <div class="px-5">{props.children}</div>
      </div>
    </section>
  );
}
