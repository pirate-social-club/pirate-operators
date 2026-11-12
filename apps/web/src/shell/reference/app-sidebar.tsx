// Independently owned source copy. src/features/shell/app-sidebar/app-sidebar.tsx @ c7cb87835a1858a1955c820b03d566365e6d42db
// Adapter differences: docs/v1-shell-owner-correction-20261111.md.
/** @jsxImportSource @solidjs/web */
import { For, Show } from "solid-js";
import { Dynamic, type JSX } from "@solidjs/web";

import { CommunityNavigation } from "./community-navigation.tsx";
import type {
  ApplicationNavigationScope,
  CommunityNavigationState,
} from "./navigation-model.ts";

import {
  Avatar,
  Button,
  IconHouse,
  IconPlaylist,
  IconWallet,
  IconList,
  IconBell,
  Type,
  cn,
} from "../design-system.ts";

export interface SidebarItem {
  id: string;
  label: string;
  href?: string;
  iconKind?: "home" | "songs" | "wallet" | "profile" | "notifications";
  avatar?: {
    readonly fallback: string;
    readonly seed?: string | null;
    readonly src?: string | null;
  };
  badge?: string;
}

export interface AppSidebarProps {
  activeItemId?: string;
  appearance?: "default" | "media";
  brandLabel?: string;
  homeAriaLabel?: string;
  primaryItems?: readonly SidebarItem[];
  communityState?: CommunityNavigationState;
  navigationScope?: ApplicationNavigationScope;
  currentPath?: string;
  onNavigateCommunity?: (href: string) => void;
  onRetryCommunities?: () => void;
  class?: string;
  collapsed?: boolean;
  mediaAction?: JSX.Element;
  accountControl?: {
    readonly label: string;
    readonly displayName: string;
    readonly handle?: string | null;
    readonly avatarSrc?: string | null;
    readonly avatarSeed?: string | null;
    readonly onClick: () => void;
  };
  signInAction?: {
    readonly onClick: () => void;
    readonly prepare: () => void;
    readonly preload: () => void;
  };
  onHomeClick?: () => void;
  onNavigate?: (id: string) => void;
}

const sidebarIcons = {
  home: IconHouse,
  songs: IconPlaylist,
  wallet: IconWallet,
  profile: IconList,
  notifications: IconBell,
};

function SidebarLink(props: {
  item: SidebarItem;
  active?: boolean;
  onNavigate?: (id: string) => void;
}) {
  const content = () => (
    <>
      <span aria-hidden="true" class="shrink-0">
        <Show
          when={props.item.iconKind === "profile"}
          fallback={
            <Dynamic
              component={sidebarIcons[props.item.iconKind ?? "profile"]}
              class="size-5"
            />
          }
        >
          <Avatar
            class="size-5"
            fallback={props.item.avatar?.fallback ?? "Profile"}
            fallbackSeed={props.item.avatar?.seed ?? undefined}
            src={props.item.avatar?.src ?? undefined}
            size="sm"
          />
        </Show>
      </span>
      <Type as="span" variant="body" class="min-w-0 flex-1 truncate">
        {props.item.label}
      </Type>
    </>
  );
  const classes = () =>
    cn(
      "flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-start text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      props.active && "bg-sidebar-accent text-sidebar-accent-foreground",
    );
  return (
    <Show
      when={props.item.href}
      fallback={
        <button
          aria-current={props.active ? "page" : undefined}
          class={classes()}
          onClick={() => props.onNavigate?.(props.item.id)}
          type="button"
        >
          {content()}
        </button>
      }
    >
      <a
        href={props.item.href}
        aria-current={props.active ? "page" : undefined}
        class={classes()}
        onClick={(event) => {
          if (
            !props.onNavigate ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          props.onNavigate(props.item.id);
        }}
      >
        {content()}
      </a>
    </Show>
  );
}

export function AppSidebar(props: AppSidebarProps) {
  return (
    <aside
      aria-label={props.brandLabel ?? "Navigation"}
      class={cn(
        "flex min-h-0 w-[15.5rem] shrink-0 flex-col border-e border-sidebar-border bg-sidebar p-4 text-sidebar-foreground",
        props.collapsed && "w-20 px-2",
        props.class,
      )}
    >
      {/* Each app domain is its own product: no brand block unless a host names one. */}
      <Show when={props.brandLabel}>
        {(label) => (
          <button
            aria-label={props.homeAriaLabel ?? "Go to home"}
            class="mb-5 flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-start transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={props.onHomeClick}
            type="button"
          >
            <Show when={!props.collapsed}>
              <Type as="span" variant="h4" class="tracking-wide">
                {label()}
              </Type>
            </Show>
          </button>
        )}
      </Show>
      <Show when={props.mediaAction && !props.collapsed}>
        <div class="mb-4">{props.mediaAction}</div>
      </Show>
      <nav
        aria-label="Main navigation"
        class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto"
      >
        <Show when={props.primaryItems?.length}>
          <div class="flex flex-col gap-1">
            <For each={props.primaryItems}>
              {(item) => (
                <SidebarLink
                  active={props.activeItemId === item.id}
                  item={item}
                  onNavigate={props.onNavigate}
                />
              )}
            </For>
          </div>
        </Show>
        <Show
          when={
            props.navigationScope?.kind === "community" ||
            (props.communityState && props.communityState.kind !== "hidden")
          }
        >
          <CommunityNavigation
            state={props.communityState ?? { kind: "hidden" }}
            scope={props.navigationScope}
            currentPath={props.currentPath}
            onNavigate={(href) => props.onNavigateCommunity?.(href)}
            onRetry={() => props.onRetryCommunities?.()}
          />
        </Show>
      </nav>
      <Show
        when={!props.collapsed && (props.accountControl || props.signInAction)}
      >
        <div class="mt-4 border-t border-sidebar-border pt-4">
          <Show
            keyed
            when={props.accountControl}
            fallback={
              <Button
                class="w-full"
                onClick={() => props.signInAction?.onClick()}
                onFocus={() => props.signInAction?.prepare()}
                onPointerDown={() => props.signInAction?.prepare()}
                onPointerEnter={() => props.signInAction?.preload()}
              >
                Sign in
              </Button>
            }
          >
            {(account) => (
              <button
                aria-label={account.label}
                aria-haspopup="dialog"
                onClick={account.onClick}
                type="button"
                class="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-start hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Avatar
                  fallback={account.displayName}
                  fallbackSeed={account.avatarSeed ?? account.displayName}
                  src={account.avatarSrc ?? undefined}
                  size="sm"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-base font-semibold leading-6">
                    {account.displayName}
                  </span>
                  <Show when={account.handle}>
                    <span class="block truncate text-base leading-5 text-muted-foreground">
                      {account.handle}
                    </span>
                  </Show>
                </span>
              </button>
            )}
          </Show>
        </div>
      </Show>
    </aside>
  );
}

export function SidebarContent(props: {
  children: JSX.Element;
  class?: string;
}) {
  return (
    <div class={cn("min-h-screen min-w-0 flex-1 bg-background", props.class)}>
      {props.children}
    </div>
  );
}
