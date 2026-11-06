import { expect, test } from "@playwright/test";
import { origin, serveStudy } from "./study-fixture.ts";
import { readFile } from "node:fs/promises";

test("an inconsistent disclosure cannot prompt a signature or start a Study lesson", async ({
  page,
}) => {
  const state = await serveStudy(page, { disclosureMismatch: true });
  await page.goto(state.url);
  await expect(page.getByRole("alert")).toHaveText(
    "This enrollment disclosure changed. Reload and try again.",
  );
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
  const disclosure = page.getByRole("dialog");
  await expect(
    disclosure.getByRole("link", { name: "Terms", exact: true }),
  ).toHaveAttribute("href", "/learning/v3/terms");
  await expect(
    disclosure.getByRole("link", { name: "Privacy", exact: true }),
  ).toHaveAttribute("href", "/learning/v3/privacy");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(page.getByRole("blockquote")).toBeVisible();
  const lessonId = new URL(page.url()).searchParams.get("lesson");
  await page.getByRole("button", { name: "Back to songs" }).click();
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
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect.poll(() => state.counts.enrollmentSubmissions).toBe(1);
  await page.getByRole("button", { name: "Back to songs" }).click();
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
  await expect(page.getByRole("blockquote")).toHaveText("Hold me close");
  expect(state.counts.starts).toBe(1);
  expect(state.counts.signatures).toBe(1);
  expect(state.counts.enrollmentSubmissions).toBe(1);
});

test("leaving Study while a wallet signature is pending prevents new enrollment or lesson dispatch", async ({
  page,
}) => {
  const state = await serveStudy(page, { delaySignature: true });
  await page.goto(state.url);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect.poll(() => state.counts.signatures).toBe(1);
  await page.getByRole("button", { name: "Back to songs" }).click();
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

test("a Study link survives sign-in, cancelled disclosure dispatches nothing, and reload keeps one lesson and grant", async ({
  page,
}) => {
  const state = await serveStudy(page, { anonymous: true });
  await page.goto(state.url);
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("dialog")).toContainText("Karaoke and Study");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Enrollment cancelled");
  expect(state.counts.starts).toBe(0);
  expect(state.counts.signatures).toBe(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(page.getByRole("blockquote")).toHaveText("Hold me close");
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeEnabled();
  expect(state.counts.starts).toBe(1);
  expect(state.counts.signatures).toBe(1);
  const lessonUrl = page.url();
  expect(new URL(lessonUrl).searchParams.get("lesson")).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("blockquote")).toHaveText("Hold me close");
  await expect(page).toHaveURL(lessonUrl);
  expect(state.counts.starts).toBe(1);
  expect(state.counts.enrollmentRequests).toBe(2);
  expect(state.counts.signatures).toBe(1);
  await page.getByRole("button", { name: "Back to songs" }).click();
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
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(state.counts.starts).toBe(1);
  await page.reload();
  await expect(page.getByRole("blockquote")).toHaveText("Hold me close");
  expect(state.counts.starts).toBe(1);
  expect(state.counts.enrollmentRequests).toBe(1);
  expect(state.counts.signatures).toBe(1);
});

test("Study completion distinguishes saved, pending and confirmed publication and preserves it on reload", async ({
  page,
}) => {
  const state = await serveStudy(page);
  await page.goto(state.url);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(page.getByRole("blockquote")).toBeVisible();
  state.complete();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Lesson complete" }),
  ).toBeVisible();
  await expect(
    page.getByText("3 of 4 lines matched on the first try."),
  ).toBeVisible();
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
