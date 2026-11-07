import { expect, test } from "@playwright/test";
import { origin, serveStudy } from "./study-fixture.ts";
import { readFile, mkdir } from "node:fs/promises";

test("Study distinguishes corrected and invalidated public results from its saved private lesson", async ({
  page,
}) => {
  const state = await serveStudy(page);
  await page.goto(state.url);
  await expect(page.locator(".study-surface h2")).toBeVisible();
  state.complete();
  state.revise(2, 1);
  await page.reload();
  await expect(
    page.getByText("Your corrected public learning result is published."),
  ).toBeVisible();
  state.revise(3, 5, false);
  await page
    .getByRole("button", { name: "Check publication", exact: true })
    .click();
  await expect(
    page.getByText("Your public learning result invalidation is confirming."),
  ).toBeVisible();
  state.revise(3, 5);
  await page
    .getByRole("button", { name: "Check publication", exact: true })
    .click();
  await expect(
    page.getByText(
      "Your public learning result was invalidated. Its public history is preserved.",
    ),
  ).toBeVisible();
  await expect(page.getByText("3/4", { exact: true })).toBeVisible();
  state.revise(2, 1);
  await page
    .getByRole("button", { name: "Check publication", exact: true })
    .click();
  await expect(
    page.getByText("Your corrected public learning result is published."),
  ).toBeVisible();
  expect(state.counts.starts).toBe(1);
  expect(state.counts.signatures).toBe(1);
});

test("an inconsistent disclosure cannot prompt a signature or start a Study lesson", async ({
  page,
}) => {
  const state = await serveStudy(page, { disclosureMismatch: true });
  await page.goto(state.url);
  await expect(
    page.getByText(
      "This enrollment disclosure changed. Reload and try again.",
      { exact: true },
    ),
  ).toHaveText("This enrollment disclosure changed. Reload and try again.");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.counts.signatures).toBe(0);
  expect(state.counts.enrollmentSubmissions).toBe(0);
  expect(state.counts.starts).toBe(0);
});

test("the account menu downloads saved Study history after exit and reports expiry without another lesson", async ({
  page,
}) => {
  const state = await serveStudy(page);
  await page.goto(state.url);
  const disclosure = page.getByRole("navigation", { name: "Study policies" });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    disclosure.getByRole("link", { name: "Terms", exact: true }),
  ).toHaveAttribute("href", "/learning/v3/terms");
  await expect(
    disclosure.getByRole("link", { name: "Privacy", exact: true }),
  ).toHaveAttribute("href", "/learning/v3/privacy");
  await expect(page.locator(".study-surface h2")).toBeVisible();
  const lessonId = new URL(page.url()).searchParams.get("lesson");
  await page.getByRole("button", { name: "Exit study" }).click();
  await page.getByRole("button", { name: "Learning settings" }).click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download private history" })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(`study-history-${lessonId}.json`);
  const value = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(value.schema).toBe("pirate.study-private-history/1");
  expect(value.lessonId).toBe(lessonId);
  state.expireHistory();
  await page.getByRole("button", { name: "Learning settings" }).click();
  await page
    .getByRole("menuitem", { name: "Download private history" })
    .click();
  await expect(page.locator(".live-status")).toHaveText(
    "This private history has expired.",
  );
  expect(state.counts.starts).toBe(1);
  expect(state.counts.enrollmentSubmissions).toBe(1);
});

test("leaving after enrollment dispatch preserves that authority but does not start a lesson", async ({
  page,
}) => {
  const state = await serveStudy(page, { delayEnrollment: true });
  await page.goto(state.url);
  await expect.poll(() => state.counts.enrollmentSubmissions).toBe(1);
  await page.getByRole("button", { name: "Exit study" }).click();
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/karaoke/enrollment"),
  );
  state.releaseEnrollment();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(state.counts.starts).toBe(0);
  await page.getByRole("button", { name: "Study", exact: true }).click();
  await expect(page.locator(".study-surface h2")).toHaveText("Hold me close");
  expect(state.counts.starts).toBe(1);
  expect(state.counts.signatures).toBe(1);
  expect(state.counts.enrollmentSubmissions).toBe(1);
});

test("leaving Study while a wallet signature is pending prevents new enrollment or lesson dispatch", async ({
  page,
}) => {
  const state = await serveStudy(page, { delaySignature: true });
  await page.goto(state.url);
  await expect.poll(() => state.counts.signatures).toBe(1);
  await page.getByRole("button", { name: "Exit study" }).click();
  state.releaseSignature();
  await expect(page.locator("body")).toHaveAttribute(
    "data-fixture-signature-returned",
    "true",
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(state.counts.enrollmentSubmissions).toBe(0);
  expect(state.counts.starts).toBe(0);
  await expect(page).toHaveURL(origin + "/");
});

test("Study requires sign-in and successor readiness; a signed-in learner needs no creator wallet", async ({
  page,
}) => {
  await serveStudy(page, { anonymous: true, available: false });
  await page.goto(origin);
  await expect(
    page.getByRole("heading", { name: "Fixture song" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Study", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Study", exact: true }),
  ).toHaveCount(0);
});

test("a Study link opens the wallet directly, wallet rejection starts nothing, and reload keeps its grant", async ({
  page,
}) => {
  const state = await serveStudy(page, {
    anonymous: true,
    rejectSignatureOnce: true,
  });
  await page.goto(state.url);
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(
    page.getByText("Wallet signature cancelled.", { exact: true }),
  ).toContainText("Wallet signature cancelled");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.counts.starts).toBe(0);
  expect(state.counts.signatures).toBe(1);
  expect(state.counts.enrollmentSubmissions).toBe(0);
  await page.getByRole("button", { name: "Try Again", exact: true }).click();
  await expect(page.locator(".study-surface h2")).toHaveText("Hold me close");
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeEnabled();
  expect(state.counts.starts).toBe(1);
  expect(state.counts.signatures).toBe(2);
  const lessonUrl = page.url();
  expect(new URL(lessonUrl).searchParams.get("lesson")).toBeTruthy();
  await page.reload();
  await expect(page.locator(".study-surface h2")).toHaveText("Hold me close");
  await expect(page).toHaveURL(lessonUrl);
  expect(state.counts.starts).toBe(1);
  expect(state.counts.enrollmentRequests).toBe(2);
  expect(state.counts.signatures).toBe(2);
  await page.getByRole("button", { name: "Exit study" }).click();
  await expect(page).toHaveURL(origin + "/");
  await expect(
    page.getByRole("button", { name: "Study", exact: true }),
  ).toBeVisible();
  expect(state.counts.abandons).toBe(0);
});

