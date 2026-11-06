import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
declare global {
  interface Window {
    __studySounds: string[];
  }
}
const lineTexts = [
  "Hold me close",
  "Stay with me",
  "Walk into the light",
  "Keep the fire bright",
];
async function record(page: Page, durationMs = 1100) {
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  if (durationMs > 0) await page.waitForTimeout(durationMs); // Intentional real capture duration, not a readiness wait.
  await page.getByRole("button", { name: "Stop", exact: true }).click();
}
async function setHeard(request: APIRequestContext, text: string) {
  await request.patch("/__fixture", { data: { heard: text } });
}
test.beforeEach(async ({ request, page }) => {
  await request.post("/__fixture", { data: {} });
  await page.addInitScript(() => {
    window.__studySounds = [];
    Object.defineProperty(window, "AudioContext", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(window, "webkitAudioContext", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(window, "Audio", {
      value: class {
        volume = 1;
        constructor(readonly source: string) {}
        play() {
          window.__studySounds.push(this.source);
          return Promise.resolve();
        }
      },
      configurable: true,
    });
  });
});
test("Stop submits, correct answers play feedback and advance; the lesson survives reload and completes", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(
    page.getByText(/ElevenLabs|pronunciation|accent|send my recording/i),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Check my answer|Next line/ }),
  ).toHaveCount(0);
  await record(page);
  await expect(page.getByRole("blockquote")).toHaveText(lineTexts[1]);
  expect(await page.evaluate(() => window.__studySounds)).toEqual([
    expect.stringContaining("/correct-"),
  ]);
  await page.reload();
  await expect(page.getByRole("blockquote")).toHaveText(lineTexts[1]);
  expect(await page.evaluate(() => window.__studySounds)).toEqual([]);
  for (const text of lineTexts.slice(1)) {
    await setHeard(request, text);
    await record(page);
    if (text !== lineTexts[3])
      await expect(page.getByRole("blockquote")).not.toHaveText(text);
  }
  await expect(
    page.getByRole("heading", { name: "Lesson complete" }),
  ).toBeVisible();
  await expect(
    page.getByText("4 of 4 lines matched on the first try."),
  ).toBeVisible();
  const state = await (await request.get("/__fixture")).json();
  expect(state.calls).toBe(4);
  expect(state.lesson.status).toBe("completed");
  expect(state.lesson.progress.presentations).toBe(4);
  expect(state.lesson.qualification).toBe("not_evaluated");
});
test("a miss has one Continue, returns after unseen lines and keeps its first-pass failure after reload", async ({
  page,
  request,
}) => {
  await setHeard(request, "unrelated words");
  await page.goto("/");
  await record(page);
  await expect(
    page.getByRole("heading", { name: "Incorrect", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("blockquote")).toHaveText(lineTexts[0]);
  await expect(
    page.getByText("unrelated words", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__studySounds)).toEqual([
    expect.stringContaining("/incorrect-"),
  ]);
  const missed = await (await request.get("/__fixture")).json();
  expect(missed.lesson.current.line.text).toBe(lineTexts[1]);
  expect(missed.attempts[0].grade.correct).toBe(false);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("blockquote")).toHaveText(lineTexts[1]);
  await page.reload();
  await expect(page.getByRole("blockquote")).toHaveText(lineTexts[1]);
  for (const text of lineTexts.slice(1)) {
    await setHeard(request, text);
    await record(page);
    await expect(page.getByRole("blockquote")).not.toHaveText(text);
  }
  await expect(page.getByRole("blockquote")).toHaveText(lineTexts[0]);
  await page.reload();
  await expect(page.getByRole("blockquote")).toHaveText(lineTexts[0]);
  await setHeard(request, lineTexts[0]);
  await record(page);
  await expect(
    page.getByRole("heading", { name: "Lesson complete" }),
  ).toBeVisible();
  await expect(
    page.getByText("3 of 4 lines matched on the first try."),
  ).toBeVisible();
  const state = await (await request.get("/__fixture")).json();
  expect(state.calls).toBe(5);
  expect(state.lesson.progress.firstPassCorrect).toBe(3);
  expect(
    state.attempts.filter(
      (a: { grade: { correct: boolean } }) => !a.grade.correct,
    ),
  ).toHaveLength(1);
  expect(state.lesson.qualification).toBe("not_evaluated");
});
test("lost submission response recovers the stored grade and queue without another provider call", async ({
  page,
  request,
}) => {
  await request.patch("/__fixture", { data: { lostResponse: true } });
  await page.goto("/");
  await record(page);
  await expect(page.getByRole("blockquote")).toHaveText(lineTexts[1]);
  await expect(page.getByRole("alert")).not.toBeVisible();
  const state = await (await request.get("/__fixture")).json();
  expect(state.calls).toBe(1);
  expect(state.attempts).toHaveLength(1);
  expect(state.lesson.progress.presentations).toBe(1);
  expect(await page.evaluate(() => window.__studySounds)).toEqual([
    expect.stringContaining("/correct-"),
  ]);
});
test("short capture and provider failures do not grade or advance; mobile and microphone denial remain usable", async ({
  page,
  request,
  browser,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await record(page, 0);
  await expect(page.getByRole("alert")).toHaveText(
    "Record for at least one second, then try again.",
  );
  let state = await (await request.get("/__fixture")).json();
  expect(state.calls).toBe(0);
  expect(state.attempts).toHaveLength(0);
  expect(state.lesson.progress.presentations).toBe(0);
  await request.patch("/__fixture", { data: { failure: "known_failed" } });
  await record(page);
  await expect(page.getByRole("alert")).toHaveText(
    "Speech is unavailable. Try again later.",
  );
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).not.toBeVisible();
  await request.patch("/__fixture", { data: { failure: "unknown" } });
  await record(page);
  await expect(
    page.getByText(/Recording is paused for this lesson/),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText(/Recording is paused for this lesson/),
  ).toBeVisible();
  state = await (await request.get("/__fixture")).json();
  expect(state.lesson.progress.presentations).toBe(0);
  expect(
    state.attempts.every((a: { grade: unknown }) => a.grade === null),
  ).toBe(true);
  expect(await page.evaluate(() => window.__studySounds)).toEqual([]);
  await request.post("/__fixture", { data: {} });
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
  await denied.getByRole("button", { name: "Record", exact: true }).click();
  await expect(denied.getByRole("alert")).toContainText("refused");
  await expect(
    denied.getByRole("button", { name: "Record", exact: true }),
  ).toBeEnabled();
  await context.close();
});
