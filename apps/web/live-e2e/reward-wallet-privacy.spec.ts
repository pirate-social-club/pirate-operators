// UNRUN. Actual built App + established wallet + native Response/QR/timers.
// Strict HTTP protocol fixture paired with test/v1-wallet-private-owner.test.ts producer proof.
// No real session, provider, verification, wallet approval or financial acceptance.
import { expect, test, type Page } from "@playwright/test";
import { accounts, origin, serveAccounts } from "./account-fixture.ts";
declare global {
  interface Window {
    __walletPrivacy: {
      status: number;
      pollOnly: boolean;
      headers: number;
      jsonReads: number;
      holdPage: boolean;
      heldPages: number;
      release(): void;
    };
  }
}
async function fixture(page: Page) {
  const app = await serveAccounts(page);
  app.signedInAs("first");
  await page.route(`${origin}/api/capabilities`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schema: "pirate.community-capabilities/1",
        signIn: true,
        creatorConnection: false,
        upload: false,
        publication: false,
        learningServiceMode: "internal",
        study: true,
        rewards: true,
        policyVersion: "fixture",
      }),
    }),
  );
  let owner: "first" | "second" = "first",
    split = false,
    refused = 0;
  const posts: string[] = [],
    pages: string[] = [];
  const token = "0x" + "33".repeat(20);
  const original = {
    intent_id: "intent_0001",
    state: "pending",
    expires_at: Date.now() + 300000,
    launch_url: "veros://verify?sessionId=fixture-original",
  };
  const originalBytes = JSON.stringify(original);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let release!: () => void;
    const held = new Promise<void>((yes) => {
      release = yes;
    });
    const control = {
      status: 0,
      pollOnly: false,
      headers: 0,
      jsonReads: 0,
      holdPage: false,
      heldPages: 0,
      release,
    };
    window.__walletPrivacy = control;
    window.fetch = async (input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      ).pathname;
      if (
        control.status &&
        (control.pollOnly
          ? path.endsWith("/intent_0001/complete")
          : path === "/api/rewards/wallet")
      ) {
        control.headers++;
        const response = new Response(null, { status: control.status });
        response.json = async () => {
          control.jsonReads++;
          await held;
          return { error: "session_required" };
        };
        return response;
      }
      const response = await originalFetch(input, init);
      if (control.holdPage && path === "/api/rewards/credits") {
        control.holdPage = false;
        const decode = response.json.bind(response);
        response.json = async () => {
          const value = await decode();
          control.heldPages++;
          await held;
          return value;
        };
      }
      return response;
    };
  });
  await page.route(`${origin}/api/rewards/**`, async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const headers = request.headers();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    const accountId = app.privateIds[owner];
    if (request.method() === "GET") {
      if (
        headers["x-csrf-token"] !== `csrf-${owner}` ||
        (headers["x-pirate-reward-owner"] !== undefined &&
          headers["x-pirate-reward-owner"] !== accountId)
      ) {
        refused++;
        return json({ error: "reward_session_changed" }, 403);
      }
    } else {
      posts.push(path);
      expect(headers["x-csrf-token"]).toBe(`csrf-${owner}`);
    }
    const row = (n: number) => ({
      credit_id: `credit_${owner}_${n}`,
      offer_id: "offer_0001",
      account_id: accountId,
      chain_id: 6343,
      token_address: token,
      token_decimals: 18,
      amount_atomic: "30000000000000000",
      paid_atomic: "0",
      payment_id: null,
      claim: { status: "unclaimed", payout_status: "awaiting_payment" },
    });
    if (path === "/api/rewards/wallet")
      return json({
        schema: "pirate.learner-wallet/1",
        accountId,
        address: accounts[owner],
        chainId: 6343,
        token,
        decimals: 18,
        balanceAtomic: "30000000000000000",
        operator: false,
        practiceOnly: true,
        drawings: [],
      });
    if (path === "/api/rewards/credits") {
      pages.push(owner);
      const later = url.searchParams.has("cursor");
      return json({
        object: "reward_credit_list",
        accountId,
        items: [row(later ? 2 : 1)],
        next_cursor: split && !later ? `credit_${owner}_1` : null,
      });
    }
    if (path === "/api/rewards/credits/credit_first_1/claim")
      return json({ outcome: "verification_missing", credit: row(1) });
    if (path === "/api/rewards/claim-verification-intents")
      return json(original);
    if (path === "/api/rewards/verification-intents/intent_0001/complete")
      return json(original);
    throw Error("Unexpected wallet request: " + path);
  });
  await page.goto(origin + "/wallet");
  await expect(
    page.getByRole("button", { name: "Refresh balances" }),
  ).toBeVisible();
  return {
    posts,
    pages,
    refused: () => refused,
    original,
    originalBytes,
    split() {
      split = true;
    },
    replace() {
      owner = "second";
      app.signedInAs("second");
    },
  };
}
async function masked(page: Page) {
  const wallet = page.locator("[data-learner-wallet]");
  await expect(wallet.getByText(/0\.03/)).toHaveCount(0);
  await expect(
    wallet.getByRole("link", { name: "Sign in again", exact: true }),
  ).toBeVisible();
  for (const name of ["Send", "Receive", "Verify to claim", "Refresh balances"])
    await expect(wallet.getByRole("button", { name, exact: true })).toHaveCount(
      0,
    );
  await expect(page.locator('[data-route-path="/verify/very"]')).toHaveCount(0);
  await expect(
    page.getByAltText("Scan with Very to verify this claim"),
  ).toHaveCount(0);
}
for (const width of [1440, 390])
  for (const status of [401, 403]) {
    test(`actual App wallet ${status} masks private projections at headers on ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const f = await fixture(page);
      await expect(
        page.getByText("Pending rewards: $0.03", { exact: true }),
      ).toBeVisible();
      await page.evaluate((status) => {
        window.__walletPrivacy.status = status;
      }, status);
      await page.getByRole("button", { name: "Refresh balances" }).click();
      await masked(page);
      expect(await page.evaluate(() => window.__walletPrivacy.headers)).toBe(1);
      expect(await page.evaluate(() => window.__walletPrivacy.jsonReads)).toBe(
        0,
      );
      await page.evaluate(() => window.__walletPrivacy.release());
      await masked(page);
      expect(f.posts).toEqual([]);
      expect(JSON.stringify(f.original)).toBe(f.originalBytes);
      expect(errors).toEqual([]);
    });
  }
for (const status of [401, 403]) {
  test(`actual App QR/poll ${status} stops at headers and never resumes on late body`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install();
    const f = await fixture(page);
    await page
      .getByRole("button", { name: "Verify to claim", exact: true })
      .click();
    await expect(
      page.getByAltText("Scan with Very to verify this claim"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeEnabled();
    await page.evaluate((status) => {
      window.__walletPrivacy.status = status;
      window.__walletPrivacy.pollOnly = true;
    }, status);
    await page.clock.runFor(3000);
    await masked(page);
    expect(await page.evaluate(() => window.__walletPrivacy.jsonReads)).toBe(0);
    const before = [...f.posts];
    await page.evaluate(() => window.__walletPrivacy.release());
    await page.clock.runFor(15000);
    await masked(page);
    expect(f.posts).toEqual(before);
    expect(f.posts.filter((p) => p.endsWith("/claim"))).toHaveLength(1);
    expect(
      f.posts.some((p) => /\/sends|dispatch|outcome|payments/.test(p)),
    ).toBe(false);
    expect(JSON.stringify(f.original)).toBe(f.originalBytes);
  });
}
test("actual App rejects A page one / replacement-cookie B page two before blended data publishes", async ({
  page,
}) => {
  const f = await fixture(page);
  f.split();
  await page.evaluate(() => {
    window.__walletPrivacy.holdPage = true;
  });
  await page.getByRole("button", { name: "Refresh balances" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__walletPrivacy.heldPages))
    .toBe(1);
  f.replace();
  await page.evaluate(() => window.__walletPrivacy.release());
  await masked(page);
  expect(f.refused()).toBe(1);
  expect(f.pages).toEqual(["first", "first"]); // B is rejected by its captured guard before reading credits.
  expect(f.posts).toEqual([]);
});
