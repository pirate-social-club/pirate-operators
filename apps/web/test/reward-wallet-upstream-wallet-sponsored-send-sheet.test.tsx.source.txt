import { createSignal, flush } from "solid-js";
import { render } from "@solidjs/web";
import { afterEach, expect, test, vi } from "vitest";
import { ApiClientError, ApiClientProtocolError, ApiClientResponseValidationError } from "@pirate/api-client";
import { readWalletSend, type WalletSendDraft } from "./wallet-send-continuation.ts";
import type { WalletSponsoredSendRecord } from "../../api/wallet-sponsored-send.ts";
import { BASE_SEPOLIA_SPONSORED_SEND, BASE_SPONSORED_SEND, type SponsoredSendNetwork } from "../../api/sponsored-send-network.ts";
import { browserWalletSponsoredSend, WalletSponsoredSendSheet, type WalletSponsoredSendDependencies } from "./wallet-sponsored-send-sheet.tsx";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); sessionStorage.clear();
  delete document.documentElement.dataset.publicAppCanonicalOrigin; vi.unstubAllGlobals();
});
const sender = "0x1111111111111111111111111111111111111111";
const recipient = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const token = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const reserved: WalletSponsoredSendRecord = {
  object: "wallet_sponsored_send", send_id: "wallet_send_1", persona_id: "persona_1",
  status: "reserved", chain_id: 84532, token_address: token, sender_address: sender,
  recipient_address: recipient, amount_atomic: "1000000", transaction_hash: null,
  verification_required: false,
  authorization: { wallet_id: "wallet_1", payload_base64: "cGF5bG9hZA==" },
};

function fixture(options: { reserveFails?: boolean; submitFails?: boolean; changed?: boolean; network?: SponsoredSendNetwork; recordedChain?: 8453 | 84532 } = {}) {
  let current: WalletSponsoredSendRecord | null = null;
  const network = options.network ?? BASE_SEPOLIA_SPONSORED_SEND;
  const wallet = {
    restoreAuthorization: vi.fn(async () => true),
    signSponsoredRequest: vi.fn(async () => "c2lnbmF0dXJl"),
    dispose: vi.fn(),
  };
  const data: WalletSponsoredSendDependencies["data"] = {
    network,
    sender: vi.fn(async () => ({ address: sender, walletIndex: 2 })),
    tokenBalance: vi.fn(async () => 1_000_000n),
    read: vi.fn(async () => current !== null && options.changed
      ? { ...current, recipient_address: "0x2222222222222222222222222222222222222222" }
      : current),
    reserve: vi.fn(async (_personaId, to, amount) => {
      current = {
        ...reserved, recipient_address: to.toLowerCase(), amount_atomic: amount,
        chain_id: options.recordedChain ?? network.chainId, token_address: network.usdc.toLowerCase(),
      };
      if (options.reserveFails) throw new Error("response_lost");
      return current;
    }),
    submit: vi.fn(async () => {
      current = { ...current!, status: "held", authorization: null };
      if (options.submitFails) throw new Error("response_lost");
      return current;
    }),
    issueVerificationIntent: vi.fn(async () => "wallet-send_intent"),
  };
  const dependencies: WalletSponsoredSendDependencies = { data, openWallet: vi.fn(async () => wallet) };
  return { dependencies, data, wallet };
}

