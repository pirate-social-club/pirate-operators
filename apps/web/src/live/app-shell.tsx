import { Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  AppHeader,
  Button,
  IconButton,
  IconList,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Toaster,
  Type,
  createMediaQuery,
} from "../shell/design-system.ts";
import {
  AppSidebar,
  SidebarContent,
  type SidebarItem,
} from "../shell/reference/app-sidebar.tsx";
import { MobileFooterNav } from "../shell/reference/mobile-footer-nav.tsx";
import { communityChrome } from "../shell/chrome-adapter.ts";
import { NavigationDrawer } from "../shell/reference/navigation-drawer.tsx";
import { fragmentNavigationHref, type AppView } from "../shell/routing.ts";

/** Assembly of the actual AppSidebar/AppHeader/MobileFooterNav components.
 * Layout and drawer lifecycle: c7cb8783 ApplicationChrome (media-shell.tsx).
 * Session, destinations and capability inputs are the decentralized adapter.
 */
export function CommunityAppShell(props: {
  name: string;
  communityId: string;
  publicProfileAuthor?: string;
  ownPublicProfile?: boolean;
  view: AppView;
  walletPage: boolean;
  rewards: boolean;
  practiceOpen: boolean;
  signedIn: boolean;
  ready: boolean;
  busy: boolean;
  canSignIn: boolean;
  accountSeed?: string;
  onSignIn: () => void;
  composing?: boolean;
  children: JSX.Element;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false, { ownedWrite: true });
  let menuTrigger: HTMLButtonElement | undefined;
  let pendingNavigation: string | undefined;
  const navigate = (href: string) =>
    location.assign(fragmentNavigationHref(href, new URL(location.href)));
  const go = (href: string) => {
    if (menuOpen()) {
      pendingNavigation = href;
      setMenuOpen(false);
      return;
    }
    navigate(href);
  };
  const afterMenuClose = (event: Event) => {
    event.preventDefault();
    menuTrigger?.focus({ preventScroll: true });
    const href = pendingNavigation;
    pendingNavigation = undefined;
    if (href) requestAnimationFrame(() => navigate(href));
  };
  createEffect(
    () => props.practiceOpen,
    (open) => {
      if (open) setMenuOpen(false);
    },
  );
  const policy = () =>
    communityChrome(
      props.view,
      location.pathname,
      props.practiceOpen,
      props.communityId,
      props.publicProfileAuthor,
      props.ownPublicProfile,
    );
  // ApplicationChrome highlights Home for the community's own home route.
  // All other routes keep the exact copied policy (including no active song tab).
  const active = () =>
    !props.walletPage && (props.view === "home" || props.view === "publish")
      ? "home"
      : policy().activeItemId;
  const desktop = createMediaQuery("(min-width: 768px)");
  createEffect(active, (_, previous) => {
    if (previous !== undefined) setMenuOpen(false);
  });
  createEffect(desktop, (wide, previous) => {
    if (wide && previous === false) setMenuOpen(false);
  });
  const items = (): SidebarItem[] => [
    { id: "home", label: "Home", href: "/#/", iconKind: "home" },
    { id: "songs", label: "Your Songs", href: "/#/songs", iconKind: "songs" },
    ...(props.rewards
      ? [
          {
            id: "wallet",
            label: "Wallet",
            href: "/wallet",
            iconKind: "wallet" as const,
          },
        ]
      : []),
    {
      id: "profile",
      label: "Profile",
      href: "/#/account",
      iconKind: "profile",
      avatar: { fallback: "Profile", seed: props.accountSeed },
    },
  ];
  const navigateItem = (id: string) => {
    const href = items().find((item) => item.id === id)?.href;
    if (href) go(href);
  };
  const sidebar = (mobile: boolean) => (
    <AppSidebar
      class={
        mobile ? "h-full w-full border-0" : "sticky top-0 hidden h-dvh md:flex"
      }
      activeItemId={active()}
      primaryItems={items()}
      brandLabel={props.name || undefined}
      homeAriaLabel="Go home"
      onHomeClick={() => go("/#/")}
      onNavigate={navigateItem}
      communityState={{ kind: "hidden" }}
      navigationScope={{
        kind: "community",
        community: {
          communityId: props.communityId,
          displayName: props.name,
          href: "/#/",
        },
      }}
      signInAction={
        !props.signedIn && props.ready && props.canSignIn
          ? { onClick: props.onSignIn, prepare: () => {}, preload: () => {} }
          : undefined
      }
      accountControl={
        props.signedIn
          ? {
              label: "Profile",
              displayName: "Profile",
              avatarSeed: props.accountSeed,
              onClick: () => go("/#/account"),
            }
          : undefined
      }
    />
  );
  return (
    <Show when={policy().mode !== "bare"} fallback={props.children}>
      <div
        class="min-h-screen bg-background text-foreground"
        data-application-chrome
        onClick={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          const anchor = (event.target as Element).closest?.(
            "a[href]",
          ) as HTMLAnchorElement | null;
          if (
            !anchor ||
            anchor.hasAttribute("download") ||
            (anchor.target && anchor.target !== "_self")
          )
            return;
          const href = anchor.getAttribute("href")!;
          const destination = fragmentNavigationHref(
            href,
            new URL(location.href),
          );
          if (destination !== href) anchor.setAttribute("href", destination);
        }}
        data-media-shell
        data-shell-mode={policy().mode}
        data-shell-auth={
          !props.ready
            ? "resolving"
            : props.signedIn
              ? "authenticated"
              : "anonymous"
        }
      >
        <a
          class="app-skip"
          href="#app-content"
          inert={props.practiceOpen}
          onClick={(event) => {
            event.preventDefault();
            document.getElementById("app-content")?.focus();
          }}
        >
          Skip to content
        </a>
        <div class="flex min-h-screen">
          <div class="hidden md:block" inert={props.practiceOpen}>
            {sidebar(false)}
          </div>
          <Sheet open={menuOpen()} onOpenChange={setMenuOpen}>
            <SheetContent
              side="left"
              onCloseAutoFocus={afterMenuClose}
              class="flex h-dvh w-80 max-w-[85vw] flex-col gap-0 bg-sidebar p-0 text-sidebar-foreground md:hidden"
              aria-label="Navigation"
            >
              <SheetHeader class="sr-only">
                <SheetTitle>Navigation</SheetTitle>
              </SheetHeader>
              <NavigationDrawer
                state={{ kind: "hidden" }}
                scope={{
                  kind: "community",
                  community: {
                    communityId: props.communityId,
                    displayName: props.name,
                    href: "/#/",
                  },
                }}
                currentPath={props.view === "home" ? "/#/" : undefined}
                onNavigate={go}
                onRetry={() => {}}
              />
            </SheetContent>
          </Sheet>
          <SidebarContent
            class={
              props.composing || policy().hideMobileFooter
                ? "min-h-[100dvh] bg-background md:min-h-screen"
                : "min-h-[100dvh] bg-background pb-20 md:min-h-screen md:pb-0"
            }
          >
            <div
              inert={props.practiceOpen || props.busy || !props.ready}
              aria-busy={!props.ready || props.busy ? "true" : "false"}
            >
              <Show when={!policy().hideMobileHeader && !props.composing}>
                <div class="md:hidden">
                  <AppHeader
                    forceMobile
                    hideBrand
                    showCreateAction={false}
                    showNotificationsAction={false}
                    showProfileAction={false}
                    showWalletAction={false}
                    showConnectAction={false}
                    mobileLeadingContent={
                      <IconButton
                        ref={(element: HTMLButtonElement) => {
                          menuTrigger = element;
                        }}
                        aria-label="Open navigation"
                        aria-expanded={menuOpen() ? "true" : "false"}
                        aria-haspopup="dialog"
                        onClick={() => setMenuOpen(true)}
                        variant="ghost"
                        class="-ms-1.5"
                      >
                        <IconList class="size-6" />
                      </IconButton>
                    }
                    mobileCenterContent={
                      <Show when={policy().mobileTitle}>
                        <Type as="span" variant="h4">
                          {policy().mobileTitle}
                        </Type>
                      </Show>
                    }
                    mobileTrailingContent={
                      <div class="flex items-center gap-1">
                        <Show
                          when={
                            !props.signedIn && props.ready && props.canSignIn
                          }
                        >
                          <Button
                            onClick={props.onSignIn}
                            size="sm"
                            variant="ghost"
                          >
                            Sign in
                          </Button>
                        </Show>
                      </div>
                    }
                  />
                </div>
              </Show>
            </div>
            <div
              id="app-content"
              tabindex={-1}
              class={
                policy().hideMobileHeader || props.composing
                  ? "min-h-[100dvh] w-full md:min-h-screen"
                  : "min-h-[100dvh] w-full pt-[calc(env(safe-area-inset-top)+4rem)] md:min-h-screen md:pt-0"
              }
            >
              {props.children}
            </div>
            <div inert={props.practiceOpen}>
              <MobileFooterNav
                forceMobile
                showWallet={props.rewards}
                class={
                  props.composing || policy().hideMobileFooter
                    ? "hidden"
                    : "md:hidden"
                }
                activeItem={policy().mobileActiveItem}
                labels={{
                  home: "Home",
                  songs: "Your Songs",
                  profile: "Profile",
                }}
                avatarFallback="Profile"
                userAvatarSeed={props.accountSeed}
                onHomeClick={() => go("/#/")}
                onSongsClick={() => go("/#/songs")}
                onWalletClick={() => go("/wallet")}
                onProfileClick={() => go("/#/account")}
              />
            </div>
          </SidebarContent>
        </div>
        <Toaster />
      </div>
    </Show>
  );
}
