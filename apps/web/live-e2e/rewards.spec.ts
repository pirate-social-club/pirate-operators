// Built-client acceptance with explicit simulated credits/verification/receipts.
// Actual D1 authorization and accounting run in the root manual-rewards tests.
import { test, expect, type Page } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";

const origin = "https://community.example",
  address = `0x${"55".repeat(20)}`,
  reserve = `0x${"33".repeat(20)}`,
  token = `0x${"11".repeat(20)}`;
async function fixture(
  page: Page,
  operator = false,
  uncertain = false,
  rehearsalMode = false,
) {
  let verified = false,
    paid = false,
    accepted = false,
    intents = 0,
    claims = 0,
    prepared = uncertain,
    cancelled = false;
  let rehearsalAttached = false,
    rehearsalClosed = false,
    rehearsalSettled = false;
  const rehearsal = {
    schema: "pirate.reward-rehearsal/1",
    offerId: "rehearsal_001",
    prizeUsdcAtomic: "30000",
    drawingId: "0",
    purchaseHash: `0x${"bb".repeat(32)}`,
    ticketIds: ["77"],
  };
  const rehearsalOffer = () => ({
    ...rehearsal,
    evidenceMode: "simulated",
    songKey: `0x${"cc".repeat(32)}`,
    opensAt: Date.now() - 100000,
    cutoffAt: Date.now() - 1,
    state: rehearsalSettled ? "settled" : rehearsalClosed ? "closed" : "open",
    entries: [],
    winningsUsdcAtomic: null,
    payoutAtomic: null,
    remainderAtomic: null,
  });
  const credit = () => ({
    credit_id: "credit_0001",
    offer_id: "offer_0001",
    account_id: "learner_01",
    chain_id: 6343,
    token_address: token,
    token_decimals: 6,
    amount_atomic: "180000",
    paid_atomic: paid ? "180000" : "0",
    payment_id: null,
    claim: {
      status: accepted ? "accepted" : "unclaimed",
      payout_status: paid ? "confirmed" : "awaiting_payment",
    },
  });
  const payment = () => ({
    paymentId: "payment_001",
    accountId: "learner_01",
    sender: reserve,
    recipient: address,
    chainId: 6343,
    token,
    decimals: 6,
    amountAtomic: "180000",
    creditIds: ["credit_0001", "credit_0002"],
    state: cancelled ? "cancelled" : uncertain ? "review_required" : "prepared",
    transactionHash: null,
    preparedAt: 1,
    guardNonce: (((0x5052n << 176n) | 17n) << 64n).toString(),
    everDispatched: uncertain,
    latestAttemptId: uncertain ? "attempt_001" : null,
    attempts: uncertain
      ? [
          {
            attemptId: "attempt_001",
            action: "pay",
            outcome: "unknown",
            transactionHash: null,
            createdAt: 1,
          },
        ]
      : [],
  });
  await page.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
    if (url.origin !== origin) {
      await route.abort();
      return;
    }
    if (path === "/api/session")
      return json({
        authenticated: true,
        authorId: "fixture",
        mossAddress: address,
        csrf: "fixture-csrf",
        creator: null,
        pendingConnection: null,
      });
    if (path === "/.well-known/pirate-client.json")
      return json({
        schema: "pirate.community-client-config/1",
        canonicalOrigin: origin,
        communityId: "fixture",
        apiBase: "/api",
      });
    if (path === "/api/public/community")
      return json({ name: "Fixture community" });
    if (path === "/api/capabilities")
      return json({ signIn: true, rewards: true });
    if (path === "/api/feed") return json({ posts: [] });
    if (req.method() === "POST")
      expect(req.headers()["x-csrf-token"]).toBe("fixture-csrf");
    if (path === "/api/rewards/wallet")
      return json({
        schema: "pirate.learner-wallet/1",
        address,
        chainId: 6343,
        token,
        decimals: 6,
        balanceAtomic: paid ? "180000" : "0",
        operator,
        practiceOnly: true,
        drawings: [
          {
            offerId: "offer_lost",
            drawingId: "1",
            cutoffAt: 1794070800000,
            state: "no_prize",
            qualified: true,
          },
          {
            offerId: "offer_missed",
            drawingId: "2",
            cutoffAt: 1794070800000,
            state: "closed",
            qualified: false,
          },
        ],
      });
    if (path === "/api/rewards/credits")
      return json({
        object: "reward_credit_list",
        items: [credit()],
        next_cursor: null,
      });
    if (path === "/api/rewards/credits/credit_0001/claim") {
      claims++;
      if (verified) accepted = true;
      return json({
        outcome: verified ? "accepted" : "verification_missing",
        credit: credit(),
      });
    }
    if (path === "/api/rewards/claim-verification-intents") {
      intents++;
      return json({
        intent_id: "intent_0001",
        state: "pending",
        expires_at: Date.now() + 300000,
        launch_url: "veros://verify?sessionId=fixture",
      });
    }
    if (path === "/api/rewards/verification-intents/intent_0001/complete")
      return json({
        intent_id: "intent_0001",
        state: verified ? "verified" : "pending",
        expires_at: Date.now() + 300000,
        launch_url: verified ? null : "veros://verify?sessionId=fixture",
      });
    if (path === "/api/operator/rewards")
      return json({
        offers: rehearsalAttached ? [rehearsalOffer()] : [],
        rehearsal: rehearsalMode ? rehearsal : null,
        liabilities: {
          total: "180000",
          unclaimed: "0",
          held: "0",
          accepted: "180000",
        },
        payments: prepared ? [payment()] : [],
        ready:
          prepared && !cancelled
            ? []
            : [
                {
                  account_id: "learner_01",
                  wallet: address,
                  credit_id: "credit_0001",
                  amount_atomic: "90000",
                },
                {
                  account_id: "learner_01",
                  wallet: address,
                  credit_id: "credit_0002",
                  amount_atomic: "90000",
                },
              ],
        inventory: {
          received_atomic: "1000000",
          reserved_atomic: prepared && !cancelled ? "180000" : "0",
          paid_atomic: "0",
          cost_atomic: "0",
        },
        payoutWallet: reserve,
        unmatched: [],
        observedBalanceAtomic: "1000000",
        practiceOnly: true,
        simulatedWinnings: !rehearsalMode,
        decimals: 6,
        token,
        chainId: 6343,
        songs: rehearsalMode
          ? [{ songKey: `0x${"cc".repeat(32)}`, title: "Fixture song" }]
          : [],
        funding: [],
      });
    if (path === "/api/operator/rewards/offers") {
      const body = req.postDataJSON();
      expect(body.offerId).toBe(rehearsal.offerId);
      expect(body.purchaseHash).toBe(rehearsal.purchaseHash);
      expect(body.ticketIds).toEqual(rehearsal.ticketIds);
      expect(body.drawingId).toBe("0");
      expect(body.opensAt).toBeGreaterThan(Date.now());
      expect(body.cutoffAt).toBeGreaterThan(body.opensAt);
      rehearsalAttached = true;
      return json(rehearsalOffer());
    }
    if (path === "/api/operator/rewards/offers/rehearsal_001/settle") {
      expect(req.postDataJSON()).toEqual({});
      rehearsalSettled = true;
      return json(rehearsalOffer());
    }
    if (path === "/api/operator/rewards/payments") {
      prepared = true;
      return json(payment());
    }
    if (path === "/api/operator/rewards/payments/payment_001/cancel") {
      cancelled = true;
      return json(payment());
    }
    if (path.startsWith("/api/"))
      return json({ error: "fixture_unexpected_request" }, 404);
    const file = path.startsWith("/app/assets/")
      ? resolve("dist/live", path.slice(1))
      : resolve("dist/live/index.html");
    const contentType =
      (
        {
          ".js": "text/javascript",
          ".css": "text/css",
          ".mp3": "audio/mpeg",
        } as Record<string, string>
      )[extname(file)] ?? "text/html";
    return route.fulfill({ contentType, body: await readFile(file) });
  });
  return {
    verify: () => {
      verified = true;
    },
    pay: () => {
      paid = true;
    },
    intents: () => intents,
    claims: () => claims,
    prepared: () => prepared,
    closeRehearsal: () => {
      rehearsalClosed = true;
    },
  };
}

