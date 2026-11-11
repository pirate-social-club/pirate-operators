import { describe, expect, test } from "vitest";

import { fiveChainSections, sharedWalletAddress } from "./wallet-flow-fixtures";
import {
  buildWalletReceiveSheetView,
  resolveReceiveChainId,
} from "./wallet-receive-sheet-view-model";
import type { WalletHubChainSection } from "./wallet-hub.types";

const laterSection: WalletHubChainSection = {
  chainId: "solana",
  title: "Solana",
  availability: "later",
  tokens: [],
  note: "Coming later",
};

describe("wallet receive sheet view model", () => {
  test("defaults to usable Base regardless of fiat balance", () => {
    const view = buildWalletReceiveSheetView({ chainSections: fiveChainSections, open: true, onOpenChange: () => {} });
    expect(view.selectedChainId).toBe("base");
    expect(view.address).toBe(sharedWalletAddress);
    // Paper: the address is never cut; it wraps instead.
    expect(view.addressLabel).toBe(sharedWalletAddress);
  });

  test("honors only usable explicit selections", () => {
    const props = { chainSections: fiveChainSections, open: true, onOpenChange: () => {} };
    expect(resolveReceiveChainId(props, "story")).toBe("story");
    expect(resolveReceiveChainId(props, "cosmos")).toBe("base");
  });

  test("marks later chains disabled with their note and never selects them", () => {
    const view = buildWalletReceiveSheetView(
      { chainSections: [...fiveChainSections, laterSection], open: true, onOpenChange: () => {} },
      "solana",
    );
    const solana = view.chains.find((chain) => chain.chainId === "solana");
    expect(solana).toMatchObject({ disabled: true, note: "Coming later", selected: false });
    expect(view.selectedChainId).toBe("base");
  });

  test("disables ready chains without any address and falls back to the global wallet address", () => {
    const sections = fiveChainSections.map((section) => ({ ...section, walletAddress: null }));
    const withGlobal = buildWalletReceiveSheetView(
      { chainSections: sections, walletAddress: sharedWalletAddress, open: true, onOpenChange: () => {} },
      "base",
    );
    expect(withGlobal.selectedChainId).toBe("base");
    expect(withGlobal.address).toBe(sharedWalletAddress);

    const withoutGlobal = buildWalletReceiveSheetView({
      chainSections: sections,
      open: true,
      onOpenChange: () => {},
    });
    expect(withoutGlobal.selectedChainId).toBeUndefined();
    expect(withoutGlobal.address).toBeNull();
    expect(withoutGlobal.addressLabel).toBe("");
    expect(withoutGlobal.chains.every((chain) => chain.disabled)).toBe(true);
    expect(withoutGlobal.chains[0]?.note).toBe("Unavailable");
  });

  test("requires explicit choice when Base is unavailable even if other balances are higher", () => {
    const sections = fiveChainSections.map(section => section.chainId === "base" ? { ...section, walletAddress: null } : section);
    const props = { chainSections: sections, open: true, onOpenChange: () => {} };
    expect(buildWalletReceiveSheetView(props)).toMatchObject({ address: null, selectedChainId: undefined });
    expect(buildWalletReceiveSheetView(props, "story")).toMatchObject({ address: sharedWalletAddress, selectedChainId: "story" });
  });

  test("exposes per-chain fiat totals for the chain list", () => {
    const view = buildWalletReceiveSheetView({ chainSections: fiveChainSections, open: true, onOpenChange: () => {} });
    expect(view.chains.find((chain) => chain.chainId === "base")?.fiatLabel).toBe("$608.82");
  });
});
