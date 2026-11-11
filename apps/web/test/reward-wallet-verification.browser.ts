// UNRUN regression cases for the actual controller and mounted accepted composition.
// Uses the existing intercepted fixture loader; no provider or financial requests.
import { test, expect, type Page } from "@playwright/test";
import { walletFixture } from "./reward-wallet-owner-browser-helpers.ts";
import type { VerificationFixtureControls } from "./reward-wallet-verification.fixture.tsx";

type Snapshot = ReturnType<VerificationFixtureControls["snapshot"]>;
const snapshot = (page: Page): Promise<Snapshot> =>
  page.evaluate(() => window.rewardVerificationFixture.snapshot());
async function setup(page: Page, mounted = false) {
  await page.clock.install();
  const errors = await walletFixture(
    page,
    "verification-race",
    mounted ? "mounted" : "controller",
  );
  if (mounted)
    await expect(
      page.getByRole("heading", { name: "Wallet", exact: true }),
    ).toBeVisible();
  else
    await expect
      .poll(async () => (await snapshot(page)).state?.busy)
      .toBe(false);
  return errors;
}
async function scheduledPoll(page: Page, mounted = false) {
  if (mounted)
    await page
      .getByRole("button", { name: "Verify to claim", exact: true })
      .click();
  else await page.evaluate(() => window.rewardVerificationFixture.start());
  if (mounted) {
    await expect(
      page.getByAltText("Scan with Very to verify this claim"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeEnabled();
  } else {
    await expect
      .poll(async () => (await snapshot(page)).state?.busy)
      .toBe(false);
    expect((await snapshot(page)).state?.qr).toMatch(/^data:image\/png/);
  }
  await page.clock.runFor(3000);
  await expect.poll(async () => (await snapshot(page)).polls.length).toBe(1);
}

for (const [label, width, result] of [
  ["desktop pending", 1440, "pending"],
  ["mobile pending", 390, "pending"],
  ["mobile late error", 390, "error"],
  ["desktop late verified", 1440, "verified"],
] as const) {
  test(`mounted Cancel ignores scheduled ${label} response without restoring QR or polling`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = await setup(page, true);
    await scheduledPoll(page, true);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    if (result === "error")
      await page.evaluate(() => window.rewardVerificationFixture.failPoll(0));
    else
      await page.evaluate(
        (state) => window.rewardVerificationFixture.settlePoll(0, state),
        result,
      );
    await expect(page.locator('[data-route-path="/verify/very"]')).toHaveCount(
      0,
    );
    await expect(
      page.getByAltText("Scan with Very to verify this claim"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Wallet", exact: true }),
    ).toBeVisible();
    await page.clock.runFor(15000);
    const after = await snapshot(page);
    expect(after.polls).toHaveLength(1);
    expect(after.claims).toEqual([{ id: "credit_0001", owner: "original" }]);
    expect(after.records).toEqual([
      {
        id: "intent_0001",
        owner: "original",
        state: result === "verified" ? "verified" : "pending",
      },
    ]);
    expect(new URL(page.url()).pathname).toBe("/wallet");
    expect(new URL(page.url()).searchParams.has("claim")).toBe(false);
    await expect(
      page.getByText(
        /fixture-private|Verification is still pending|contact support/,
      ),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

for (const fail of [false, true]) {
  test(`replacement retains its busy ownership after old poll ${fail ? "error" : "response"}`, async ({
    page,
  }) => {
    const errors = await setup(page);
    await scheduledPoll(page);
    await page.evaluate(() => {
      window.rewardVerificationFixture.holdIntent();
      window.rewardVerificationFixture.replace();
    });
    await expect.poll(async () => (await snapshot(page)).starts.length).toBe(1);
    const replacement = (await snapshot(page)).state;
    expect(replacement).toMatchObject({
      intent: null,
      qr: "",
      busy: true,
      notice: "",
      failedPolls: 0,
    });
    if (fail)
      await page.evaluate(() => window.rewardVerificationFixture.failPoll(0));
    else
      await page.evaluate(() =>
        window.rewardVerificationFixture.settlePoll(0, "subject_conflict"),
      );
    await page.clock.runFor(12000);
    expect((await snapshot(page)).state).toEqual(replacement);
    expect((await snapshot(page)).polls).toHaveLength(1);
    await page.evaluate(() =>
      window.rewardVerificationFixture.releaseIntent(0),
    );
    await expect
      .poll(async () => (await snapshot(page)).state?.busy)
      .toBe(false);
    const current = (await snapshot(page)).state!;
    expect(current.intent?.intent_id).toBe("intent_0002");
    expect(current.qr).toMatch(/^data:image\/png/);
    expect(current.failedPolls).toBe(0);
    expect(current.notice).toBe("");
    expect(errors).toEqual([]);
  });

  test(`late initial intent ${fail ? "error" : "success"} cannot clear a new action's busy state`, async ({
    page,
  }) => {
    const errors = await setup(page);
    await page.evaluate(() => {
      window.rewardVerificationFixture.holdIntent();
      window.rewardVerificationFixture.start();
    });
    await expect.poll(async () => (await snapshot(page)).starts.length).toBe(1);
    await page.evaluate(() => {
      window.rewardVerificationFixture.cancel();
    });
    await expect
      .poll(async () => (await snapshot(page)).state?.busy)
      .toBe(false);
    await page.evaluate(() => {
      window.rewardVerificationFixture.start();
    });
    await expect.poll(async () => (await snapshot(page)).starts.length).toBe(2);
    const replacement = (await snapshot(page)).state;
    await page.evaluate(
      (fail) => window.rewardVerificationFixture.releaseIntent(0, fail),
      fail,
    );
    await page.clock.runFor(12000);
    expect((await snapshot(page)).state).toEqual(replacement);
    expect(replacement).toMatchObject({
      busy: true,
      intent: null,
      qr: "",
      notice: "",
    });
    expect((await snapshot(page)).polls).toHaveLength(0);
    await page.evaluate(() =>
      window.rewardVerificationFixture.releaseIntent(1),
    );
    await expect
      .poll(async () => (await snapshot(page)).state?.busy)
      .toBe(false);
    expect((await snapshot(page)).state?.intent?.intent_id).toBe("intent_0002");
    expect((await snapshot(page)).records).toHaveLength(2);
    expect(errors).toEqual([]);
  });
}

for (const fail of [false, true]) {
  test(`actual wallet-account change invalidates the old ${fail ? "error" : "result"} and prevents old-credit replay`, async ({
    page,
  }) => {
    const errors = await setup(page);
    await scheduledPoll(page);
    await page.evaluate(() => {
      window.rewardVerificationFixture.switchAccount();
      window.rewardVerificationFixture.refresh();
    });
    await expect
      .poll(async () => (await snapshot(page)).accountChanges)
      .toBe(1);
    const changed = (await snapshot(page)).state;
    expect(changed).toMatchObject({
      intent: null,
      qr: "",
      address: null,
      credits: [],
      busy: false,
      failedPolls: 0,
    });
    expect(new URL(page.url()).pathname).toBe("/wallet");
    expect(new URL(page.url()).searchParams.has("claim")).toBe(false);
    if (fail)
      await page.evaluate(() => window.rewardVerificationFixture.failPoll(0));
    else
      await page.evaluate(() =>
        window.rewardVerificationFixture.settlePoll(0, "verified"),
      );
    await page.clock.runFor(15000);
    expect((await snapshot(page)).state).toEqual(changed);
    const claim = await page.evaluate(() =>
      window.rewardVerificationFixture.claim(),
    );
    expect(claim).toEqual({
      error: "The account or wallet changed. Reopen your wallet.",
    });
    await page.evaluate(() => {
      window.rewardVerificationFixture.resume();
      window.rewardVerificationFixture.replace();
    });
    expect((await snapshot(page)).records).toEqual([
      {
        id: "intent_0001",
        owner: "original",
        state: fail ? "pending" : "verified",
      },
    ]);
    expect((await snapshot(page)).claims).toHaveLength(0);
    expect((await snapshot(page)).polls).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}

test("a claim result requested by the original owner is not returned after account replacement", async ({
  page,
}) => {
  const errors = await setup(page);
  await page.evaluate(() => {
    window.rewardVerificationFixture.holdClaim();
    void window.rewardVerificationFixture.claim().then((result) => {
      Object.assign(window, { lateVerificationClaim: result });
    });
  });
  await expect.poll(async () => (await snapshot(page)).claimReplies).toBe(1);
  await page.evaluate(() => {
    window.rewardVerificationFixture.switchAccount();
    window.rewardVerificationFixture.refresh();
  });
  await expect.poll(async () => (await snapshot(page)).accountChanges).toBe(1);
  await page.evaluate(() => window.rewardVerificationFixture.releaseClaim(0));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { lateVerificationClaim?: unknown })
            .lateVerificationClaim,
      ),
    )
    .toEqual({ error: "The account or wallet changed. Reopen your wallet." });
  expect((await snapshot(page)).claims).toEqual([
    { id: "credit_0001", owner: "original" },
  ]);
  expect((await snapshot(page)).state).toMatchObject({
    intent: null,
    qr: "",
    credits: [],
  });
  expect(errors).toEqual([]);
});

for (const fail of [false, true]) {
  test(`disposal ignores late ${fail ? "error" : "verified result"} without timer, URL or private-state mutation`, async ({
    page,
  }) => {
    const errors = await setup(page);
    await scheduledPoll(page);
    await page.evaluate(() => window.rewardVerificationFixture.dispose());
    await expect(page.locator("[data-verification-controller]")).toHaveCount(0);
    const before = (await snapshot(page)).state;
    const url = page.url();
    if (fail)
      await page.evaluate(() => window.rewardVerificationFixture.failPoll(0));
    else
      await page.evaluate(() =>
        window.rewardVerificationFixture.settlePoll(0, "verified"),
      );
    await page.clock.runFor(15000);
    expect((await snapshot(page)).state).toEqual(before);
    expect(page.url()).toBe(url);
    expect((await snapshot(page)).claims).toHaveLength(0);
    expect((await snapshot(page)).polls).toHaveLength(1);
    expect((await snapshot(page)).records).toHaveLength(1);
    await page.evaluate(() => window.rewardVerificationFixture.remount());
    await expect(page.locator("[data-verification-controller]")).toHaveCount(1);
    await expect
      .poll(async () => (await snapshot(page)).state?.busy)
      .toBe(false);
    expect((await snapshot(page)).state).toMatchObject({
      intent: null,
      qr: "",
    });
    expect((await snapshot(page)).claims).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

test("Cancel also fences the refresh awaited by a terminal conflict response", async ({
  page,
}) => {
  const errors = await setup(page);
  await scheduledPoll(page);
  await page.evaluate(() => {
    window.rewardVerificationFixture.holdWallet();
    window.rewardVerificationFixture.settlePoll(0, "subject_conflict");
  });
  await expect.poll(async () => (await snapshot(page)).walletReplies).toBe(1);
  await page.evaluate(() => window.rewardVerificationFixture.cancel());
  const cancelled = (await snapshot(page)).state;
  await page.evaluate(() => window.rewardVerificationFixture.releaseWallet(0));
  await page.clock.runFor(12000);
  expect((await snapshot(page)).state).toEqual(cancelled);
  expect(cancelled).toMatchObject({
    intent: null,
    qr: "",
    notice: "",
    busy: false,
  });
  expect((await snapshot(page)).polls).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("current poll failure budget still exposes Check palm scan and resumes the same intent", async ({
  page,
}) => {
  const errors = await setup(page, true);
  await scheduledPoll(page, true);
  for (let index = 0; index < 5; index++) {
    await page.evaluate(
      (index) => window.rewardVerificationFixture.failPoll(index),
      index,
    );
    if (index < 4) {
      await page.clock.runFor(3000);
      await expect
        .poll(async () => (await snapshot(page)).polls.length)
        .toBe(index + 2);
    }
  }
  await expect(
    page.getByRole("button", { name: "Check palm scan", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(15000);
  expect((await snapshot(page)).polls).toHaveLength(5);
  await page
    .getByRole("button", { name: "Check palm scan", exact: true })
    .click();
  await expect.poll(async () => (await snapshot(page)).polls.length).toBe(6);
  await page.evaluate(() => window.rewardVerificationFixture.settlePoll(5));
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Check palm scan", exact: true }),
  ).toHaveCount(0);
  expect((await snapshot(page)).records).toHaveLength(1);
  expect(
    (await snapshot(page)).polls.every((p) => p.id === "intent_0001"),
  ).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.clock.runFor(15000);
  expect((await snapshot(page)).polls).toHaveLength(6);
  expect(errors).toEqual([]);
});

test("a genuine current simulated verification result still resumes the original credit once", async ({
  page,
}) => {
  const errors = await setup(page, true);
  await scheduledPoll(page, true);
  expect((await snapshot(page)).claims).toHaveLength(1);
  await page.evaluate(() =>
    window.rewardVerificationFixture.settlePoll(0, "verified"),
  );
  await expect(
    page.getByText("Awaiting payment. Payments are processed daily.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('[data-route-path="/verify/very"]')).toHaveCount(0);
  await expect(
    page.getByAltText("Scan with Very to verify this claim"),
  ).toHaveCount(0);
  await page.clock.runFor(15000);
  expect((await snapshot(page)).claims).toEqual([
    { id: "credit_0001", owner: "original" },
    { id: "credit_0001", owner: "original" },
  ]);
  expect((await snapshot(page)).accepted).toBe(true);
  expect((await snapshot(page)).polls).toHaveLength(1);
  expect((await snapshot(page)).records).toHaveLength(1);
  expect(new URL(page.url()).searchParams.has("claim")).toBe(false);
  expect(errors).toEqual([]);
});