async function expectZeroBalance(page: Page) {
  await expect(
    page.getByRole("paragraph").filter({ hasText: /^\$0\.00$/ }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "MegaETH testnet", exact: true })
      .getByText("$0.00", { exact: true }),
  ).toBeVisible();
}

test("claim survives reload, credits stay separate from balance, and the learner page stays simple", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  await page.goto(origin + "/wallet");
  await expectZeroBalance(page);
  await expect(page.getByText("0.18 test USDm", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "MegaETH testnet", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/This drawing had no prize\./)).toBeVisible();
  await expect(
    page.getByText(/You did not qualify for this drawing\./),
  ).toBeVisible();
  await expect(page.getByText(/Claimable royalties|Base Sepolia/)).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Verify to claim", exact: true })
    .click();
  await expect(
    page.getByAltText("Scan with Very to verify this claim"),
  ).toBeVisible();
  expect(f.intents()).toBe(1);
  await page.reload();
  await expect(
    page.getByAltText("Scan with Very to verify this claim"),
  ).toBeVisible();
  expect(f.intents()).toBe(1);
  f.verify();
  await expect(
    page.getByText("Awaiting payment. Payments are processed daily.", {
      exact: true,
    }),
  ).toBeVisible();
  await expectZeroBalance(page);
  expect(f.claims()).toBe(2);
  f.pay();
  await page
    .getByRole("button", { name: "Refresh balances", exact: true })
    .click();
  await expect(
    page.getByText("Sent to your wallet", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("$0.18", { exact: true })).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await mkdir(
    "../../.local/owner-wallet-verification-cancel-repair-20261111/existing-rewards-browser",
    { recursive: true },
  );
  await page.screenshot({
    path: "../../.local/owner-wallet-verification-cancel-repair-20261111/existing-rewards-browser/learner-phone.png",
    fullPage: true,
  });
});

