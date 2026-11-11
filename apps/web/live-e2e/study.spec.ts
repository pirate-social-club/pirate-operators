import {
  studyOverlay,
  studyHeading,
  openSettings,
  startStudy,
  openSong,
  home,
  signInCurrent,
} from "./account-fixture.ts";
import { expect, test, type Page } from "@playwright/test";
import { origin, serveStudy } from "./study-fixture.ts";
import { readFile, mkdir } from "node:fs/promises";

async function expectNoPublicationPanel(page: Page) {
  const study = studyOverlay(page);
  await expect(study).toBeVisible();
  await expect(
    study.getByRole("heading", { name: "Great work!", exact: true }),
  ).toBeVisible();
  await expect(study.locator("[data-activity-results]")).toBeVisible();
  await expect(
    study.getByRole("region", { name: "Result publication", exact: true }),
  ).toHaveCount(0);
  await expect(
    study.getByRole("button", {
      name: /Check(?:ing)? publication|^Check again$/,
    }),
  ).toHaveCount(0);
  await expect(
    study.getByText(
      /public learning result|public result publication|Publication needs operator review|saved privately|This result was kept private|This result is published|Publication is pending/i,
    ),
  ).toHaveCount(0);
}
const publicationResponse = (page: Page) =>
  page.waitForResponse((response) => response.url().endsWith("/publication"));