test("a lost lesson-start response resumes the saved lesson without a second enrollment or start", async ({
  page,
}) => {
  const state = await serveStudy(page, { loseStart: true });
  await page.goto(state.url);
  await expect(
    page.getByRole("heading", { name: "Study is unavailable" }),
  ).toBeVisible();
  expect(state.counts.starts).toBe(1);
  await page.reload();
  await expect(page.locator(".study-surface h2")).toHaveText("Hold me close");
  expect(state.counts.starts).toBe(1);
  expect(state.counts.enrollmentRequests).toBe(1);
  expect(state.counts.signatures).toBe(1);
});

test("Study completion distinguishes saved, pending and confirmed publication and preserves it on reload", async ({
  page,
}) => {
  const state = await serveStudy(page);
  await page.goto(state.url);
  await expect(page.locator(".study-surface h2")).toBeVisible();
  state.complete();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Great work!" }),
  ).toBeVisible();
  await expect(page.getByText("3/4", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Your lesson is saved. Public result publication is pending.",
    ),
  ).toBeVisible();
  state.publish();
  await page
    .getByRole("button", { name: "Check publication", exact: true })
    .click();
  await expect(
    page.getByText("Your public learning result is published."),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Your public learning result is published."),
  ).toBeVisible();
  expect(state.counts.starts).toBe(1);
  expect(state.counts.enrollmentRequests).toBe(1);
  expect(state.counts.signatures).toBe(1);
  await page.screenshot({
    path: test.info().outputPath("study-completion-desktop.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: test.info().outputPath("study-completion-mobile.png"),
    fullPage: false,
  });
});

test("a rejected restart keeps the completed first-pass result and displays its error", async ({
  page,
}) => {
  const state = await serveStudy(page);
  await page.goto(state.url);
  await expect(page.locator(".study-surface h2")).toBeVisible();
  state.complete();
  await page.reload();
  await expect(page.getByText("3/4", { exact: true })).toBeVisible();
  await page.route("**/api/study/lessons", async (route) => {
    if (route.request().method() === "POST")
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "fixture_restart_refused" }),
      });
    return route.fallback();
  });
  await page.getByRole("button", { name: "Study again", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Your answer could not be saved. Try again.",
  );
  await expect(page.getByText("3/4", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check publication", exact: true }),
  ).toBeVisible();
  expect(state.counts.starts).toBe(1);
});
for (const status of ["expired", "abandoned"] as const) {
  test(`${status} Study retains publication recovery without calling unfinished lines missed`, async ({
    page,
  }) => {
    const state = await serveStudy(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(state.url);
    await expect(page.locator(".study-surface h2")).toBeVisible();
    state.end(status);
    await page.reload();
    await expect(
      page.getByRole("heading", {
        name: status === "expired" ? "Lesson expired" : "Lesson ended",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Your saved answers are kept. Unfinished lines do not count as wrong answers.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByText("Missed", { exact: true })).toHaveCount(0);
    state.publish();
    const check = page.getByRole("button", {
      name: "Check publication",
      exact: true,
    });
    await expect(check).toBeInViewport();
    await check.click();
    await expect(
      page.getByText("Your public learning result is published.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Study policies" }),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

for (const width of [1366, 390]) {
  test(`central Study presentation remains within the ${width}px viewport`, async ({
    page,
  }) => {
    const state = await serveStudy(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(state.url);
    const surface = page.locator(".study-surface");
    await expect(
      surface.getByRole("heading", { name: "Hold me close", exact: true }),
    ).toBeVisible();
    await expect(
      surface.getByText("Say it back:", { exact: true }),
    ).toBeVisible();
    await expect(
      surface.getByRole("button", { name: "Exit study", exact: true }),
    ).toBeInViewport();
    const record = surface.getByRole("button", { name: "Record", exact: true });
    const policies = page.getByRole("navigation", { name: "Study policies" });
    await expect(record).toBeInViewport();
    await expect(policies).toBeInViewport();
    const [buttonBox, policyBox] = await Promise.all([
      record.boundingBox(),
      policies.boundingBox(),
    ]);
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(policyBox!.y);
    const header = await surface.locator("[data-study-header]").boundingBox();
    expect(header!.width).toBeLessThanOrEqual(Math.min(width, 640));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator(".study-page, .study-navigation")).toHaveCount(0);
    await mkdir(
      "../../.local/study-scoring-parity-audit-20261107/screenshots",
      { recursive: true },
    );
    await page.screenshot({
      path: `../../.local/study-scoring-parity-audit-20261107/screenshots/study-${width}.png`,
    });
  });
}
