// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import { formatUsdValue } from "./wallet-hub-model.ts";
import type {
  WalletHubChainId,
  WalletHubChainSection,
} from "./wallet-hub.types";

function parseFiatValue(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value.replace(/[^0-9.-]/gu, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function tokenFiatAmount(
  token: WalletHubChainSection["tokens"][number],
): number {
  return parseFiatValue(token.fiatValue ?? formatUsdValue(token));
}

export function chainFiatTotal(section: WalletHubChainSection): number {
  return section.tokens.reduce(
    (total, token) => total + tokenFiatAmount(token),
    0,
  );
}

export function formatFiatTotal(section: WalletHubChainSection): string {
  if (
    section.balancesUnavailable ||
    section.tokens.some(
      (token) => !token.fiatValue && formatUsdValue(token) === null,
    )
  )
    return "—";
  return chainFiatTotal(section).toLocaleString("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  });
}

/** The admitted community exposes only its own configured testnet receive section. */
export function getDefaultReceiveChainId(
  chainSections: WalletHubChainSection[],
  walletAddress?: string | null,
): WalletHubChainId | undefined {
  return chainSections.some(
    (section) =>
      section.chainId === "megaeth" &&
      section.availability === "ready" &&
      !!(section.walletAddress ?? walletAddress),
  )
    ? "megaeth"
    : undefined;
}
