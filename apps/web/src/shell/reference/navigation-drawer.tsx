// Independently owned source copy @ c7cb87835a1858a1955c820b03d566365e6d42db
// Exact source and dependency differences: docs/v1-shell-owner-correction-20261111.md.
import { Show } from "solid-js";
import { Type } from "../design-system.ts";
import { CommunityNavigation } from "./community-navigation.tsx";
import {
  notificationsNavigation,
  scopedPrimaryNavigation,
  platformNavigationScope,
  type CommunityNavigationState,
  type ApplicationNavigationScope,
} from "./navigation-model.ts";
export interface NavigationDrawerProps {
  readonly state: CommunityNavigationState;
  readonly scope?: ApplicationNavigationScope;
  readonly currentPath?: string;
  readonly onNavigate: (href: string) => void;
  readonly onRetry: () => void;
  readonly notificationsHref?: string;
}

/** Phone tabs already carry For You, Your Songs, Wallet and Profile. */
export function NavigationDrawer(props: NavigationDrawerProps) {
  const destination = () =>
    scopedPrimaryNavigation(props.scope ?? platformNavigationScope).find(
      (item) => item.id === "home",
    )!;
  return (
    <nav
      aria-label="Community navigation"
      class="flex h-full min-h-0 flex-col gap-6 overflow-y-auto p-4 pt-[calc(env(safe-area-inset-top)+3.5rem)]"
    >
      <Show when={props.notificationsHref}>
        <a
          class="flex min-h-11 items-center rounded-lg px-3 py-2 text-sidebar-foreground hover:bg-sidebar-accent"
          href={props.notificationsHref}
          aria-current={
            props.currentPath === props.notificationsHref ? "page" : undefined
          }
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
            if (props.notificationsHref)
              props.onNavigate(props.notificationsHref);
          }}
        >
          {notificationsNavigation.label}
        </a>
      </Show>
      <Show when={props.scope?.kind === "community" ? props.scope : undefined}>
        {(scope) => (
          <Type variant="h4" class="px-3">
            {scope().community.displayName}
          </Type>
        )}
      </Show>
      <Show when={props.scope?.kind === "community"}>
        <a
          class="flex min-h-11 items-center rounded-lg px-3 py-2 text-sidebar-foreground hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={destination().href}
          aria-current={
            props.currentPath === destination().href ? "page" : undefined
          }
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
            props.onNavigate(destination().href);
          }}
        >
          {destination().label}
        </a>
      </Show>
      <CommunityNavigation
        state={props.state}
        scope={props.scope}
        currentPath={props.currentPath}
        onNavigate={props.onNavigate}
        onRetry={props.onRetry}
      />
    </nav>
  );
}
