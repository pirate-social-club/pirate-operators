// Independently owned source copy. src/features/shell/community-navigation.tsx @ c7cb87835a1858a1955c820b03d566365e6d42db
// Adapter differences: docs/v1-shell-owner-correction-20261111.md.
/** @jsxImportSource @solidjs/web */
import { For, Show, createUniqueId } from "solid-js";
import {
  Avatar,
  Button,
  IconButton,
  IconPlus,
  Type,
  cn,
} from "../design-system.ts";
import {
  communityNavigationSections,
  type CommunityNavigationState,
  type NavigationCommunity,
  type ApplicationNavigationScope,
} from "./navigation-model.ts";

export interface CommunityNavigationProps {
  readonly state: CommunityNavigationState;
  readonly scope?: ApplicationNavigationScope;
  readonly currentPath?: string;
  readonly onNavigate: (href: string) => void;
  readonly onRetry: () => void;
}

function CommunityLink(props: {
  community: NavigationCommunity;
  currentPath?: string;
  onNavigate: (href: string) => void;
}) {
  const content = () => (
    <>
      <span aria-hidden="true">
        <Avatar
          fallback={props.community.displayName}
          fallbackSeed={props.community.displayName}
          size="xs"
          class="text-[10px]"
        />
      </span>
      <Type as="span" class="min-w-0 flex-1 truncate">
        {props.community.displayName}
      </Type>
    </>
  );
  const classes = () =>
    cn(
      "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      props.currentPath === props.community.href && "bg-sidebar-accent",
    );
  return (
    <li>
      <Show
        when={props.community.href}
        fallback={<span class={cn(classes(), "opacity-60")}>{content()}</span>}
      >
        {(href) => (
          <a
            class={classes()}
            href={href()}
            title={props.community.displayName}
            aria-current={props.currentPath === href() ? "page" : undefined}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              props.onNavigate(href());
            }}
          >
            {content()}
          </a>
        )}
      </Show>
    </li>
  );
}

/** The same section markup and ordering in both sidebar presentations. */
function PlatformCommunityNavigation(props: CommunityNavigationProps) {
  const id = createUniqueId();
  const sections = () =>
    props.state.kind === "ready"
      ? communityNavigationSections(props.state.data)
      : undefined;
  return (
    <div class="flex flex-col gap-6">
      <section aria-labelledby={`${id}-communities`}>
        <div class="flex min-h-11 items-center justify-between gap-1 ps-3">
          <Type
            as="h2"
            id={`${id}-communities`}
            variant="overline"
            class="text-xs tracking-wide text-sidebar-foreground"
          >
            Communities
          </Type>
          <IconButton
            aria-label="Create community"
            title="Create community"
            variant="ghost"
            onClick={() => props.onNavigate("/communities/new")}
          >
            <IconPlus class="size-5" />
          </IconButton>
        </div>
        <Show when={props.state.kind === "loading"}>
          <Type class="px-3 py-2 text-sidebar-foreground" role="status">
            Loading communities…
          </Type>
        </Show>
        <Show when={props.state.kind === "error"}>
          <div class="flex flex-col items-start gap-2 px-3 py-2">
            <Type role="alert">Communities couldn’t be loaded.</Type>
            <Button size="sm" variant="outline" onClick={props.onRetry}>
              Try again
            </Button>
          </div>
        </Show>
        <Show when={sections()}>
          {(list) => (
            <>
              <Show
                when={list().communities.length > 0}
                fallback={<Type class="px-3 py-2">No communities yet.</Type>}
              >
                <ul class="flex flex-col gap-1">
                  <For each={list().communities}>
                    {(community) => (
                      <CommunityLink
                        community={community}
                        currentPath={props.currentPath}
                        onNavigate={props.onNavigate}
                      />
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={list().seeAllJoined}>
                <a
                  class="mt-1 block rounded-lg px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  href="/communities"
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    props.onNavigate("/communities");
                  }}
                >
                  See all
                </a>
              </Show>
            </>
          )}
        </Show>
      </section>
      <Show when={sections()?.moderated.length}>
        {(_) => (
          <section aria-labelledby={`${id}-moderator`}>
            <Type
              as="h2"
              id={`${id}-moderator`}
              variant="overline"
              class="px-3 pb-2 text-xs tracking-wide text-sidebar-foreground"
            >
              Moderator
            </Type>
            <ul class="flex flex-col gap-1">
              <For each={sections()?.moderated}>
                {(community) => (
                  <CommunityLink
                    community={community}
                    currentPath={props.currentPath}
                    onNavigate={props.onNavigate}
                  />
                )}
              </For>
            </ul>
          </section>
        )}
      </Show>
    </div>
  );
}

/** Community apps never render cross-community discovery or creation. */
export function CommunityNavigation(props: CommunityNavigationProps) {
  const id = createUniqueId();
  return (
    <Show
      when={props.scope?.kind === "community" ? props.scope : undefined}
      fallback={
        <Show when={props.state.kind !== "hidden"}>
          <PlatformCommunityNavigation {...props} />
        </Show>
      }
    >
      {(scope) => (
        <Show when={scope().moderationHref}>
          {(href) => (
            <section aria-labelledby={`${id}-moderator`}>
              <Type
                as="h2"
                id={`${id}-moderator`}
                variant="overline"
                class="px-3 pb-2 text-xs tracking-wide text-sidebar-foreground"
              >
                Moderator
              </Type>
              <ul>
                <CommunityLink
                  community={{
                    ...scope().community,
                    displayName: "Moderation",
                    href: href(),
                  }}
                  currentPath={props.currentPath}
                  onNavigate={props.onNavigate}
                />
              </ul>
            </section>
          )}
        </Show>
      )}
    </Show>
  );
}