function mount(dependencies: WalletSponsoredSendDependencies, onConfirmed = vi.fn(), onClose = vi.fn(), resumeDraft?: WalletSendDraft) {
  const element = document.createElement("div"); document.body.appendChild(element);
  const unmount = render(() => <WalletSponsoredSendSheet accountId="account_1" personaId="persona_1" walletAddress={sender} dependencies={dependencies} onClose={onClose} onConfirmed={onConfirmed} resumeDraft={resumeDraft} />, element);
  disposers.push(unmount);
  return unmount;
}
const text = () => document.body.textContent ?? "";
const button = (name: string) => {
  const found = [...document.body.querySelectorAll("button")].find(item => item.textContent?.trim() === name);
  if (found === undefined) throw new Error(`No button ${name}: ${text()}`);
  return found;
};
async function type(label: string, value: string) {
  const labelled = [...document.body.querySelectorAll("label")].find(item => item.textContent === label);
  const input = labelled?.htmlFor ? document.getElementById(labelled.htmlFor) : labelled?.parentElement?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`No input ${label}`);
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
}
async function review() {
  await vi.waitFor(() => expect(text()).toContain("Wallet balance: 1 USDC"));
  await type("Send to", recipient);
  button("Continue").click();
  await vi.waitFor(() => expect(text()).toContain("Covered by Pirate"));
}

test("an ordinary persona wallet reserves before signing without any reward credit", async () => {
  const f = fixture(); mount(f.dependencies); await review();
  expect(text()).toContain("NetworkBase Sepolia");
  button("Authorize send").click();
  await vi.waitFor(() => expect(f.data.submit).toHaveBeenCalledOnce());
  expect(f.data.reserve).toHaveBeenCalledWith("persona_1", expect.any(String), "1000000", expect.any(String));
  expect(f.wallet.signSponsoredRequest).toHaveBeenCalledWith(
    expect.objectContaining({ sender, amountAtomic: "1000000", walletIndex: 2 }),
    "wallet_1", "cGF5bG9hZA==",
  );
});

const STAGING = "https://web-next-staging.pirate.sc";
const PRODUCTION = "https://pirate.sc";
test.each([
  ["ordinary staging", "web-next-staging.pirate.sc", STAGING, BASE_SEPOLIA_SPONSORED_SEND],
  ["staging HNS community app", "app.8s28", STAGING, BASE_SEPOLIA_SPONSORED_SEND],
  ["staging HNS handle host", "membertest.8s28", STAGING, BASE_SEPOLIA_SPONSORED_SEND],
  ["staging HNS community app", "app.a18n", STAGING, BASE_SEPOLIA_SPONSORED_SEND],
  ["ordinary production", "pirate.sc", PRODUCTION, BASE_SPONSORED_SEND],
  ["production HNS host", "app.examplehns", PRODUCTION, BASE_SPONSORED_SEND],
  ["local development", "localhost", "http://127.0.0.1:8787", BASE_SEPOLIA_SPONSORED_SEND],
] as const)("%s host %s sends on its served deployment's network", (_kind, host, served, network) => {
  vi.stubGlobal("location", new URL(`https://${host}/wallet`));
  document.documentElement.dataset.publicAppCanonicalOrigin = served;
  expect(browserWalletSponsoredSend()?.data.network).toBe(network);
});

test("a page that names no deployment offers no Send and reads nothing", async () => {
  vi.stubGlobal("location", new URL("https://app.8s28/wallet"));
  expect(browserWalletSponsoredSend()).toBeUndefined();
  const element = document.createElement("div"); document.body.appendChild(element);
  disposers.push(render(() => <WalletSponsoredSendSheet accountId="account_1" personaId="persona_1" walletAddress={sender} onClose={vi.fn()} />, element));
  await vi.waitFor(() => expect(text()).toContain("Send is not available here."));
  expect(text()).not.toContain("Wallet balance");
});

test("production sends Base USDC on Base and labels it Base", async () => {
  const f = fixture({ network: BASE_SPONSORED_SEND }); mount(f.dependencies); await review();
  expect(text()).toContain("NetworkBase");
  expect(text()).not.toContain("Base Sepolia");
  expect(f.data.tokenBalance).toHaveBeenCalledWith(BASE_SPONSORED_SEND.usdc, sender);
  button("Authorize send").click();
  await vi.waitFor(() => expect(f.data.submit).toHaveBeenCalledOnce());
  expect(f.wallet.signSponsoredRequest).toHaveBeenCalledWith(
    expect.objectContaining({ token: BASE_SPONSORED_SEND.usdc, chainId: 8453 }),
    "wallet_1", "cGF5bG9hZA==",
  );
});

