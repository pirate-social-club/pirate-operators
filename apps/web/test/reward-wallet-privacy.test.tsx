// UNRUN. Actual controller, page compositions and HTTP client; deferred native Response.json.
import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { LiveRewardWallet } from "../src/live/rewards.tsx";
import { useRewardWalletController } from "../src/wallet/use-reward-wallet.ts";
const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const token = "0x" + "33".repeat(20);
const address = "0x" + "11".repeat(20);
const wallet = (accountId = a) => ({
  schema: "pirate.learner-wallet/1",
  accountId,
  address,
  chainId: 6343,
  token,
  decimals: 18,
  balanceAtomic: "30000000000000000",
  operator: false,
  practiceOnly: true,
  drawings: [],
});
const credit = (account_id = a, credit_id = "credit_0001") => ({
  credit_id,
  account_id,
  offer_id: "offer_0001",
  chain_id: 6343,
  token_address: token,
  token_decimals: 18,
  amount_atomic: "30000000000000000",
  paid_atomic: "0",
  payment_id: null,
  claim: { status: "unclaimed", payout_status: "awaiting_payment" },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  history.replaceState(null, "", "/wallet");
});
function http() {
  let deny = 0,
    bodyReads = 0,
    pollReads = 0,
    deferredPoll = false;
  let heldWallet: ReturnType<typeof deferred<unknown>> | undefined;
  let heldPage: ReturnType<typeof deferred<unknown>> | undefined;
  let pageOwner = a,
    pageRows = [credit()];
  const body = deferred<unknown>(),
    poll = deferred<unknown>();
  const original = {
    intent_id: "intent_0001",
    state: "pending",
    expires_at: Date.now() + 300000,
    launch_url: null,
  };
  const originalBytes = JSON.stringify(original);
  const requests: { path: string; method: string }[] = [];
  const readSignals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), location.origin).pathname;
      const method = init?.method ?? "GET";
      requests.push({ path, method });
      const headers = new Headers(init?.headers);
      expect(headers.get("x-csrf-token")).toBe("session-a");
      if (method === "GET") {
        expect(init?.signal).toBeDefined();
        readSignals.push(init!.signal!);
      }
      if (deny) {
        const response = new Response(null, { status: deny });
        response.json = () => {
          bodyReads++;
          return body.promise;
        };
        return response;
      }
      if (path === "/api/rewards/wallet") {
        if (heldWallet) {
          const response = new Response();
          response.json = () => heldWallet!.promise;
          return response;
        }
        return Response.json(wallet());
      }
      if (path === "/api/rewards/credits") {
        expect(headers.get("x-pirate-reward-owner")).toBe(a);
        if (heldPage) {
          const response = new Response();
          response.json = () => heldPage!.promise;
          return response;
        }
        return Response.json({
          object: "reward_credit_list",
          accountId: pageOwner,
          items: pageRows,
          next_cursor: null,
        });
      }
      if (path === "/api/rewards/claim-verification-intents")
        return Response.json(original);
      if (path === "/api/rewards/verification-intents/intent_0001/complete") {
        pollReads++;
        if (deferredPoll) {
          const response = new Response();
          response.json = () => poll.promise;
          return response;
        }
        return Response.json(original);
      }
      throw Error("Unexpected request: " + method + " " + path);
    }),
  );
  return {
    requests,
    readSignals,
    original,
    originalBytes,
    deny(status: number) {
      deny = status;
    },
    resume() {
      deny = 0;
    },
    reads: () => bodyReads,
    pollReads: () => pollReads,
    holdPoll() {
      deferredPoll = true;
    },
    releasePoll() {
      poll.resolve({ ...original, state: "verified" });
    },
    releaseErrorBody() {
      body.resolve({ error: "session_required" });
    },
    holdWallet() {
      heldWallet = deferred<unknown>();
    },
    releaseWallet() {
      heldWallet!.resolve(wallet());
    },
    holdPage() {
      heldPage = deferred<unknown>();
    },
    releasePage() {
      heldPage!.resolve({
        object: "reward_credit_list",
        accountId: a,
        items: [credit()],
        next_cursor: null,
      });
    },
    foreignRows() {
      pageRows = [credit(b, "credit_b002")];
    },
    foreignEnvelope() {
      pageOwner = b;
      pageRows = [credit(b, "credit_b002")];
    },
  };
}
function mount(page = false) {
  const host = document.createElement("div");
  document.body.append(host);
  let controller!: ReturnType<typeof useRewardWalletController>;
  const [session, setSession] = createSignal<string | null>("session-a");
  const csrf = () => session() ?? "";
  function Controller() {
    controller = useRewardWalletController({
      get csrf() {
        return csrf();
      },
      onExit() {},
    });
    return <output>{controller.view()?.balanceAtomic ?? "masked"}</output>;
  }
  const dispose = render(
    () =>
      page ? (
        <LiveRewardWallet csrf={csrf()} onExit={() => {}} />
      ) : (
        <Controller />
      ),
    host,
  );
  disposers.push(dispose);
  return {
    host,
    controller: () => controller,
    replace: () => setSession("session-b"),
    // Actual nullable test session; props retain their existing string CSRF contract.
    setSession,
    dispose,
  };
}
const waitReady = async (x: ReturnType<typeof mount>) => {
  await vi.waitFor(() =>
    expect(x.controller().view()?.balanceAtomic).toBe("30000000000000000"),
  );
};
for (const status of [401, 403]) {
  test(`actual portfolio masks amounts, winnings and action portals at ${status} headers`, async () => {
    const f = http(),
      x = mount(true);
    await vi.waitFor(() => expect(x.host.textContent).toContain("0.03"));
    const receive = [...x.host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Receive",
    )!;
    receive.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
    );
    f.deny(status);
    const refresh = x.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh balances"]',
    )!;
    expect(refresh).not.toBeNull();
    refresh.click();
    await vi.waitFor(() => expect(x.host.textContent).not.toContain("0.03"));
    expect(f.reads()).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(x.host.textContent).not.toContain(address);
    expect(x.host.querySelector('a[href="/wallet"]')?.textContent).toBe(
      "Sign in again",
    );
    expect(
      [...x.host.querySelectorAll("button")].some((button) =>
        /Send|Receive|Verify to claim|Try again/.test(button.textContent ?? ""),
      ),
    ).toBe(false);
    f.releaseErrorBody();
    await Promise.resolve();
    expect(x.host.textContent).not.toContain("0.03");
    expect(
      f.requests.some((r) => /\/claim$|\/sends|dispatch|outcome/.test(r.path)),
    ).toBe(false);
  });
  test(`actual controller ${status} invalidates a held verification body and its scheduled timer`, async () => {
    const f = http(),
      x = mount();
    await waitReady(x);
    vi.useFakeTimers();
    await x.controller().verify("credit_0001");
    expect(x.controller().intent()?.intent_id).toBe("intent_0001");
    f.holdPoll();
    const pending = x.controller().resumeVerification();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.pollReads()).toBe(2);
    f.deny(status);
    await expect(x.controller().refresh()).rejects.toMatchObject({ status });
    expect(f.reads()).toBe(0);
    expect(x.controller().view()).toBeNull();
    expect(x.controller().credits()).toEqual([]);
    expect(x.controller().intent()).toBeNull();
    expect(x.controller().qr()).toBe("");
    expect(x.controller().busy()).toBe(false);
    f.releasePoll();
    await pending;
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.pollReads()).toBe(2);
    expect(x.controller().intent()).toBeNull();
    expect(JSON.stringify(f.original)).toBe(f.originalBytes);
    expect(
      f.requests.some((r) => /\/claim$|\/sends|dispatch|outcome/.test(r.path)),
    ).toBe(false);
  });
}

