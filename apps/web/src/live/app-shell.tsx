import { For } from "solid-js";
import { Dynamic, type JSX } from "@solidjs/web";
import {
  IconHouse,
  IconPlaylist,
  IconWallet,
  IconList,
  IconPlus,
} from "@/components/media/icons";
import type { AppView } from "../shell/routing.ts";

// Independently owned pure Solid adaptation. See docs/v1-shell-provenance.md.
export function CommunityAppShell(props: {
  name: string;
  view: AppView;
  walletPage: boolean;
  rewards: boolean;
  publisher: boolean;
  practiceOpen: boolean;
  account: JSX.Element;
  children: JSX.Element;
}) {
  const active = () => (props.walletPage ? "wallet" : props.view);
  const items = () => [
    { id: "home", label: "Home", href: "/#/", icon: IconHouse },
    { id: "songs", label: "Songs", href: "/#/songs", icon: IconPlaylist },
    ...(props.rewards
      ? [{ id: "wallet", label: "Wallet", href: "/wallet", icon: IconWallet }]
      : []),
    { id: "account", label: "Account", href: "/#/account", icon: IconList },
    ...(props.publisher
      ? [{ id: "publish", label: "Create", href: "/#/publish", icon: IconPlus }]
      : []),
  ];
  return (
    <div class="community-app">
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
      <aside
        class="app-sidebar"
        aria-label="Community navigation"
        inert={props.practiceOpen}
      >
        <a class="app-community" href="/#/">
          <span class="app-community-avatar" aria-hidden="true">
            {props.name.slice(0, 1).toUpperCase()}
          </span>
          <span>{props.name}</span>
        </a>
        <nav aria-label="Main navigation">
          <For each={items()}>
            {(item) => (
              <a
                href={item.href}
                class="app-nav-link"
                aria-current={active() === item.id ? "page" : undefined}
              >
                <span aria-hidden="true">
                  <Dynamic component={item.icon} class="size-5" />
                </span>
                <span>{item.label}</span>
              </a>
            )}
          </For>
        </nav>
        <p class="app-network">
          Testnet<span>Rewards use test tokens.</span>
        </p>
      </aside>
      <div class="app-content-column">
        <header class="live-header app-header" inert={props.practiceOpen}>
          <a href="/#/" class="app-header-community">
            {props.name}
          </a>
          <span class="app-testnet">Testnet</span>
          <div class="app-header-account">{props.account}</div>
        </header>
        <div id="app-content" tabindex={-1}>
          {props.children}
        </div>
      </div>
      <nav
        class="app-mobile-nav"
        aria-label="Primary navigation"
        inert={props.practiceOpen}
      >
        <For each={items()}>
          {(item) => (
            <a
              href={item.href}
              class="app-nav-link"
              aria-current={active() === item.id ? "page" : undefined}
            >
              <span aria-hidden="true">
                <Dynamic component={item.icon} class="size-5" />
              </span>
              <span>{item.label}</span>
            </a>
          )}
        </For>
      </nav>
    </div>
  );
}
