import { test, expect, type Page } from "@playwright/test";

async function record(page: Page) {
  await page
    .getByRole("button", { name: /Record answer|Record again/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop recording" }),
  ).toBeVisible();
  await page.waitForTimeout(500); // Capture several MediaRecorder chunks, not a readiness sleep.
  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect(
    page.getByRole("button", { name: "Check my answer" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check my answer" }).click();
}
test.beforeEach(async ({ request }) => {
  await request.post("/__fixture", { data: {} });
});
test("ordinary learner records an untimed line, reloads its real saved result and progresses", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Say it back" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record answer" }),
  ).toBeEnabled();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(
    page.getByText(/ElevenLabs|pronunciation|accent|send my recording/i),
  ).toHaveCount(0);
  await record(page);
  await expect(
    page.getByRole("heading", { name: "Matched", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Matched", exact: true }),
  ).toBeVisible();
  const state = await (await request.get("/__fixture")).json();
  expect(state.calls).toBe(1);
  expect(state.attempts).toHaveLength(1);
  expect(state.attempts[0].qualification).toBe("not_evaluated");
  await page.getByRole("button", { name: "Next line" }).click();
  await expect(page.getByRole("blockquote")).toHaveText("Stay with me");
  await expect(
    page.getByRole("heading", { name: "Matched", exact: true }),
  ).not.toBeVisible();
});
test("misses allow progression and stay wrong; provider failure stays unscored after reload", async ({
  page,
  request,
}) => {
  await request.post("/__fixture", { data: { heard: "unrelated words" } });
  await page.goto("/");
  await record(page);
  await expect(
    page.getByRole("heading", { name: "Try again", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next line" }).click();
  await expect(page.getByRole("blockquote")).toHaveText("Stay with me");
  await expect(
    page.getByRole("heading", { name: "Try again", exact: true }),
  ).not.toBeVisible();
  const missed = await (await request.get("/__fixture")).json();
  expect(missed.attempts).toHaveLength(1);
  expect(missed.attempts[0].grade.correct).toBe(false);
  expect(missed.attempts[0].qualification).toBe("not_evaluated");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Try again", exact: true }),
  ).toBeVisible();
  await request.post("/__fixture", { data: { failure: true } });
  await page.reload();
  await record(page);
  await expect(
    page.getByText(
      "This answer could not be assessed. You can record another answer.",
    ),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText(
      "This answer could not be assessed. You can record another answer.",
    ),
  ).toBeVisible();
  const state = await (await request.get("/__fixture")).json();
  expect(state.attempts[0].grade).toBeNull();
  await expect(
    page.getByRole("button", { name: "Next line" }),
  ).not.toBeVisible();
});
test("lost submission response reuses the same recording without a duplicate assessment", async ({
  page,
  request,
}) => {
  await request.post("/__fixture", { data: { lostResponse: true } });
  await page.goto("/");
  await record(page);
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Check my answer" }).click();
  await expect(
    page.getByRole("heading", { name: "Matched", exact: true }),
  ).toBeVisible();
  const state = await (await request.get("/__fixture")).json();
  expect(state.calls).toBe(1);
  expect(state.attempts).toHaveLength(1);
});
test("mobile layout fits and denied microphone permission produces a recoverable message", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const context = await browser.newContext({ permissions: [] }),
    denied = await context.newPage();
  await denied.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException(
        "Microphone access was refused.",
        "NotAllowedError",
      );
    };
  });
  await denied.goto("http://127.0.0.1:4177/");
  await denied.getByRole("button", { name: "Record answer" }).click();
  await expect(denied.getByRole("alert")).toContainText("refused");
  await expect(
    denied.getByRole("button", { name: "Record answer" }),
  ).toBeEnabled();
  await context.close();
});