for (const transition of ["replacement", "disposal"] as const) {
  for (const body of ["wallet", "credits"] as const) {
    test(`late ${body} body after ${transition} cannot publish original private values`, async () => {
      const f = http(),
        x = mount();
      await waitReady(x);
      if (body === "wallet") f.holdWallet();
      else f.holdPage();
      const pending = x.controller().run(x.controller().refresh);
      await vi.waitFor(() =>
        expect(
          f.requests.filter((r) => r.path === "/api/rewards/" + body),
        ).toHaveLength(2),
      );
      if (transition === "replacement") x.replace();
      else x.dispose();
      if (body === "wallet") f.releaseWallet();
      else f.releasePage();
      await pending;
      expect(x.controller().view()).toBeNull();
      expect(x.controller().credits()).toEqual([]);
      expect(x.controller().intent()).toBeNull();
      expect(x.controller().qr()).toBe("");
      expect(f.requests.some((r) => /\/claim$|dispatch/.test(r.path))).toBe(
        false,
      );
    });
  }
}
test("foreign rows and envelopes cannot replace the current private projection", async () => {
  const f = http(),
    x = mount();
  await waitReady(x);
  f.foreignRows();
  await x.controller().run(x.controller().refresh);
  expect(x.controller().view()).toBeNull();
  expect(x.controller().credits()).toEqual([]);
  expect(x.controller().authorityLost()).toBe(true);
});
test("temporary 503 retains the same projection and explicit retry can recover without a claim", async () => {
  const f = http(),
    x = mount();
  await waitReady(x);
  f.deny(503);
  f.releaseErrorBody();
  await x.controller().run(x.controller().refresh);
  expect(x.controller().view()?.balanceAtomic).toBe("30000000000000000");
  expect(x.controller().authorityLost()).toBe(false);
  f.resume();
  await x.controller().run(x.controller().refresh);
  expect(x.controller().credits()).toHaveLength(1);
  expect(x.controller().notice()).toBe("");
  expect(f.requests.some((r) => r.method === "POST")).toBe(false);
});