test("a send recorded on another chain than the host's is never signed", async () => {
  const f = fixture({ network: BASE_SPONSORED_SEND, recordedChain: 84532 }); mount(f.dependencies); await review();
  button("Authorize send").click();
  await vi.waitFor(() => expect(text()).toContain("Nothing was signed"));
  expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled();
});

test("lost reservation response signs nothing", async () => {
  const f = fixture({ reserveFails: true }); mount(f.dependencies); await review();
  button("Authorize send").click();
  await vi.waitFor(() => expect(text()).toContain("Nothing was signed"));
  expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled();
  expect(f.data.submit).not.toHaveBeenCalled();
});

test("uncertain submission cannot be signed again after reopening", async () => {
  const f = fixture({ submitFails: true }); mount(f.dependencies); await review();
  button("Authorize send").click();
  await vi.waitFor(() => expect(text()).toContain("may have reached the network"));
  disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren();
  mount(f.dependencies);
  await vi.waitFor(() => expect(text()).toContain("network is checking this send"));
  expect(text()).not.toContain("Authorize recorded send");
  expect(f.wallet.signSponsoredRequest).toHaveBeenCalledTimes(1);
  expect(f.data.submit).toHaveBeenCalledTimes(1);
});

test("changed server record never reaches wallet signing", async () => {
  const f = fixture({ changed: true }); mount(f.dependencies); await review();
  button("Authorize send").click();
  await vi.waitFor(() => expect(text()).toContain("recorded send changed"));
  expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled();
  expect(f.data.submit).not.toHaveBeenCalled();
});

const palmRequired = () => new ApiClientError(
  { status: 403, code: "verification_required", name: "VerificationRequired", retryable: false },
  { error: { code: "verification_required", message: "Verify", retryable: false, details: { purpose: "wallet_send", persona_id: "persona_1", provider_id: "very.web" } } },
);

test("Palm refusal preserves the form and same idempotency key through a tab-private return", async () => {
  const f = fixture(); const navigate = vi.fn();
  vi.mocked(f.data.reserve).mockRejectedValueOnce(palmRequired());
  mount({ ...f.dependencies, navigate }); await review(); button("Authorize send").click();
  await vi.waitFor(() => expect(text()).toContain("Verify your palm"));
  expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled(); expect(f.data.submit).not.toHaveBeenCalled();
  button("Verify palm").click();
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  const target = new URL(navigate.mock.calls[0][0], location.origin);
  expect(target.searchParams.get("purpose")).toBe("wallet_send");
  expect(target.searchParams.get("persona_id")).toBe("persona_1");
  const key = new URL(target.searchParams.get("return_to")!, location.origin).searchParams.get("send_return")!;
  const draft = readWalletSend(key, "account_1")!;
  expect(draft).toMatchObject({ personaId: "persona_1", amount: "1", idempotencyKey: vi.mocked(f.data.reserve).mock.calls[0][3], sendId: null });
  disposers.splice(0).forEach(dispose => dispose()); document.body.replaceChildren();
  mount(f.dependencies, vi.fn(), vi.fn(), draft);
  await vi.waitFor(() => expect(text()).toContain("Wallet balance: 1 USDC"));
  expect(f.data.reserve).toHaveBeenCalledOnce(); expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled();
  button("Continue").click(); await vi.waitFor(() => expect(text()).toContain("Covered by Pirate"));
  button("Authorize send").click(); await vi.waitFor(() => expect(f.data.submit).toHaveBeenCalledOnce());
  expect(vi.mocked(f.data.reserve).mock.calls[1][3]).toBe(key);
});

test("revoked evidence on a fresh read prompts verification without signing an existing reservation", async () => {
  const f = fixture();
  vi.mocked(f.data.read).mockResolvedValue({ ...reserved, verification_required: true, authorization: null });
  mount(f.dependencies);
  await vi.waitFor(() => expect(text()).toContain("Verify your palm"));
  expect(f.data.reserve).not.toHaveBeenCalled(); expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled();
});

