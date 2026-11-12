// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import {
  getDefaultReceiveChainId,
  formatFiatTotal,
} from "./wallet-receive-sheet-model.ts";
import type { WalletReceiveSheetProps } from "./wallet-receive-sheet.types";
import type { WalletHubChainId } from "./wallet-hub.types";

export interface WalletReceiveChainOption {
  chainId: WalletHubChainId;
  disabled: boolean;
  fiatLabel: string;
  note?: string;
  selected: boolean;
  title: string;
}

export interface WalletReceiveSheetView {
  address: string | null;
  addressLabel: string;
  chains: WalletReceiveChainOption[];
  selectedChainId?: WalletHubChainId;
  selectedTitle?: string;
}

function resolveAddress(
  props: WalletReceiveSheetProps,
  chainId: WalletHubChainId,
): string | null {
  const section = props.chainSections.find((item) => item.chainId === chainId);
  return section?.walletAddress ?? props.walletAddress ?? null;
}

function isReceiveable(
  props: WalletReceiveSheetProps,
  chainId: WalletHubChainId,
): boolean {
  const section = props.chainSections.find((item) => item.chainId === chainId);
  return section?.availability === "ready" && !!resolveAddress(props, chainId);
}

export function resolveReceiveChainId(
  props: WalletReceiveSheetProps,
  selectedChainId?: WalletHubChainId,
): WalletHubChainId | undefined {
  if (selectedChainId && isReceiveable(props, selectedChainId))
    return selectedChainId;
  return getDefaultReceiveChainId(props.chainSections, props.walletAddress);
}

export function buildWalletReceiveSheetView(
  props: WalletReceiveSheetProps,
  selectedChainId?: WalletHubChainId,
): WalletReceiveSheetView {
  const resolvedChainId = resolveReceiveChainId(props, selectedChainId);
  const address = resolvedChainId
    ? resolveAddress(props, resolvedChainId)
    : null;

  return {
    address,
    // Paper: the full address, never cut in the middle; it wraps.
    addressLabel: address ?? "",
    selectedChainId: resolvedChainId,
    selectedTitle: props.chainSections.find(
      (section) => section.chainId === resolvedChainId,
    )?.title,
    chains: props.chainSections.map((section) => {
      const later = section.availability === "later";
      const missingAddress = !later && !resolveAddress(props, section.chainId);
      return {
        chainId: section.chainId,
        title: section.title,
        fiatLabel: formatFiatTotal(section),
        disabled: later || missingAddress,
        note: later
          ? (section.note ?? "Available later")
          : missingAddress
            ? "Unavailable"
            : undefined,
        selected: section.chainId === resolvedChainId,
      };
    }),
  };
}
