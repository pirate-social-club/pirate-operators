import { describe, expect, test } from "vitest";

import { fiveChainSections, sharedWalletAddress } from "./wallet-flow-fixtures";
import {
  chainFiatTotal,
  formatFiatTotal,
  getDefaultReceiveChainId,
} from "./wallet-receive-sheet-model";

describe("wallet receive sheet model", () => {
  test("defaults to usable Base regardless of fiat balances", () => {
    expect(getDefaultReceiveChainId(fiveChainSections)).toBe("base");
    expect(getDefaultReceiveChainId(fiveChainSections.filter(section => section.chainId !== "base"))).toBeUndefined();
    expect(getDefaultReceiveChainId(fiveChainSections.map(section => section.chainId === "base" ? { ...section, availability: "later" } : section))).toBeUndefined();
  });

  test("ignores chains without addresses and formats their deterministic totals", () => {
    const sections = fiveChainSections.map((section) => ({ ...section, walletAddress: section.chainId === "base" ? sharedWalletAddress : null }));
    expect(getDefaultReceiveChainId(sections)).toBe("base");
    expect(chainFiatTotal(sections[1]!)).toBe(608.82);
    expect(formatFiatTotal(sections[1]!)).toBe("$608.82");
  });

  test("includes usdPrice-only tokens in totals without using them for selection", () => {
    const sections = [
      {
        chainId: "ethereum" as const,
        title: "Ethereum Sepolia",
        availability: "ready" as const,
        walletAddress: sharedWalletAddress,
        tokens: [{ id: "eth", symbol: "ETH", name: "Ether", balance: "2", usdPrice: 10 }],
      },
      {
        chainId: "base" as const,
        title: "Base Sepolia",
        availability: "ready" as const,
        walletAddress: sharedWalletAddress,
        tokens: [{ id: "usdc", symbol: "USDC", name: "USD Coin", balance: "5", fiatValue: "$5.00" }],
      },
    ];

    expect(chainFiatTotal(sections[0]!)).toBe(20);
    expect(formatFiatTotal(sections[0]!)).toBe("$20.00");
    expect(getDefaultReceiveChainId(sections)).toBe("base");
  });
});

test("unpriced token balances never imply a zero-dollar receive balance", () => {
  expect(formatFiatTotal({ chainId: "ethereum", title: "Ethereum", availability: "ready", tokens: [{ id: "eth", symbol: "ETH", name: "Ether", balance: "1" }] })).toBe("—");
});