function expectPermanentlyMasked(x: ReturnType<typeof mount>) {
  const controller = x.controller();
  expect(controller.authorityLost()).toBe(true);
  expect(controller.view()).toBeNull();
  expect(controller.credits()).toEqual([]);
  expect(controller.summary()).toBeNull();
  expect(controller.intent()).toBeNull();
  expect(controller.qr()).toBe("");
  expect(controller.busy()).toBe(false);
  expect(controller.creditFromUrl()).toBeNull();
}

for (const intermediate of ["session-b", null] as const) {
  const label =
    intermediate === null ? "A to missing session to A" : "A to B to A";
  for (const body of ["wallet", "credits"] as const) {
    test(`${label} latches loss and aborts a held ${body} read before the old body returns`, async () => {
      const f = http(),
        x = mount();
      await waitReady(x);
      const originalController = x.controller();
      if (body === "wallet") f.holdWallet();
      else f.holdPage();
      const pending = originalController.run(originalController.refresh);
      await vi.waitFor(() =>
        expect(
          f.requests.filter((r) => r.path === "/api/rewards/" + body),
        ).toHaveLength(2),
      );
      const read = f.readSignals.at(-1)!;
      expect(read.aborted).toBe(false);
      const requests = [...f.requests];
      x.setSession(intermediate);
      flush(); // Actual pinned Solid 2 compute/apply queues observe scope loss.
      expect(read.aborted).toBe(true); // Proves invalidation ran, beyond a derived B-only mask.
      x.setSession("session-a");
      flush();
      expect(x.controller()).toBe(originalController);
      expectPermanentlyMasked(x);
      if (body === "wallet") f.releaseWallet();
      else f.releasePage();
      await pending;
      await originalController.run(originalController.refresh);
      await originalController.refresh();
      await originalController.resumeVerification();
      await expect(
        originalController.claimFromRow("credit_0001"),
      ).rejects.toThrow("account or wallet changed");
      expectPermanentlyMasked(x);
      expect(f.requests).toEqual(requests);
      expect(JSON.stringify(f.original)).toBe(f.originalBytes);
      expect(f.requests.some((r) => r.method === "POST")).toBe(false);
    });
  }
  for (const phase of ["scheduled", "held"] as const) {
    test(`${label} cancels ${phase} verification permanently without claim or dispatch`, async () => {
      const f = http(),
        x = mount();
      await waitReady(x);
      vi.useFakeTimers();
      const originalController = x.controller();
      await originalController.verify("credit_0001");
      expect(originalController.intent()?.intent_id).toBe("intent_0001");
      let pending: Promise<void> | undefined;
      if (phase === "held") {
        f.holdPoll();
        pending = originalController.resumeVerification();
        await Promise.resolve();
        await Promise.resolve();
        expect(f.pollReads()).toBe(2);
      } else expect(f.pollReads()).toBe(1);
      const requests = [...f.requests],
        polls = f.pollReads();
      x.setSession(intermediate);
      flush();
      x.setSession("session-a");
      flush();
      expect(x.controller()).toBe(originalController);
      expectPermanentlyMasked(x);
      if (pending) {
        f.releasePoll();
        await pending;
      }
      await vi.advanceTimersByTimeAsync(15000);
      await originalController.resumeVerification();
      await originalController.run(originalController.refresh);
      expectPermanentlyMasked(x);
      expect(f.pollReads()).toBe(polls);
      expect(f.requests).toEqual(requests);
      expect(JSON.stringify(f.original)).toBe(f.originalBytes);
      expect(
        f.requests.some((r) =>
          /\/claim$|\/sends|dispatch|outcome|payments/.test(r.path),
        ),
      ).toBe(false);
      expect(location.pathname).toBe("/wallet");
      expect(location.search).toBe("");
    });
  }
  test(`${label} keeps the mounted page private until a fresh controller performs reads only`, async () => {
    const f = http(),
      x = mount(true);
    await vi.waitFor(() => expect(x.host.textContent).toContain("0.03"));
    const requests = [...f.requests];
    x.setSession(intermediate);
    flush();
    x.setSession("session-a");
    flush();
    await vi.waitFor(() => expect(x.host.textContent).not.toContain("0.03"));
    expect(x.host.querySelector('a[href="/wallet"]')?.textContent).toBe(
      "Sign in again",
    );
    expect(
      [...x.host.querySelectorAll("button")].some((button) =>
        /Send|Receive|Verify to claim|Try again/.test(button.textContent ?? ""),
      ),
    ).toBe(false);
    expect(f.requests).toEqual(requests);
    x.dispose();
    const fresh = mount(true);
    await vi.waitFor(() => expect(fresh.host.textContent).toContain("0.03"));
    expect(f.requests.slice(requests.length)).toEqual([
      { path: "/api/rewards/wallet", method: "GET" },
      { path: "/api/rewards/credits", method: "GET" },
    ]);
    expect(f.requests.some((r) => r.method === "POST")).toBe(false);
    expect(JSON.stringify(f.original)).toBe(f.originalBytes);
  });
}