test("operator sees one combined payment and can cancel it before requesting a signature", async ({
  page,
}) => {
  const f = await fixture(page, true);
  await page.goto(origin + "/operator/rewards");
  await expect(page.getByText(/Unpaid learner winnings: \$0.18/)).toBeVisible();
  await expect(
    page.getByText("$0.18 across 2 credits", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Prepare payment", exact: true })
    .click();
  expect(f.prepared()).toBe(true);
  await expect(
    page.getByRole("heading", { name: "Review payment", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(`To: ${address}`, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve in wallet", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel prepared payment", exact: true })
    .first()
    .click();
  await expect(
    page.getByText("$0.18 across 2 credits", { exact: true }),
  ).toBeVisible();
  await mkdir(
    "../../.local/owner-wallet-verification-cancel-repair-20261111/existing-rewards-browser",
    { recursive: true },
  );
  await page.screenshot({
    path: "../../.local/owner-wallet-verification-cancel-repair-20261111/existing-rewards-browser/operator-desktop.png",
    fullPage: true,
  });
});

test("an uncertain wallet result keeps explicit guarded retry and on-chain cancellation controls across reload", async ({
  page,
}) => {
  await fixture(page, true, true);
  await page.goto(origin + "/operator/rewards");
  await expect(
    page.getByText("$0.18 · review required", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel prepared payment", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Review guarded retry", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review payment", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  await page
    .getByRole("button", { name: "Cancel through wallet", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Review cancellation", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Confirm cancellation in wallet",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Cancel through wallet", exact: true }),
  ).toBeVisible();
  await page.getByText("Recent wallet attempts (1)", { exact: true }).click();
  await expect(
    page.getByText("No transaction hash received", { exact: true }),
  ).toBeVisible();
});

test("operator attaches one explicit rehearsal with frozen evidence and settles without a collection hash", async ({
  page,
}) => {
  const f = await fixture(page, true, false, true);
  await page.goto(origin + "/operator/rewards");
  await expect(
    page.getByRole("heading", { name: "Create rehearsal offer", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Simulated ticket and prize evidence: \$0.03 total/),
  ).toBeVisible();
  await expect(
    page.getByLabel("Purchase transaction", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Attach rehearsal offer", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Rehearsal already attached",
      exact: true,
    }),
  ).toBeDisabled();
  f.closeRehearsal();
  await page.reload();
  await expect(
    page.getByText("Rehearsal offer · closed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Collection transaction, required for a win", {
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Credit simulated prize", exact: true })
    .click();
  await expect(
    page.getByText("Rehearsal offer · settled", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Drawing source", exact: true })
    .selectOption("live");
  await expect(
    page.getByLabel("Purchase transaction", { exact: true }),
  ).toBeVisible();
});