test("Palm expiry between reservation and authorization never reaches signing", async () => {
  const f = fixture();
  vi.mocked(f.data.read).mockResolvedValueOnce(null).mockResolvedValue({ ...reserved, verification_required: true, authorization: null });
  mount(f.dependencies); await review(); button("Authorize send").click();
  await vi.waitFor(() => expect(text()).toContain("Verify your palm"));
  expect(f.data.reserve).toHaveBeenCalledOnce(); expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled();
});

test("an incompatible response offers reload without a signing or submission retry", async () => {
  const f = fixture(); const reload = vi.fn();
  vi.mocked(f.data.reserve).mockRejectedValue(new ApiClientResponseValidationError("reserve", 200, "$.verification_required"));
  mount({ ...f.dependencies, reload }); await review(); button("Authorize send").click();
  await vi.waitFor(() => expect(text()).toContain("Reload the page"));
  button("Reload wallet").click(); expect(reload).toHaveBeenCalledOnce();
  expect(f.data.reserve).toHaveBeenCalledOnce(); expect(f.data.submit).not.toHaveBeenCalled(); expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled();
});

test("unknown404 history keeps the flow unavailable rather than showing a new Send form", async () => {
  const f = fixture(); vi.mocked(f.data.read).mockRejectedValue(new ApiClientProtocolError("Malformed history", 404));
  mount(f.dependencies);
  await vi.waitFor(() => expect(text()).toContain("send record could not be loaded"));
  expect(document.body.querySelector("input")).toBeNull();
  expect(f.data.reserve).not.toHaveBeenCalled(); expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled();
});

test("a return to a different recorded send cannot authorize it", async () => {
  const f = fixture();
  vi.mocked(f.data.read).mockResolvedValue(reserved);
  mount(f.dependencies, vi.fn(), vi.fn(), { accountId: "account_1", personaId: "persona_1", walletAddress: sender,
    recipient, amount: "1", idempotencyKey: crypto.randomUUID(), sendId: "another_send" });
  await vi.waitFor(() => expect(text()).toContain("recorded send changed"));
  expect(button("Authorize recorded send").disabled).toBe(true);
  expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled(); expect(f.data.reserve).not.toHaveBeenCalled();
});

test("an account change during wallet restoration closes signing authority", async () => {
  const f = fixture();
  let restored: (value: boolean) => void = () => { throw new Error("restoration not started"); };
  vi.mocked(f.wallet.restoreAuthorization).mockImplementationOnce(() => new Promise(resolve => { restored = resolve; }));
  const [accountId, setAccountId] = createSignal("account_1");
  const element = document.createElement("div"); document.body.appendChild(element);
  disposers.push(render(() => <WalletSponsoredSendSheet accountId={accountId()} personaId="persona_1" walletAddress={sender} dependencies={f.dependencies} onClose={vi.fn()} />, element));
  await vi.waitFor(() => expect(text()).toContain("Wallet balance: 1 USDC"));
  await type("Send to", recipient); button("Continue").click();
  await vi.waitFor(() => expect(f.wallet.restoreAuthorization).toHaveBeenCalledOnce());
  setAccountId("account_2"); flush(); restored(true);
  await vi.waitFor(() => expect(text()).toContain("account or wallet changed"));
  expect(f.wallet.dispose).toHaveBeenCalledOnce(); expect(f.data.reserve).not.toHaveBeenCalled();
  expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled(); expect(f.data.submit).not.toHaveBeenCalled();
});

