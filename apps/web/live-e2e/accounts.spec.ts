// The live application's account handling for Study: another tab signing in as
// another account, signing out and back in, and a temporary session-check
// failure. Stale lesson state must clear; the current lesson must not be lost.
import { expect, test, type Page } from "@playwright/test";
import {
  accounts,
  serveAccounts,
  studyOverlay,
  studyHeading,
  exitStudy,
  openSettings,
  home,
  startStudy,
  expectAccount,
  signInCurrent as signIn,
} from "./account-fixture.ts";

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  },
});
const heading = studyHeading;
const lessonParam = (page: Page) =>
  new URL(page.url()).searchParams.get("lesson");
const changed =
  "You are signed in with a different account. Reload to continue.";

test("another tab signing in as another account clears the open lesson; reload shows only that account's own lesson", async ({
  page,
}) => {
  const state = await serveAccounts(page);
  state.signedInAs("first");
  await page.goto(state.lessonUrl(state.firstLesson.lessonId));
  await expect(heading(page)).toHaveText("Stay with me");
  // The cookie now belongs to the second account. This page still shows the
  // first account's lesson until it next talks to the server.
  state.signedInAs("second");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1100); // Intentional real capture duration.
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText(changed)).toBeVisible();
  await expect(
    studyOverlay(page).getByRole("button", { name: "Record", exact: true }),
  ).toHaveCount(0);
  await expect(heading(page)).toHaveCount(0);
  expect(state.counts.refusedAccount).toBeGreaterThan(0);
  // Nothing happened to the first account's lesson.
  expect(state.lessonsOf("first")).toEqual([state.firstLesson]);
  expect(state.counts.abandons).toBe(0);
  // Reloading the same link under the second account opens its own lesson.
  await page.reload();
  await expect(heading(page)).toHaveText("Hold me close");
  const own = state.lessonsOf("second");
  expect(own).toHaveLength(1);
  expect(own[0].lessonId).not.toBe(state.firstLesson.lessonId);
  await expect.poll(() => lessonParam(page)).toBe(own[0].lessonId);
  expect(state.counts.foreign).toBe(1);
  expect(state.lessonsOf("first")).toEqual([state.firstLesson]);
  await expectAccount(page, accounts.second, state.privateIds.second);
});

test("signing out and back in resumes the same lesson; signing in as another account never shows it or its download", async ({
  page,
}) => {
  const state = await serveAccounts(page);
  state.signedInAs("first");
  await page.goto(state.url);
  await expect(heading(page)).toHaveText("Stay with me");
  await expect.poll(() => lessonParam(page)).toBe(state.firstLesson.lessonId);
  await exitStudy(page);
  // Leaving Study drops its lesson link; sign-out is only reachable after that.
  expect(lessonParam(page)).toBeNull();
  await openSettings(page);
  await expect(
    page.getByRole("button", { name: "Download private history", exact: true }),
  ).toBeVisible();
  await expectAccount(page, accounts.first, state.privateIds.first);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download private history", exact: true }),
  ).toHaveCount(0);
  // Same account again: the lesson in progress is resumed, not replaced.
  state.walletIs("first");
  await signIn(page);
  await startStudy(page);
  await expect(heading(page)).toHaveText("Stay with me");
  await expect.poll(() => lessonParam(page)).toBe(state.firstLesson.lessonId);
  expect(state.counts.starts).toBe(0);
  expect(state.counts.abandons).toBe(0);
  // Another account: no stale download, and Study opens its own lesson.
  await exitStudy(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  state.walletIs("second");
  await signIn(page);
  await expectAccount(page, accounts.second, state.privateIds.second);
  // No download is offered for the previous account, and with nothing else
  // to offer the settings menu is not shown.
  await expect(
    page.getByRole("button", { name: "Download private history", exact: true }),
  ).toHaveCount(0);
  await startStudy(page);
  await expect(heading(page)).toHaveText("Hold me close");
  const own = state.lessonsOf("second");
  expect(own).toHaveLength(1);
  await expect.poll(() => lessonParam(page)).toBe(own[0].lessonId);
  expect(state.counts.foreign).toBe(0);
  expect(state.counts.refusedAccount).toBe(0);
  expect(state.lessonsOf("first")).toEqual([state.firstLesson]);
});

