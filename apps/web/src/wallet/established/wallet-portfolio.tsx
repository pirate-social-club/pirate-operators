// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  Avatar,
  Button,
  Card,
  CardContent,
  CardHeader,
  IconArrowsClockwise,
  Type,
} from "./design-system.ts";
import { WalletHub } from "./wallet-hub.tsx";
import { WalletReceiveSheet } from "./wallet-receive-sheet.tsx";
import { type PersonaWallet } from "./wallet-portfolio-model.ts";

import { type WalletNetworkMode } from "./wallet-network-catalog.ts";
import type { WalletHubChainSection } from "./wallet-hub.types.ts";
import type { WalletHubSheetControls } from "./wallet-hub.types.ts";

export interface WalletPortfolioProps {
  chainSections: WalletHubChainSection[];
  balancesLoading?: boolean;
  totalBalanceUsd?: string | null;
  rewardsSummary?: import("./wallet-hub.types").WalletHubRewardsSummary;
  actionAsset?: {
    chainId: import("./wallet-hub.types").WalletHubChainId;
    tokenId: string;
  };
  onRefresh?: () => void;
  networkMode?: WalletNetworkMode;
  onNetworkModeChange?: (mode: WalletNetworkMode) => void;
  /** The network whose Base USDC row offers winnings and Send; without one, neither. */
  actionMode?: WalletNetworkMode;
  wallets: readonly PersonaWallet[];
  selectedPersonaId?: string;
  onSelect: (personaId: string) => void;
  onChangeProfile: () => void;
  renderBaseUsdc?: (wallet: PersonaWallet) => JSX.Element;
  renderSendSheet?: (
    wallet: PersonaWallet,
    controls: WalletHubSheetControls,
  ) => JSX.Element;
}

/** Private account portfolio. Receive always names one selected persona address. */
export function WalletPortfolio(props: WalletPortfolioProps) {
  const selected = () =>
    props.wallets.find(
      (wallet) => wallet.personaId === props.selectedPersonaId,
    );
  const sections = () => props.chainSections;
  const actions = () =>
    props.actionMode !== undefined &&
    (props.networkMode ?? "mainnet") === props.actionMode;
  return (
    <div class="mx-auto flex w-full max-w-[640px] flex-col gap-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        {/* Only hosts that have Testnet pass a handler; production shows no switch. */}
        <Show when={props.onNetworkModeChange}>
          {(change) => (
            <div class="flex gap-2" role="group" aria-label="Wallet networks">
              <Button
                size="sm"
                variant={
                  (props.networkMode ?? "mainnet") === "mainnet"
                    ? "secondary"
                    : "ghost"
                }
                aria-pressed={
                  (props.networkMode ?? "mainnet") === "mainnet"
                    ? "true"
                    : "false"
                }
                onClick={() => change()("mainnet")}
              >
                Mainnet
              </Button>
              <Button
                size="sm"
                variant={
                  props.networkMode === "testnet" ? "secondary" : "ghost"
                }
                aria-pressed={
                  props.networkMode === "testnet" ? "true" : "false"
                }
                onClick={() => change()("testnet")}
              >
                Testnet
              </Button>
            </div>
          )}
        </Show>
        <Show when={props.onRefresh}>
          <Button
            class="ms-auto"
            size="icon"
            variant="ghost"
            aria-label="Refresh balances"
            aria-busy={props.balancesLoading ? "true" : "false"}
            disabled={props.balancesLoading || !selected()?.address}
            onClick={() => {
              if (!props.balancesLoading && selected()?.address)
                props.onRefresh?.();
            }}
          >
            <IconArrowsClockwise class="size-5" aria-hidden="true" />
          </Button>
        </Show>
      </div>
      <Show
        when={selected()}
        fallback={<Type>Choose a profile to view its wallet.</Type>}
      >
        {(wallet) => (
          <WalletHub
            walletLabel={wallet().displayName}
            walletAddress={wallet().address}
            assetsUnavailable={props.balancesLoading}
            totalBalanceUsd={props.totalBalanceUsd ?? null}
            rewardsSummary={props.rewardsSummary}
            showChangeWalletAction={false}
            chainSections={sections()}
            renderAssetSupplement={(chainId, token) =>
              actions() &&
              chainId === props.actionAsset?.chainId &&
              token.id === props.actionAsset?.tokenId
                ? props.renderBaseUsdc?.(wallet())
                : undefined
            }
            renderReceiveSheet={
              wallet().address
                ? (controls) => (
                    <WalletReceiveSheet
                      {...controls}
                      chainSections={sections()}
                      walletAddress={wallet().address}
                    />
                  )
                : undefined
            }
            renderSendSheet={
              actions() && wallet().address && props.renderSendSheet
                ? (controls) => props.renderSendSheet?.(wallet(), controls)
                : undefined
            }
          />
        )}
      </Show>
      <Card>
        <CardHeader>
          <Type as="h2" variant="h3">
            Your wallets
          </Type>
        </CardHeader>
        <CardContent>
          <Show
            when={props.wallets.length > 0}
            fallback={<Type>No active profile wallets yet.</Type>}
          >
            <ul class="divide-y divide-border-soft">
              <For each={props.wallets}>
                {(wallet) => (
                  <li>
                    <button
                      type="button"
                      aria-pressed={
                        wallet.personaId === props.selectedPersonaId
                          ? "true"
                          : "false"
                      }
                      onClick={() => props.onSelect(wallet.personaId)}
                      class="flex w-full cursor-pointer items-center gap-3 rounded-lg p-3 text-start hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Avatar
                        fallback={wallet.displayName}
                        src={wallet.avatarSrc ?? undefined}
                        fallbackSeed={wallet.displayName}
                      />
                      <span class="min-w-0 flex-1">
                        <Type
                          as="span"
                          variant="body-strong"
                          class="block truncate"
                        >
                          {wallet.displayName}
                        </Type>
                        <Type
                          as="span"
                          variant="caption"
                          class="block break-all"
                        >
                          {wallet.address ?? "Wallet unavailable"}
                        </Type>
                      </span>
                      <Show when={wallet.personaId === props.selectedPersonaId}>
                        <Type as="span" variant="caption">
                          Selected
                        </Type>
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </CardContent>
      </Card>
    </div>
  );
}
