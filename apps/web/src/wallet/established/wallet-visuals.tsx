// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import { Dynamic } from "@solidjs/web";
import type { Component } from "solid-js";

import {
  BadgedCircle,
  NetworkBase,
  NetworkBitcoin,
  NetworkEthereum,
  NetworkOptimism,
  NetworkTempo,
  TokenBTC,
  TokenDAI,
  TokenETH,
  TokenLINK,
  TokenSOL,
  TokenUSDC,
  TokenUSDT,
  type Web3IconProps,
  cn,
} from "./design-system.ts";
import type { WalletHubChainId, WalletHubToken } from "./wallet-hub.types";

import cosmosIconUrl from "./assets/cosmos.png?no-inline";
import ipIconUrl from "./assets/ip.png?no-inline";
import sentinelIconUrl from "./assets/sentinel.png?no-inline";
import solanaIconUrl from "./assets/solana.png?no-inline";
import storyIconUrl from "./assets/story.png?no-inline";

type Web3IconComponent = Component<Web3IconProps>;

// Story Protocol rebranded as the DATA Foundation ($IP became $DATA one for
// one; spec 008 §2). Until a DATA mark ships, $DATA and DATA Network use the
// Story artwork the legacy wallet used.
const LOCAL_TOKEN_ICON_BY_SYMBOL = new Map([
  ["ATOM", cosmosIconUrl],
  ["IP", ipIconUrl],
  ["WIP", ipIconUrl],
  ["$DATA", ipIconUrl],
  ["DATA", ipIconUrl],
  ["P2P", sentinelIconUrl],
]);

const LOCAL_CHAIN_ICON_BY_CHAIN_ID = new Map<WalletHubChainId, string>([
  ["cosmos", cosmosIconUrl],
  ["data", storyIconUrl],
  ["solana", solanaIconUrl],
  ["story", storyIconUrl],
]);

const WEB3_TOKEN_ICON_BY_SYMBOL = new Map<string, Web3IconComponent>([
  ["BTC", TokenBTC],
  ["DAI", TokenDAI],
  ["ETH", TokenETH],
  ["LINK", TokenLINK],
  ["SOL", TokenSOL],
  ["USDC", TokenUSDC],
  ["USDT", TokenUSDT],
  ["WBTC", TokenBTC],
  ["WETH", TokenETH],
]);

const WEB3_CHAIN_ICON_BY_CHAIN_ID = new Map<
  WalletHubChainId,
  Web3IconComponent
>([
  ["base", NetworkBase],
  ["bitcoin", NetworkBitcoin],
  ["ethereum", NetworkEthereum],
  ["optimism", NetworkOptimism],
  ["tempo", NetworkTempo],
]);

const chainLabels = new Map<WalletHubChainId, string>([
  ["data", "DATA"],
  ["bitcoin", "BTC"],
  ["cosmos", "ATOM"],
  ["ethereum", "ETH"],
  ["base", "BASE"],
  ["optimism", "OP"],
  ["solana", "SOL"],
  ["story", "IP"],
  ["tempo", "T"],
]);

function LocalIcon(props: { class?: string; src: string }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      class={cn("block size-full object-contain", props.class)}
      draggable={false}
      src={props.src}
    />
  );
}

/** Legacy fallback: the symbol's first letter on the muted surface. */
function WalletIconFallback(props: { label: string; class?: string }) {
  const letter = props.label.replace(/^\$/, "").slice(0, 1).toUpperCase();
  return (
    <span
      aria-hidden="true"
      class={cn(
        "grid size-full place-items-center rounded-full bg-muted text-base font-semibold text-foreground",
        props.class,
      )}
    >
      {letter}
    </span>
  );
}

export function ChainIcon(props: {
  chainId: WalletHubChainId;
  class?: string;
  framed?: boolean;
}) {
  const web3Icon = WEB3_CHAIN_ICON_BY_CHAIN_ID.get(props.chainId);
  const iconUrl = LOCAL_CHAIN_ICON_BY_CHAIN_ID.get(props.chainId);
  // Framed icons sit inside a white disc; an unframed badge fills its frame.
  const fit = props.framed === false ? "size-full" : "size-[74%]";
  const content = web3Icon ? (
    <Dynamic component={web3Icon} class={fit} />
  ) : iconUrl ? (
    <LocalIcon class={fit} src={iconUrl} />
  ) : (
    <WalletIconFallback
      class={fit}
      label={chainLabels.get(props.chainId) ?? props.chainId}
    />
  );

  if (props.framed === false) {
    return (
      <span class={cn("grid shrink-0 place-items-center", props.class)}>
        {content}
      </span>
    );
  }

  return (
    <span
      class={cn(
        "grid size-11 shrink-0 place-items-center overflow-hidden rounded-full bg-white",
        props.class,
      )}
    >
      {content}
    </span>
  );
}

export function TokenChainIcon(props: {
  chainId: WalletHubChainId;
  chainLabel?: string;
  showChainBadge?: boolean;
  token: Pick<WalletHubToken, "name" | "symbol">;
  size?: "sm" | "md";
}) {
  const symbol = props.token.symbol.toUpperCase();
  const web3Icon = WEB3_TOKEN_ICON_BY_SYMBOL.get(symbol);
  const iconUrl = LOCAL_TOKEN_ICON_BY_SYMBOL.get(symbol);
  const isSmall = props.size === "sm";
  const circleClass = isSmall ? "size-10" : "size-12";
  const iconClass = isSmall ? "size-7" : "size-8";
  const icon = (
    <span
      class={cn(
        "grid place-items-center overflow-hidden rounded-full border border-border bg-white p-1",
        circleClass,
      )}
    >
      {web3Icon ? (
        <Dynamic component={web3Icon} class={iconClass} />
      ) : iconUrl ? (
        <LocalIcon class={iconClass} src={iconUrl} />
      ) : (
        <WalletIconFallback class={iconClass} label={symbol} />
      )}
    </span>
  );

  if (!props.showChainBadge) return icon;

  return (
    <BadgedCircle
      badge={
        <ChainIcon chainId={props.chainId} class="size-4" framed={false} />
      }
      badgeLabel={props.chainLabel ? `${props.chainLabel} chain` : undefined}
      // Legacy seats the branded network mark on white; the design-system
      // default card surface hides dark marks such as Ethereum's.
      badgeFrameClassName="border border-white/70 bg-white"
      badgePadding={isSmall ? 2 : 3}
      badgeSize={isSmall ? 16 : 18}
      class={circleClass}
    >
      {icon}
    </BadgedCircle>
  );
}