test("a temporary session-check failure keeps the current lesson and its link", async ({
  page,
}) => {
  const state = await serveAccounts(page);
  state.signedInAs("first");
  const link = state.lessonUrl(state.firstLesson.lessonId);
  await page.goto(link);
  await expect(heading(page)).toHaveText("Stay with me");
  // One failed session read on reload: the page looks signed out, but the
  // lesson link survives and nothing is abandoned or restarted.
  state.failSessionChecks(1);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }).first(),
  ).toBeVisible();
  await expect(
    studyOverlay(page).getByRole("heading", {
      name: "Sign in to study",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    studyOverlay(page).getByRole("button", { name: "Record", exact: true }),
  ).toHaveCount(0);
  expect(page.url()).toBe(link);
  // Recovering in place by signing in resumes the same lesson.
  state.walletIs("first");
  await signIn(page);
  await expect(heading(page)).toHaveText("Stay with me");
  expect(lessonParam(page)).toBe(state.firstLesson.lessonId);
  // A later failed read followed by a plain reload also resumes it.
  state.failSessionChecks(1);
  await page.reload();
  await expect(
    studyOverlay(page).getByRole("heading", {
      name: "Sign in to study",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    studyOverlay(page).getByRole("button", { name: "Record", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(heading(page)).toHaveText("Stay with me");
  expect(lessonParam(page)).toBe(state.firstLesson.lessonId);
  expect(state.counts.starts).toBe(0);
  expect(state.counts.abandons).toBe(0);
  expect(state.counts.foreign).toBe(0);
  expect(state.lessonsOf("second")).toHaveLength(0);
});

test("a link to an ended lesson opens a new lesson instead", async ({
  page,
}) => {
  const state = await serveAccounts(page);
  state.expireFirstLesson();
  state.signedInAs("first");
  await page.goto(state.lessonUrl(state.firstLesson.lessonId));
  await expect(heading(page)).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Expired Study session", exact: true }),
  ).toHaveCount(0);
  expect(state.counts.starts).toBe(1);
  expect(state.counts.abandons).toBe(0);
  expect(
    state.lessonsOf("first").some((lesson) => lesson.status === "expired"),
  ).toBe(true);
});

test("saved history after exit refuses a late response from the prior private account without new lesson work", async ({
  page,
}) => {
  const state = await serveAccounts(page);
  state.signedInAs("first");
  await page.goto(state.lessonUrl(state.firstLesson.lessonId));
  await expect(heading(page)).toHaveText("Stay with me");
  await exitStudy(page);
  await openSettings(page);
  await expectAccount(page, accounts.first, state.privateIds.first);
  state.holdHistory();
  let downloads = 0;
  page.on("download", () => {
    downloads++;
  });
  const response = page.waitForResponse((value) =>
    value.url().endsWith("/history"),
  );
  await page
    .getByRole("button", { name: "Download private history", exact: true })
    .click();
  await expect.poll(state.historyRequests).toBe(1);
  state.signedInAs("second");
  state.releaseHistory();
  await (await response).finished();
  await expect(page.getByRole("alert")).toHaveText(
    "Private history could not be downloaded. Try again.",
  );
  expect(downloads).toBe(0);
  await expect(
    page.getByRole("button", { name: "Download private history", exact: true }),
  ).toHaveCount(0);
  expect(state.counts.starts).toBe(0);
  expect(state.counts.abandons).toBe(0);
  expect(state.lessonsOf("first")).toEqual([state.firstLesson]);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expectAccount(page, accounts.second, state.privateIds.second);
  await expect(
    page.getByRole("button", { name: "Download private history", exact: true }),
  ).toHaveCount(0);
  expect(state.counts.starts).toBe(0);
});
