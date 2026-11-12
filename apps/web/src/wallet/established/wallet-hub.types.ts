// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import type { JSX } from "@solidjs/web";

export type WalletHubChainId =
  | "megaeth"
  | "data"
  | "ethereum"
  | "base"
  | "optimism"
  | "story"
  | "tempo"
  | "solana"
  | "bitcoin"
  | "cosmos";

type WalletHubChainAvailability = "ready" | "later";

export interface WalletHubToken {
  id: string;
  symbol: string;
  name: string;
  balance?: string;
  fiatValue?: string;
  priceId?: string;
  usdPrice?: number | null;
}

export interface WalletHubChainSection {
  chainId: WalletHubChainId;
  title: string;
  availability: WalletHubChainAvailability;
  walletAddress?: string | null;
  tokens: WalletHubToken[];
  note?: string;
  balancesUnavailable?: boolean;
}

export interface WalletHubRewardsSummary {
  actionDisabled?: boolean;
  actionLabel: string;
  amountLabel: string;
  assetLabel: string;
  onAction?: () => void;
  pending?: boolean;
  supportingLabel?: string;
}

export interface WalletHubSheetControls {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export interface WalletHubProps {
  variant?: "route" | "embedded";
  title?: string;
  walletLabel?: string;
  changeWalletLabel?: string;
  showChangeWalletAction?: boolean;
  assetsUnavailable?: boolean;
  walletAddress?: string | null;
  walletActionsPending?: boolean;
  onChangeWallet?: () => void;
  totalBalanceUsd?: string | null;
  claimableDataWei?: string;
  claimableSalesCount?: number;
  claimLoading?: boolean;
  onClaim?: () => void;
  onReceive?: () => void;
  onSend?: () => void;
  /** Render callback hosting the controlled receive sheet; the hub owns its open state. */
  renderReceiveSheet?: (controls: WalletHubSheetControls) => JSX.Element;
  /** Render callback hosting the controlled send sheet; the hub owns its open state. */
  renderSendSheet?: (controls: WalletHubSheetControls) => JSX.Element;
  /** Extra controls inside an asset row, such as a paid USDC winning. */
  renderAssetSupplement?: (
    chainId: WalletHubChainId,
    token: WalletHubToken,
  ) => JSX.Element | undefined;
  rewardsSummary?: WalletHubRewardsSummary;
  chainSections: WalletHubChainSection[];
}
