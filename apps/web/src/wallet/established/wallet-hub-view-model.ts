// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import {
  buildWalletAssetRows,
  formatTotalBalanceUsd,
  type WalletHubAssetRow,
} from "./wallet-hub-model.ts";
import type {
  WalletHubChainSection,
  WalletHubProps,
  WalletHubRewardsSummary,
} from "./wallet-hub.types";

function formatDataAmount(wei: string | null | undefined): string {
  if (!wei) return "0";
  try {
    const value = BigInt(wei);
    const base = 10n ** 18n;
    const whole = value / base;
    const fraction = (value % base)
      .toString()
      .padStart(18, "0")
      .slice(0, 6)
      .replace(/0+$/u, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return "0";
  }
}

export interface WalletHubActionView {
  disabled: boolean;
  label: string;
  pending?: boolean;
  onSelect?: () => void;
}

export interface WalletHubRewardsView {
  action?: WalletHubActionView;
  amountLabel: string;
  assetLabel: string;
  pending: boolean;
  supportingLabel?: string;
}

export interface WalletHubView {
  assetRows: WalletHubAssetRow[];
  claim?: {
    action: WalletHubActionView;
    amountLabel: string;
    supportingLabel?: string;
  };
  connected: boolean;
  /** Computed fiat label per `${chainId}:${tokenId}`, including usdPrice-derived values. */
  fiatByTokenId: Record<string, string | null>;
  isEmpty: boolean;
  laterSections: WalletHubChainSection[];
  readySections: WalletHubChainSection[];
  rewards?: WalletHubRewardsView;
  title: string;
  totalBalanceLabel: string | null;
  walletLabel: string;
  actions: {
    changeWallet: WalletHubActionView;
    receive: WalletHubActionView;
    send: WalletHubActionView;
  };
}

export function formatWalletAddressLabel(
  address: string | null | undefined,
): string {
  if (!address) return "No wallet connected";
  return address.length <= 16
    ? address
    : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function hasAnyToken(sections: WalletHubChainSection[]): boolean {
  return sections.some((section) => section.tokens.length > 0);
}

function resolveTotalBalanceLabel(
  props: WalletHubProps,
  readySections: WalletHubChainSection[],
): string | null {
  if (props.totalBalanceUsd !== undefined) return props.totalBalanceUsd;
  if (
    props.assetsUnavailable ||
    readySections.some((section) => section.balancesUnavailable)
  )
    return null;
  if (!hasAnyToken(readySections)) return null;
  return formatTotalBalanceUsd(readySections);
}

function resolveRewardsView(
  summary: WalletHubRewardsSummary | undefined,
): WalletHubRewardsView | undefined {
  if (!summary) return undefined;
  const pending = summary.pending === true;
  return {
    amountLabel: summary.amountLabel,
    assetLabel: summary.assetLabel,
    pending,
    supportingLabel: summary.supportingLabel,
    action: summary.onAction
      ? {
          disabled: pending || summary.actionDisabled === true,
          label: summary.actionLabel,
          pending,
          onSelect: summary.onAction,
        }
      : undefined,
  };
}

export function buildWalletHubView(props: WalletHubProps): WalletHubView {
  const connected = Boolean(props.walletAddress);
  const readySections = props.chainSections.filter(
    (section) => section.availability === "ready",
  );
  const laterSections = props.chainSections.filter(
    (section) => section.availability === "later",
  );
  const isEmpty = !hasAnyToken(readySections);
  const claimLoading = props.claimLoading === true;

  const claim =
    props.claimableDataWei != null
      ? {
          amountLabel: `${formatDataAmount(props.claimableDataWei)} $DATA`,
          supportingLabel:
            props.claimableSalesCount != null
              ? `${props.claimableSalesCount} ${props.claimableSalesCount === 1 ? "sale" : "sales"}`
              : undefined,
          action: {
            disabled: claimLoading || !props.onClaim,
            label: claimLoading ? "Claiming…" : "Claim",
            pending: claimLoading,
            onSelect: props.onClaim,
          },
        }
      : undefined;

  const assetRows = buildWalletAssetRows(readySections);
  const fiatByTokenId: Record<string, string | null> = {};
  for (const row of assetRows) {
    fiatByTokenId[row.id] = row.fiatValue;
  }

  return {
    title: props.title ?? "Wallet",
    connected,
    isEmpty,
    readySections,
    laterSections,
    assetRows,
    fiatByTokenId,
    totalBalanceLabel: resolveTotalBalanceLabel(props, readySections),
    walletLabel:
      props.walletLabel ?? formatWalletAddressLabel(props.walletAddress),
    claim,
    rewards: resolveRewardsView(props.rewardsSummary),
    actions: {
      changeWallet: {
        disabled: props.walletActionsPending === true || !props.onChangeWallet,
        label: connected ? "Change wallet" : "Connect wallet",
        pending: props.walletActionsPending === true,
        onSelect: props.onChangeWallet,
      },
      receive: {
        disabled: !props.onReceive && !props.renderReceiveSheet,
        label: "Receive",
        onSelect: props.onReceive,
      },
      send: {
        disabled: (!props.onSend && !props.renderSendSheet) || isEmpty,
        label: "Send",
        onSelect: props.onSend,
      },
    },
  };
}