test("corrected and invalidated public results reconcile without a learner publication panel", async ({
  page,
}) => {
  const state = await serveStudy(page);
  await page.goto(state.url);
  await expect(studyHeading(page)).toBeVisible();
  state.complete();
  state.revise(2, 1);
  const corrected = publicationResponse(page);
  await page.reload();
  expect(
    (await (await corrected).json()).receipt.canonicalRevision.revision,
  ).toBe(2);
  await expect(page.getByText("3/4", { exact: true })).toBeVisible();
  await expectNoPublicationPanel(page);
  state.revise(3, 5, false);
  const invalidating = publicationResponse(page);
  await page.reload();
  expect(
    (await (await invalidating).json()).receipt.canonicalRevision.status,
  ).toBe(5);
  await expectNoPublicationPanel(page);
  state.revise(3, 5);
  const confirmed = await publicationResponse(page);
  expect((await confirmed.json()).receipt.confirmed).toBe(true);
  await confirmed.finished();
  await expectNoPublicationPanel(page);
  await expect(page.getByText("3/4", { exact: true })).toBeVisible();
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

test("a V3 community's footer links the V3 learning documents while the Study surface links none", async ({
  page,
}) => {
  const state = await serveStudy(page);
  await page.goto(state.url);
  await expect(studyHeading(page)).toBeVisible();
  await expect(
    page.locator(".live-study-overlay").getByRole("link"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Exit study" }).click();
  const footer = page.getByRole("navigation", { name: "Community documents" });
  await expect(footer.locator("xpath=ancestor::footer")).toHaveCount(1);
  for (const [name, href] of [
    ["Terms", "/terms"],
    ["Privacy", "/privacy"],
    ["Learning terms", "/learning/v3/terms"],
    ["Learning privacy", "/learning/v3/privacy"],
  ] as const)
    await expect(
      footer.getByRole("link", { name, exact: true }),
    ).toHaveAttribute("href", href);
  // Only the community's own version is linked.
  await expect(page.locator('a[href^="/learning/v4/"]')).toHaveCount(0);
});

test("the account menu downloads saved Study history after exit and reports expiry without another lesson", async ({
  page,
}) => {
  const state = await serveStudy(page);
  await page.goto(state.url);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The exercise surface carries no policy links; the documents stay in
  // normal site navigation.
  await expect(
    page.getByRole("navigation", { name: "Study policies" }),
  ).toHaveCount(0);
  await expect(studyHeading(page)).toBeVisible();
  const lessonId = new URL(page.url()).searchParams.get("lesson");
  await page.getByRole("button", { name: "Exit study" }).click();
  await openSettings(page);
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download private history", exact: true })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(`study-history-${lessonId}.json`);
  const value = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(value.schema).toBe("pirate.study-private-history/1");
  expect(value.lesson.lessonId).toBe(lessonId);
  expect(value.activity).toBe("study");
  expect(value.communityId).toBe(state.communityId);
  expect(value.exportAvailableUntil).toBeGreaterThan(value.exportedAt);
  expect(value.attempts[0].heardTranscript).toBe("private fixture words");
  state.expireHistory();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Download private history", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
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
  await startStudy(page);
  await expect(studyHeading(page)).toHaveText("Hold me close");
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
    page.getByRole("link", { name: "Fixture song", exact: true }).first(),
  ).toBeVisible();
  await openSong(page);
  await expect(
    page
      .getByRole("navigation", { name: "Song activities" })
      .getByRole("link", { name: "Study", exact: true }),
  ).toHaveCount(0);
  await signInCurrent(page);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Signed in. Choose a song to study or sing." }),
  ).toBeVisible();
  await openSong(page);
  await expect(
    page
      .getByRole("navigation", { name: "Song activities" })
      .getByRole("link", { name: "Study", exact: true }),
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
  await signInCurrent(page);
  await expect(
    page.getByText("Wallet signature cancelled.", { exact: true }),
  ).toContainText("Wallet signature cancelled");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.counts.starts).toBe(0);
  expect(state.counts.signatures).toBe(1);
  expect(state.counts.enrollmentSubmissions).toBe(0);
  await page.getByRole("button", { name: "Try Again", exact: true }).click();
  await expect(studyHeading(page)).toHaveText("Hold me close");
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeEnabled();
  expect(state.counts.starts).toBe(1);
  expect(state.counts.signatures).toBe(2);
  const lessonUrl = page.url();
  expect(new URL(lessonUrl).searchParams.get("lesson")).toBeTruthy();
  await page.reload();
  await expect(studyHeading(page)).toHaveText("Hold me close");
  await expect(page).toHaveURL(lessonUrl);
  expect(state.counts.starts).toBe(1);
  expect(state.counts.enrollmentRequests).toBe(2);
  expect(state.counts.signatures).toBe(2);
  await page.getByRole("button", { name: "Exit study" }).click();
  await expect(page).toHaveURL(origin + "/");
  await openSong(page);
  await expect(
    page
      .getByRole("navigation", { name: "Song activities" })
      .getByRole("link", { name: "Study", exact: true }),
  ).toBeVisible();
  expect(state.counts.abandons).toBe(0);
});

for (const mode of ["hang", "reject"] as const) {
  test(`Study opens and resumes while optional reward offers ${mode === "hang" ? "never answer" : "fail"}`, async ({
    page,
  }) => {
    const state = await serveStudy(page, { rewardOffers: mode });
    await page.goto(state.url);
    await expect(studyHeading(page)).toHaveText("Hold me close");
    await expect(
      page.getByRole("button", { name: "Record", exact: true }),
    ).toBeEnabled();
    expect(state.counts.rewardOfferRequests).toBe(1);
    expect(state.counts.starts).toBe(1);
    const lessonUrl = page.url();
    expect(new URL(lessonUrl).searchParams.get("lesson")).toBeTruthy();
    await page.reload();
    await expect(studyHeading(page)).toHaveText("Hold me close");
    await expect(page).toHaveURL(lessonUrl);
    await expect.poll(() => state.counts.rewardOfferRequests).toBe(2);
    expect(state.counts.starts).toBe(1);
  });
}

test("a lost lesson-start response resumes the saved lesson without a second enrollment or start", async ({
  page,
}) => {
  const state = await serveStudy(page, { loseStart: true });
  await page.goto(state.url);
  await expect(
    page.getByRole("heading", { name: "Study unavailable" }),
  ).toBeVisible();
  expect(state.counts.starts).toBe(1);
  await page.reload();
  await expect(studyHeading(page)).toHaveText("Hold me close");
  expect(state.counts.starts).toBe(1);
  expect(state.counts.enrollmentRequests).toBe(1);
  expect(state.counts.signatures).toBe(1);
});

test("completed Study automatically recovers pending publication without exposing implementation controls", async ({
  page,
}) => {
  await page.clock.install();
  const state = await serveStudy(page);
  await page.goto(state.url);
  await expect(studyHeading(page)).toBeVisible();
  state.complete();
  const pending = publicationResponse(page);
  await page.reload();
  expect((await (await pending).json()).state).toBe("pending");
  await expect(
    page.getByRole("heading", { name: "Great work!" }),
  ).toBeVisible();
  await expect(page.getByText("3/4", { exact: true })).toBeVisible();
  await expectNoPublicationPanel(page);
  const confirming = publicationResponse(page);
  state.publish();
  await page.clock.runFor(3100);
  const response = await confirming;
  expect((await response.json()).receipt.confirmed).toBe(true);
  await response.finished();
  await page.evaluate(() => Promise.resolve());
  const checks = state.counts.publicationChecks;
  await page.clock.runFor(15000);
  expect(state.counts.publicationChecks).toBe(checks);
  expect(state.counts.terminalReads).toBeGreaterThanOrEqual(checks);
  const beforeReload = state.counts.publicationChecks;
  await page.reload();
  await expect(page.getByText("3/4", { exact: true })).toBeVisible();
  await expect
    .poll(() => state.counts.publicationChecks)
    .toBeGreaterThan(beforeReload);
  expect(state.publicationResponses.at(-1)?.confirmed).toBe(true);
  await expectNoPublicationPanel(page);
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
  await expect(studyHeading(page)).toBeVisible();
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
    "A new lesson could not start. Try again.",
  );
  await expect(page.getByText("3/4", { exact: true })).toBeVisible();
  await expectNoPublicationPanel(page);
  expect(state.counts.starts).toBe(1);
});
for (const status of ["expired", "abandoned"] as const) {
  test(`reopening Study after an ${status} lesson starts a new lesson`, async ({
    page,
  }) => {
    const state = await serveStudy(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(state.url);
    await expect(studyHeading(page)).toBeVisible();
    const starts = state.counts.starts;
    state.end(status);
    await page.reload();
    // An ended lesson is never shown again; the server recovers its
    // publication on its own schedule.
    await expect(studyHeading(page)).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Expired Study session", exact: true }),
    ).toHaveCount(0);
    expect(state.counts.starts).toBe(starts + 1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("leaving a completed lesson cancels its background publication polling", async ({
  page,
}) => {
  await page.clock.install();
  const state = await serveStudy(page);
  await page.goto(state.url);
  await expect(studyHeading(page)).toBeVisible();
  state.complete();
  const pending = publicationResponse(page);
  await page.reload();
  await (await pending).finished();
  await expect(
    page.getByRole("heading", { name: "Great work!" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(origin + "/");
  const checks = state.counts.publicationChecks;
  await page.clock.runFor(20000);
  expect(state.counts.publicationChecks).toBe(checks);
  expect(state.counts.starts).toBe(1);
});

for (const width of [1366, 390]) {
  test(`central Study presentation remains within the ${width}px viewport`, async ({
    page,
  }) => {
    const state = await serveStudy(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(state.url);
    const surface = studyOverlay(page);
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
    await expect(record).toBeInViewport();
    await expect(
      page.getByRole("navigation", { name: "Study policies" }),
    ).toHaveCount(0);
    const header = await surface.locator("[data-study-header]").boundingBox();
    expect(header!.width).toBeLessThanOrEqual(Math.min(width, 640));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(studyOverlay(page).getByRole("link")).toHaveCount(0);
    await expect(
      studyOverlay(page).getByRole("heading", { level: 2 }),
    ).toHaveText("Hold me close");
    await mkdir(
      "../../.local/study-scoring-parity-audit-20261107/screenshots",
      { recursive: true },
    );
    await page.screenshot({
      path: `../../.local/study-scoring-parity-audit-20261107/screenshots/study-${width}.png`,
    });
  });
}
