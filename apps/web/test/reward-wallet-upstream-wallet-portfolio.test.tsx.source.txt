import { createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {} from "vitest/jsdom";
import { WalletPortfolio } from "./wallet-portfolio.tsx";
import { walletReceiveNetworks, type PersonaWallet } from "./wallet-portfolio-model.ts";
import { walletNetworkHost } from "./wallet-network-catalog.ts";
import { walletAssetSections } from "./wallet-network-catalog.ts";
import * as portfolioModel from "./wallet-portfolio-model.ts";
import * as balanceReader from "./wallet-balance-reader.ts";
import { WalletRouteView } from "./wallet-route.tsx";
import { ApplicationSessionProvider, type ApplicationSessionState } from "../shell/application-session.tsx";
import { ApplicationPersonasContext } from "../shell/application-personas.tsx";
import { rememberWalletSend, type WalletSendDraft } from "./wallet-send-continuation.ts";
import * as sponsoredSendData from "../../api/wallet-sponsored-send.ts";
import * as rewardClaim from "../../api/reward-claim.ts";
import type { RewardCredit } from "../../api/reward-claim.ts";
import { BASE_SEPOLIA_SPONSORED_SEND, BASE_SPONSORED_SEND } from "../../api/sponsored-send-network.ts";

const disposers: (() => void)[] = [];
const initialBrowserUrl = window.location.href;
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); jsdom.reconfigure({ url: initialBrowserUrl }); });
test("receiving uses only the selected persona address and never invents balances", async () => {
  const wallets: PersonaWallet[] = [
    { personaId: "one", displayName: "Harbor", publicHandle: null, avatarSrc: null, address: "0x1111111111111111111111111111111111111111" },
    { personaId: "two", displayName: "Night Shift", publicHandle: null, avatarSrc: null, address: "0x2222222222222222222222222222222222222222" },
  ];
  const [selected, setSelected] = createSignal("one");
  const element = document.createElement("div"); document.body.appendChild(element);
  disposers.push(render(() => <WalletPortfolio wallets={wallets} selectedPersonaId={selected()} onSelect={setSelected} onChangeProfile={() => {}} />, element));
  [...element.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Night Shift"))!.click();
  await vi.waitFor(() => expect(selected()).toBe("two"));
  [...element.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Receive")!.click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("0x22222222");
  expect(dialog.textContent).not.toContain("0x11111111");
  expect(document.body.textContent).not.toContain("$0.00");
  // The generic portfolio has no send control without an asset-specific action.
  expect([...element.querySelectorAll<HTMLButtonElement>("button")].some(button => button.textContent === "Send")).toBe(false);
  expect(walletReceiveNetworks(wallets[1]!.address).map(network => network.chainId)).toEqual(["ethereum", "data", "base"]);
});

test("testnet winning actions sit under the selected persona's Base USDC row", () => {
  const wallet: PersonaWallet = {
    personaId: "one", displayName: "Harbor", publicHandle: null, avatarSrc: null,
    address: "0x1111111111111111111111111111111111111111",
  };
  const element = document.createElement("div"); document.body.appendChild(element);
  disposers.push(render(() => <WalletPortfolio
    wallets={[wallet]} selectedPersonaId="one" onSelect={() => {}} onChangeProfile={() => {}}
    networkMode="testnet" actionMode="testnet" renderBaseUsdc={selected => <button type="button">Send {selected.displayName}'s winnings</button>}
  />, element));
  const send = [...element.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Send Harbor's winnings");
  expect(send?.closest("li")?.textContent).toContain("USDC");
  expect(send?.closest("section")?.getAttribute("aria-label")).toBe("Base Sepolia");
});

test("the serving deployment, not the host name, decides the networks and where Claim and Send sit", () => {
  expect(walletNetworkHost("https://pirate.sc")).toEqual({ defaultMode: "mainnet", switchable: false, actionMode: "mainnet" });
  expect(walletNetworkHost("https://web-next-staging.pirate.sc")).toEqual({ defaultMode: "testnet", switchable: true, actionMode: "testnet" });
  expect(walletNetworkHost("http://127.0.0.1:8787")).toEqual({ defaultMode: "testnet", switchable: true, actionMode: "testnet" });
  for (const unknown of [undefined, "", "pirate.sc", "web-next-staging.pirate.sc", "https://app.8s28", "https://app.harbor"]) {
    expect(walletNetworkHost(unknown)).toEqual({ defaultMode: "mainnet", switchable: false, actionMode: undefined });
  }
});

test("the portfolio shows the network switch only when a handler is passed", () => {
  const wallet: PersonaWallet = {
    personaId: "one", displayName: "Harbor", publicHandle: null, avatarSrc: null,
    address: "0x1111111111111111111111111111111111111111",
  };
  const production = document.createElement("div"); document.body.appendChild(production);
  disposers.push(render(() => <WalletPortfolio
    wallets={[wallet]} selectedPersonaId="one" onSelect={() => {}} onChangeProfile={() => {}} networkMode="mainnet"
  />, production));
  expect(production.querySelector('[aria-label="Wallet networks"]')).toBeNull();
  expect([...production.querySelectorAll("button")].some(button => button.textContent === "Testnet")).toBe(false);

  const onNetworkModeChange = vi.fn();
  const staging = document.createElement("div"); document.body.appendChild(staging);
  disposers.push(render(() => <WalletPortfolio
    wallets={[wallet]} selectedPersonaId="one" onSelect={() => {}} onChangeProfile={() => {}}
    networkMode="mainnet" onNetworkModeChange={onNetworkModeChange}
  />, staging));
  [...staging.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Testnet")!.click();
  expect(onNetworkModeChange).toHaveBeenCalledWith("testnet");
});

test("the portfolio uses an accessible refresh icon and the existing wallet list for profile selection", async () => {
  const refresh = vi.fn(), select = vi.fn();
  const [loading, setLoading] = createSignal(false);
  const element = document.createElement("div"); document.body.appendChild(element);
  const wallet: PersonaWallet = { personaId: "one", displayName: "Harbor", publicHandle: null, avatarSrc: null,
    address: "0x1111111111111111111111111111111111111111" };
  disposers.push(render(() => <WalletPortfolio wallets={[wallet]} selectedPersonaId="one"
    onSelect={select} onChangeProfile={() => {}} onRefresh={refresh} balancesLoading={loading()} networkMode="testnet" />, element));
  const action = element.querySelector<HTMLButtonElement>('button[aria-label="Refresh balances"]')!;
  expect(action.textContent).toBe(""); expect(action.getAttribute("type")).toBe("button");
  action.click(); expect(refresh).toHaveBeenCalledOnce();
  setLoading(true);
  await vi.waitFor(() => expect(action.disabled).toBe(true));
  expect(action.getAttribute("aria-label")).toBe("Refresh balances"); expect(action.getAttribute("aria-busy")).toBe("true");
  expect(element.textContent).not.toContain("Switch profile");
  expect(element.textContent).not.toContain("Fiat values are unavailable");
  expect(element.textContent).not.toContain("Testnet tokens have no monetary value");
  [...element.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Harbor") && button.closest("li"))!.click();
  expect(select).toHaveBeenCalledWith("one");
});

test("refresh cannot run without a selected receiving address", () => {
  const refresh = vi.fn(), element = document.createElement("div"); document.body.appendChild(element);
  const wallet: PersonaWallet = { personaId: "one", displayName: "Harbor", publicHandle: null, avatarSrc: null, address: null };
  disposers.push(render(() => <WalletPortfolio wallets={[wallet]} selectedPersonaId="one"
    onSelect={() => {}} onChangeProfile={() => {}} onRefresh={refresh} />, element));
  const action = element.querySelector<HTMLButtonElement>('button[aria-label="Refresh balances"]')!;
  expect(action.disabled).toBe(true); action.disabled = false; action.click(); expect(refresh).not.toHaveBeenCalled();
});

test("the actual route hides cached wallets while account authority is pending and after an account change", async () => {
  jsdom.reconfigure({ url: "https://pirate.sc/wallet" });
  const oldWallet: PersonaWallet = { personaId: "profile", displayName: "Old profile", publicHandle: null, avatarSrc: null,
    address: "0x1111111111111111111111111111111111111111" };
  const nextWallet = { ...oldWallet, displayName: "Current profile", address: "0x2222222222222222222222222222222222222222" };
  let finish: (wallets: readonly PersonaWallet[]) => void = () => { throw new Error("new account read not started"); };
  const load = vi.spyOn(portfolioModel, "loadPersonaWallets").mockResolvedValueOnce([oldWallet])
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const read = vi.spyOn(balanceReader, "readWalletBalances").mockImplementation(async (address, mode) => walletAssetSections(address, mode, "25"));
  const [account, setAccount] = createSignal<ApplicationSessionState>({ status: "authenticated", userId: "account-original" });
  const [pending, setPending] = createSignal(false);
  const element = document.createElement("div"); document.body.appendChild(element);
  disposers.push(render(() => <ApplicationSessionProvider state={account} pending={pending}>
    <ApplicationPersonasContext value={{ personas: () => [], selected: () => ({ personaId: "profile", displayName: "Selected profile" }),
      loading: () => false, unavailable: () => false, pickerOpen: () => false, setPickerOpen: () => {}, select: () => {}, retry: () => {} }}>
      <WalletRouteView />
    </ApplicationPersonasContext>
  </ApplicationSessionProvider>, element));
  await vi.waitFor(() => expect(element.textContent).toContain(oldWallet.address));
  expect(element.querySelector('[aria-label="Wallet networks"]')).toBeNull();
  setPending(true); flush();
  expect(element.textContent).not.toContain(oldWallet.address);
  setAccount({ status: "authenticated", userId: "account-current" }); setPending(false); flush();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(element.textContent).not.toContain(oldWallet.address);
  finish([nextWallet]);
  await vi.waitFor(() => expect(element.textContent).toContain(nextWallet.address));
  expect(element.textContent).not.toContain(oldWallet.address);
  expect(read).toHaveBeenCalledWith(nextWallet.address, "mainnet", expect.any(AbortSignal));
});

const STAGING = "https://web-next-staging.pirate.sc";
const PRODUCTION = "https://pirate.sc";
const walletAddress = "0x3333333333333333333333333333333333333333";
const routeWallet: PersonaWallet = { personaId: "profile", displayName: "Profile", publicHandle: null, avatarSrc: null,
  address: walletAddress };
const recipient = "0x4444444444444444444444444444444444444444";
const routeAccount = "account-route";

/** An unclaimed pool winning for the route's persona on one chain. */
function winning(chainId: 8453 | 84532): RewardCredit {
  return {
    object: "reward_credit", credit_id: `credit-${chainId}`, payout_persona_id: routeWallet.personaId, chain_id: chainId,
    token_address: (chainId === 8453 ? BASE_SPONSORED_SEND : BASE_SEPOLIA_SPONSORED_SEND).usdc.toLowerCase(),
    token_decimals: 6, amount_atomic: chainId === 8453 ? "2000000" : "3000000", available_atomic: "0",
    reserved_atomic: "0", paid_atomic: "0", source_kind: "megapot_allocation", state: "credited",
    created_at: "2026-10-24T00:00:00.000Z", updated_at: "2026-10-24T00:00:00.000Z", settled_at: null,
    claim: { status: "unclaimed", payout_status: null }, send: null,
  };
}

/**
 * The actual Wallet route on `url`, served by the deployment named `served`. Only data
 * edges are stubbed: wallets, balances, winnings and the sponsored Send API.
 */
async function openWalletRoute(url: string, served: string | undefined, sendReturn?: Partial<WalletSendDraft>) {
  let path = "/wallet";
  if (sendReturn !== undefined) {
    const key = crypto.randomUUID();
    rememberWalletSend({ accountId: routeAccount, personaId: routeWallet.personaId, walletAddress, recipient,
      amount: "0.5", idempotencyKey: key, sendId: null, ...sendReturn });
    path = `/wallet?send_return=${key}`;
  }
  jsdom.reconfigure({ url: `${url}${path}` });
  if (served !== undefined) document.documentElement.dataset.publicAppCanonicalOrigin = served;
  vi.spyOn(portfolioModel, "loadPersonaWallets").mockResolvedValue([routeWallet]);
  const read = vi.spyOn(balanceReader, "readWalletBalances").mockImplementation(async (address, mode) => walletAssetSections(address, mode, "25"));
  const claims = vi.spyOn(rewardClaim, "createRewardClaimData").mockImplementation(() => ({
    credits: vi.fn(async () => ({ object: "reward_credit_list" as const, items: [winning(8453), winning(84532)], next_cursor: null })),
    claim: vi.fn(async () => { throw new Error("must not claim without a click"); }),
    issueVerificationIntent: vi.fn(async () => "intent"),
  }));
  const tokenBalance = vi.fn(async () => 1_000_000n);
  const data = vi.spyOn(sponsoredSendData, "createWalletSponsoredSendData").mockImplementation((_client, _csrf, network) => ({
    network: network!,
    sender: vi.fn(async () => ({ address: walletAddress, walletIndex: 0 })),
    tokenBalance,
    read: vi.fn(async () => null),
    reserve: vi.fn(async () => { throw new Error("must not reserve without review"); }),
    submit: vi.fn(async () => { throw new Error("must not submit without review"); }),
    issueVerificationIntent: vi.fn(async () => "intent"),
  }));
  const select = vi.fn();
  const element = document.createElement("div"); document.body.appendChild(element);
  disposers.push(render(() => <ApplicationSessionProvider state={() => ({ status: "authenticated", userId: routeAccount })} pending={() => false}>
    <ApplicationPersonasContext value={{ personas: () => [], selected: () => ({ personaId: routeWallet.personaId, displayName: "Profile" }),
      loading: () => false, unavailable: () => false, pickerOpen: () => false, setPickerOpen: () => {}, select, retry: () => {} }}>
      <WalletRouteView />
    </ApplicationPersonasContext>
  </ApplicationSessionProvider>, element));
  await vi.waitFor(() => expect(element.textContent).toContain(walletAddress));
  return { element, data, read, select, claims, tokenBalance };
}

const buttons = (name: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent?.trim() === name);

describe("the Wallet offers Claim and Send on the serving deployment's Base row", () => {
  afterEach(() => { delete document.documentElement.dataset.publicAppCanonicalOrigin; sessionStorage.clear(); });

  test.each([
    ["production", "https://pirate.sc", PRODUCTION, BASE_SPONSORED_SEND, "Base", false],
    ["ordinary staging", "https://web-next-staging.pirate.sc", STAGING, BASE_SEPOLIA_SPONSORED_SEND, "Base Sepolia", true],
    ["staging HNS community app", "https://app.8s28", STAGING, BASE_SEPOLIA_SPONSORED_SEND, "Base Sepolia", true],
    ["staging HNS community app", "https://app.a18n", STAGING, BASE_SEPOLIA_SPONSORED_SEND, "Base Sepolia", true],
  ] as const)("%s at %s shows its winning and Send on the served Base row", async (_kind, url, served, network, row, switchable) => {
    const route = await openWalletRoute(url, served);
    expect(route.element.querySelector('[aria-label="Wallet networks"]') !== null).toBe(switchable);
    expect(route.read).toHaveBeenLastCalledWith(walletAddress, network === BASE_SPONSORED_SEND ? "mainnet" : "testnet", expect.any(AbortSignal));
    // Only the winning on this deployment's chain, under its Base USDC row.
    await vi.waitFor(() => expect(buttons("Verify to claim")).toHaveLength(1));
    const claim = buttons("Verify to claim")[0]!;
    expect(claim.closest("section")?.getAttribute("aria-label")).toBe(row);
    expect(claim.closest("[aria-label='Pool winnings']")?.textContent).toContain(network === BASE_SPONSORED_SEND ? "2 USDC" : "3 USDC");
    // Send opens on the served network and reads that chain's USDC.
    const send = buttons("Send");
    expect(send).toHaveLength(1);
    expect(send[0]!.disabled).toBe(false);
    send[0]!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Wallet balance: 1 USDC"));
    expect(route.data).toHaveBeenCalledWith(undefined, undefined, network);
    expect(route.tokenBalance).toHaveBeenCalledWith(network.usdc, walletAddress);
  });

  test("a page that names no serving deployment offers neither Claim nor Send", async () => {
    const route = await openWalletRoute("https://app.8s28", undefined);
    expect(route.element.querySelector('[aria-label="Wallet networks"]')).toBeNull();
    expect(buttons("Send")).toHaveLength(0);
    expect(buttons("Verify to claim")).toHaveLength(0);
    expect(route.claims).not.toHaveBeenCalled();
    expect(route.data).not.toHaveBeenCalled();
  });
});

describe("a Palm return resumes the saved send where the serving deployment sponsors one", () => {
  afterEach(() => { delete document.documentElement.dataset.publicAppCanonicalOrigin; sessionStorage.clear(); });

  test.each([
    ["production", "https://pirate.sc", PRODUCTION, BASE_SPONSORED_SEND, "mainnet"],
    ["ordinary staging", "https://web-next-staging.pirate.sc", STAGING, BASE_SEPOLIA_SPONSORED_SEND, "testnet"],
    ["staging HNS community app", "https://app.8s28", STAGING, BASE_SEPOLIA_SPONSORED_SEND, "testnet"],
    ["staging HNS community app", "https://app.a18n", STAGING, BASE_SEPOLIA_SPONSORED_SEND, "testnet"],
  ] as const)("%s at %s resumes the saved form for review on the served network", async (_kind, url, served, network, mode) => {
    const route = await openWalletRoute(url, served, {});
    await vi.waitFor(() => expect(document.body.textContent).toContain("Wallet balance: 1 USDC"));
    expect(route.data).toHaveBeenCalledWith(undefined, undefined, network);
    expect(route.select).toHaveBeenCalledWith(routeWallet.personaId);
    expect(route.read).toHaveBeenLastCalledWith(walletAddress, mode, expect.any(AbortSignal));
    // The saved recipient and amount are back in the form, to be reviewed before any signing.
    const inputs = [...document.body.querySelectorAll("input")].map(input => input.value);
    expect(inputs).toEqual(expect.arrayContaining([recipient, "0.5"]));
    expect(document.body.textContent).not.toContain("could not be resumed");
  });

  test("a page that names no serving deployment resumes nothing", async () => {
    const route = await openWalletRoute("https://app.8s28", undefined, {});
    expect(route.data).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Wallet balance");
  });

  test("a draft saved by another account or for another wallet is not resumed", async () => {
    for (const draft of [{ accountId: "account-other" }, { walletAddress: "0x5555555555555555555555555555555555555555" }]) {
      const route = await openWalletRoute("https://pirate.sc", PRODUCTION, draft);
      await vi.waitFor(() => expect(route.element.textContent).toContain("Your saved send could not be resumed."));
      expect(route.data).not.toHaveBeenCalled();
      disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks();
    }
  });
});
