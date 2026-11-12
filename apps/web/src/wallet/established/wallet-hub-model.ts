// Independently ported 2026-11-11; exact source/blob and adaptations: docs/v1-wallet-owner-parity-20261111.md.
import type {
  WalletHubChainId,
  WalletHubChainSection,
  WalletHubToken,
} from "./wallet-hub.types";

export type GroupedAsset = {
  symbol: string;
  name: string;
  totalBalance: string;
  totalFiatValue: string | null;
  iconChainId: WalletHubChainId;
  breakdowns: Array<{
    chainId: WalletHubChainId;
    chainTitle: string;
    balance: string;
    fiatValue: string | null;
  }>;
};

export type WalletHubAssetRow = {
  id: string;
  symbol: string;
  name: string;
  balance: string;
  fiatValue: string | null;
  chainId: WalletHubChainId;
  chainTitle: string;
};

const usdFormatter = new Intl.NumberFormat("en-US", {
  currency: "USD",
  style: "currency",
});

function parseBalance(value: string): number {
  return Number.parseFloat(value.replace(/,/g, ""));
}

function formatSummedBalance(total: number): string {
  if (!Number.isFinite(total) || total === 0) return "0";
  return total.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  });
}

function sumFiatValues(values: (string | null | undefined)[]): string | null {
  let total = 0;
  for (const value of values) {
    if (!value) continue;
    const num = Number.parseFloat(value.replace(/[$,]/g, ""));
    if (Number.isFinite(num)) total += num;
  }
  return total === 0 ? null : usdFormatter.format(total);
}

export function formatUsdValue(token: WalletHubToken): string | null {
  if (token.fiatValue) return token.fiatValue;
  if (!token.balance || typeof token.usdPrice !== "number") return null;
  const balance = Number.parseFloat(token.balance.replace(/,/g, ""));
  return Number.isFinite(balance)
    ? usdFormatter.format(balance * token.usdPrice)
    : null;
}

export function formatTotalBalanceUsd(
  chainSections: WalletHubChainSection[],
): string {
  let total = 0;
  for (const section of chainSections) {
    for (const token of section.tokens) {
      const fiatValue = token.fiatValue ?? formatUsdValue(token);
      if (!fiatValue) continue;
      const amount = Number.parseFloat(fiatValue.replace(/[$,]/g, ""));
      if (Number.isFinite(amount)) total += amount;
    }
  }
  return usdFormatter.format(total);
}

const preferredChainOrder: WalletHubChainId[] = [
  "ethereum",
  "base",
  "optimism",
  "story",
  "tempo",
  "bitcoin",
  "solana",
  "cosmos",
];

const symbolOrder = new Map([
  ["ETH", 0],
  ["IP", 1],
  ["$DATA", 2],
  ["USDC", 3],
  ["USDT", 4],
  ["DAI", 5],
  ["WBTC", 6],
  ["LINK", 7],
  ["BTC", 8],
  ["SOL", 9],
  ["PATHUSD", 10],
]);

function compareAssets(
  a: {
    symbol: string;
    fiatValue?: string | null;
    totalFiatValue?: string | null;
  },
  b: {
    symbol: string;
    fiatValue?: string | null;
    totalFiatValue?: string | null;
  },
): number {
  const aSymbol = a.symbol.toUpperCase();
  const bSymbol = b.symbol.toUpperCase();
  const aTop = aSymbol === "IP" || aSymbol === "$DATA";
  const bTop = bSymbol === "IP" || bSymbol === "$DATA";
  if (aTop && !bTop) return -1;
  if (!aTop && bTop) return 1;
  if (aTop && bTop) {
    const topOrder = new Map([
      ["IP", 0],
      ["$DATA", 1],
    ]);
    return (topOrder.get(aSymbol) ?? 2) - (topOrder.get(bSymbol) ?? 2);
  }
  const aValue = a.fiatValue ?? a.totalFiatValue ?? null;
  const bValue = b.fiatValue ?? b.totalFiatValue ?? null;
  const aFiat = aValue
    ? Number.parseFloat(aValue.replace(/[$,]/g, ""))
    : Number.NaN;
  const bFiat = bValue
    ? Number.parseFloat(bValue.replace(/[$,]/g, ""))
    : Number.NaN;
  if (Number.isFinite(aFiat) && Number.isFinite(bFiat) && aFiat !== bFiat)
    return bFiat - aFiat;
  if (Number.isFinite(aFiat)) return -1;
  if (Number.isFinite(bFiat)) return 1;
  const aOrder = symbolOrder.get(aSymbol) ?? 100;
  const bOrder = symbolOrder.get(bSymbol) ?? 100;
  return aOrder - bOrder || a.symbol.localeCompare(b.symbol);
}

export function buildGroupedAssets(
  chainSections: WalletHubChainSection[],
): GroupedAsset[] {
  const groups = new Map<
    string,
    { symbol: string; name: string; items: GroupedAsset["breakdowns"] }
  >();
  for (const section of chainSections) {
    for (const token of section.tokens) {
      const symbol = token.symbol.toUpperCase();
      const existing = groups.get(symbol);
      const item = {
        chainId: section.chainId,
        chainTitle: section.title,
        balance: token.balance ?? "0",
        fiatValue: token.fiatValue ?? formatUsdValue(token),
      };
      if (existing) existing.items.push(item);
      else
        groups.set(symbol, {
          symbol: token.symbol,
          name: token.name,
          items: [item],
        });
    }
  }

  const result: GroupedAsset[] = [];
  for (const group of groups.values()) {
    const totalBalance = group.items.reduce(
      (sum, item) => sum + parseBalance(item.balance),
      0,
    );
    const available = new Set(group.items.map((item) => item.chainId));
    const iconChainId =
      preferredChainOrder.find((chainId) => available.has(chainId)) ??
      group.items[0]?.chainId ??
      "ethereum";
    result.push({
      symbol: group.symbol,
      name: group.name,
      totalBalance: formatSummedBalance(totalBalance),
      totalFiatValue: sumFiatValues(group.items.map((item) => item.fiatValue)),
      iconChainId,
      breakdowns: group.items,
    });
  }
  return result.sort(compareAssets);
}

export function buildWalletAssetRows(
  chainSections: WalletHubChainSection[],
): WalletHubAssetRow[] {
  const rows = chainSections.flatMap((section) =>
    section.tokens.map((token) => ({
      id: `${section.chainId}:${token.id}`,
      symbol: token.symbol,
      name: token.name,
      balance: token.balance ?? "0",
      fiatValue: token.fiatValue ?? formatUsdValue(token),
      chainId: section.chainId,
      chainTitle: section.title,
    })),
  );
  return rows.sort(
    (a, b) => compareAssets(a, b) || a.chainTitle.localeCompare(b.chainTitle),
  );
}