test("a pre-effect Palm refusal during submission returns to the same recorded send", async () => {
  const f = fixture();
  vi.mocked(f.data.read).mockResolvedValueOnce(null).mockResolvedValueOnce(reserved)
    .mockResolvedValue({ ...reserved, verification_required: true, authorization: null });
  vi.mocked(f.data.submit).mockRejectedValueOnce(palmRequired());
  const navigate = vi.fn(); mount({ ...f.dependencies, navigate }); await review(); button("Authorize send").click();
  await vi.waitFor(() => expect(text()).toContain("Verify your palm"));
  expect(f.wallet.signSponsoredRequest).toHaveBeenCalledOnce(); expect(f.data.submit).toHaveBeenCalledOnce();
  button("Verify palm").click(); await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  const href = new URL(navigate.mock.calls[0][0], location.origin);
  const key = new URL(href.searchParams.get("return_to")!, location.origin).searchParams.get("send_return")!;
  expect(readWalletSend(key, "account_1")?.sendId).toBe(reserved.send_id);
  expect(f.data.reserve).toHaveBeenCalledOnce();
});

test("only a server-confirmed matching send notifies the parent, once per send", async () => {
  const f = fixture(), onConfirmed = vi.fn(), onClose = vi.fn();
  let current: WalletSponsoredSendRecord = { ...reserved, status: "held", authorization: null };
  vi.mocked(f.data.read).mockImplementation(async () => current);
  mount(f.dependencies, onConfirmed, onClose);
  await vi.waitFor(() => expect(text()).toContain("network is checking this send"));
  expect(onConfirmed).not.toHaveBeenCalled();
  current = { ...current, status: "confirmed", transaction_hash: `0x${"a".repeat(64)}` };
  button("Refresh status").click();
  await vi.waitFor(() => expect(onConfirmed).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(button("Refresh status").disabled).toBe(false));
  let finishRefresh: (record: WalletSponsoredSendRecord) => void = () => { throw new Error("refresh did not start"); };
  vi.mocked(f.data.read).mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
  button("Refresh status").click(); flush();
  expect(button("Refresh status").disabled).toBe(true);
  button("Close").click();
  expect(onClose).not.toHaveBeenCalled();
  finishRefresh(current);
  await vi.waitFor(() => expect(button("Refresh status").disabled).toBe(false));
  button("Close").click();
  expect(onClose).toHaveBeenCalledOnce(); expect(onConfirmed).toHaveBeenCalledOnce();
  expect(f.wallet.signSponsoredRequest).not.toHaveBeenCalled(); expect(f.data.reserve).not.toHaveBeenCalled();
});

test("closing an uncertain send is not confirmation", async () => {
  const f = fixture(), onConfirmed = vi.fn(), onClose = vi.fn();
  vi.mocked(f.data.read).mockResolvedValue({ ...reserved, status: "held", authorization: null });
  mount(f.dependencies, onConfirmed, onClose);
  await vi.waitFor(() => expect(text()).toContain("network is checking this send"));
  button("Close").click();
  expect(onClose).toHaveBeenCalledOnce(); expect(onConfirmed).not.toHaveBeenCalled();
});

test.each(["profile", "address"] as const)("a server result for another %s cannot notify this wallet", async field => {
  const f = fixture(), onConfirmed = vi.fn();
  vi.mocked(f.data.read).mockResolvedValue({ ...reserved, status: "confirmed", authorization: null,
    ...(field === "profile" ? { persona_id: "another-profile" } : { sender_address: recipient }) });
  mount(f.dependencies, onConfirmed);
  await vi.waitFor(() => expect(text()).toContain("This send is confirmed"));
  expect(onConfirmed).not.toHaveBeenCalled();
});

test("a late confirmed read after disposal cannot refresh the parent", async () => {
  const f = fixture(), onConfirmed = vi.fn();
  let finish: (value: WalletSponsoredSendRecord) => void = () => { throw new Error("read not started"); };
  vi.mocked(f.data.read).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const unmount = mount(f.dependencies, onConfirmed);
  await vi.waitFor(() => expect(f.data.read).toHaveBeenCalledOnce());
  unmount(); finish({ ...reserved, status: "confirmed", authorization: null });
  await Promise.resolve(); await Promise.resolve();
  expect(onConfirmed).not.toHaveBeenCalled();
});
