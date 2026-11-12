import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
declare global {
  interface Window {
    __studySounds: string[];
    __studyCapture: {
      nativeBytes: number;
      deliveredBytes: number;
      elapsedMs: number;
      stopped: boolean;
    };
    __restoreStudyCapture: () => void;
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
function studyPrompt(page: Page, text: string) {
  return page.getByRole("heading", { level: 2, name: text, exact: true });
}
function observeStudyRequests(page: Page) {
  const traffic = {
    starts: [] as { body: Record<string, unknown>; account?: string }[],
    startStatuses: [] as number[],
    attemptPosts: 0,
    audioPuts: 0,
  };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/study/lessons")
      traffic.starts.push({
        body: request.postDataJSON() as Record<string, unknown>,
        account: request.headers()["x-study-account"],
      });
    if (
      request.method() === "POST" &&
      /^\/api\/study\/lessons\/[^/]+\/attempts$/.test(path)
    )
      traffic.attemptPosts++;
    if (
      request.method() === "PUT" &&
      /^\/api\/study\/lessons\/[^/]+\/attempts\/[^/]+\/audio$/.test(path)
    )
      traffic.audioPuts++;
  });
  page.on("response", (response) => {
    if (
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/study/lessons"
    )
      traffic.startStatuses.push(response.status());
  });
  return traffic;
}
async function captureEvidence(page: Page, empty: boolean) {
  await page.evaluate((discardData) => {
    const prototype = MediaRecorder.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "addEventListener",
    );
    const add: EventTarget["addEventListener"] = prototype.addEventListener;
    const evidence = {
      nativeBytes: 0,
      deliveredBytes: 0,
      elapsedMs: 0,
      stopped: false,
    };
    window.__studyCapture = evidence;
    let startedAt = 0;
    // The actual native recorder still captures and emits events. Only the
    // empty-input case drops its bytes before the real source recorder sees them.
    Object.defineProperty(prototype, "addEventListener", {
      configurable: true,
      value(
        this: MediaRecorder,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type !== "dataavailable" || !listener)
          return add.call(this, type, listener, options);
        add.call(this, "start", () => (startedAt = performance.now()), {
          once: true,
        });
        add.call(
          this,
          "stop",
          () => {
            evidence.elapsedMs = performance.now() - startedAt;
            evidence.stopped = true;
          },
          { once: true },
        );
        return add.call(
          this,
          type,
          (event) => {
            const native = event as BlobEvent;
            evidence.nativeBytes += native.data.size;
            const delivered = discardData
              ? new BlobEvent("dataavailable", { data: new Blob([]) })
              : native;
            evidence.deliveredBytes += delivered.data.size;
            if (typeof listener === "function") listener.call(this, delivered);
            else listener.handleEvent(delivered);
          },
          options,
        );
      },
    });
    window.__restoreStudyCapture = () => {
      if (descriptor)
        Object.defineProperty(prototype, "addEventListener", descriptor);
      else Reflect.deleteProperty(prototype, "addEventListener");
    };
  }, empty);
  try {
    await record(page, 500); // Intentional subsecond native capture, not readiness.
    await expect
      .poll(() => page.evaluate(() => window.__studyCapture.stopped))
      .toBe(true);
    return await page.evaluate(() => ({ ...window.__studyCapture }));
  } finally {
    await page.evaluate(() => window.__restoreStudyCapture());
  }
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
  await expect(studyPrompt(page, lineTexts[1])).toBeVisible();
  expect(await page.evaluate(() => window.__studySounds)).toEqual([
    expect.stringContaining("/correct-"),
  ]);
  await page.reload();
  await expect(studyPrompt(page, lineTexts[1])).toBeVisible();
  expect(await page.evaluate(() => window.__studySounds)).toEqual([]);
  for (const text of lineTexts.slice(1)) {
    await setHeard(request, text);
    await record(page);
    if (text !== lineTexts[3]) {
      await expect(studyPrompt(page, text)).toHaveCount(0);
      await expect(
        studyPrompt(page, lineTexts[lineTexts.indexOf(text) + 1]),
      ).toBeVisible();
    }
  }
  await expect(
    page.getByRole("heading", { name: "Outstanding!" }),
  ).toBeVisible();
  await expect(page.getByText("4/4", { exact: true })).toBeVisible();
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
    page
      .locator('[data-study-result="incorrect"]')
      .getByText("Incorrect", { exact: true }),
  ).toBeVisible();
  await expect(studyPrompt(page, lineTexts[0])).toBeVisible();
  await expect(page.locator("[data-heard-transcript]")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toHaveCount(0);
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
  await expect(studyPrompt(page, lineTexts[1])).toBeVisible();
  await page.reload();
  await expect(studyPrompt(page, lineTexts[1])).toBeVisible();
  for (const text of lineTexts.slice(1)) {
    await setHeard(request, text);
    await record(page);
    await expect(studyPrompt(page, text)).toHaveCount(0);
    await expect(
      studyPrompt(
        page,
        lineTexts[(lineTexts.indexOf(text) + 1) % lineTexts.length],
      ),
    ).toBeVisible();
  }
  await expect(studyPrompt(page, lineTexts[0])).toBeVisible();
  await page.reload();
  await expect(studyPrompt(page, lineTexts[0])).toBeVisible();
  await setHeard(request, lineTexts[0]);
  await record(page);
  await expect(
    page.getByRole("heading", { name: "Great work!" }),
  ).toBeVisible();
  await expect(page.getByText("3/4", { exact: true })).toBeVisible();
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
  await expect(studyPrompt(page, lineTexts[1])).toBeVisible();
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
  const traffic = observeStudyRequests(page);
  await page.goto("/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const empty = await captureEvidence(page, true);
  expect(empty.nativeBytes).toBeGreaterThan(0);
  expect(empty.deliveredBytes).toBe(0);
  await expect(page.getByRole("alert")).toHaveText(
    "The Study recording is empty or too large. Record a shorter answer.",
  );
  let state = await (await request.get("/__fixture")).json();
  expect(state.calls).toBe(0);
  expect(state.attempts).toHaveLength(0);
  expect(state.lesson.progress.presentations).toBe(0);
  expect(state.lesson.progress.firstPassGraded).toBe(0);
  expect(state.lesson.current.line.text).toBe(lineTexts[0]);
  expect(traffic.attemptPosts).toBe(0);
  expect(traffic.audioPuts).toBe(0);
  const short = await captureEvidence(page, false);
  expect(short.nativeBytes).toBeGreaterThan(0);
  expect(short.deliveredBytes).toBe(short.nativeBytes);
  expect(short.elapsedMs).toBeGreaterThan(0);
  expect(short.elapsedMs).toBeLessThan(1000);
  await expect(page.getByRole("alert")).toHaveText(
    "Record for at least one second, then try again.",
  );
  state = await (await request.get("/__fixture")).json();
  expect(state.calls).toBe(0);
  expect(state.attempts).toHaveLength(0);
  expect(state.lesson.progress.presentations).toBe(0);
  expect(state.lesson.progress.firstPassGraded).toBe(0);
  expect(state.lesson.current.line.text).toBe(lineTexts[0]);
  expect(traffic.attemptPosts).toBe(0);
  expect(traffic.audioPuts).toBe(0);
  await request.patch("/__fixture", { data: { failure: "known_failed" } });
  await record(page);
  await expect(page.getByRole("alert")).toHaveText(
    "The speech service declined that recording. Record a new answer.",
  );
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeEnabled();
  const refused = await (await request.get("/__fixture")).json();
  expect(refused.calls).toBe(1);
  expect(refused.attempts).toHaveLength(1);
  expect(refused.attempts[0].grade).toBeNull();
  expect(refused.lesson.progress.presentations).toBe(0);
  expect(refused.lesson.current.line.text).toBe(lineTexts[0]);
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

test("a lesson has no time limit, and a paused lesson keeps its history when Study again opens a new one", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeVisible();
  const first = (await (await request.get("/__fixture")).json()).lesson;
  // Days later the same lesson resumes; nothing expires it.
  await request.patch("/__fixture", { data: { advanceMs: 3 * 86400000 } });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Lesson expired" }),
  ).not.toBeVisible();
  const resumed = (await (await request.get("/__fixture")).json()).lesson;
  expect(resumed.lessonId).toBe(first.lessonId);
  expect(
    (await (await request.get("/api/study/lessons/" + first.lessonId)).json())
      .status,
  ).toBe("active");
  const second = resumed;
  await request.patch("/__fixture", { data: { failure: "unknown" } });
  await record(page);
  await expect(
    page.getByText(/Recording is paused for this lesson/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Study again" }).click();
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeVisible();
  const ended = await (
    await request.get("/api/study/lessons/" + second.lessonId)
  ).json();
  expect(ended.status).toBe("abandoned");
  expect(ended.progress.firstPassGraded).toBe(0);
  expect((await (await request.get("/__fixture")).json()).calls).toBe(1);
});

test("a legacy one-hour lesson still expires at its deadline and reopening Study starts a new lesson", async ({
  page,
  request,
}) => {
  const { lessonId } = await (
    await request.patch("/__fixture", { data: { legacyLesson: true } })
  ).json();
  await page.goto("/?lesson=" + lessonId);
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeVisible();
  await request.patch("/__fixture", { data: { advanceMs: 3600000 } });
  await page.reload();
  // The closed lesson is never shown again: a new lesson opens directly.
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Lesson expired" }),
  ).toHaveCount(0);
  const expired = await (
    await request.get("/api/study/lessons/" + lessonId)
  ).json();
  expect(expired.status).toBe("expired");
  expect(expired.completionReason).toBe("deadline");
  expect(expired.completedAt).toBe(expired.expiresAt);
  const next = (await (await request.get("/__fixture")).json()).lesson;
  expect(next.lessonId).not.toBe(lessonId);
  expect(next.status).toBe("active");
  expect(next.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
});

test("a draft never bound to consent ends after thirty days and the learner starts a new lesson", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeVisible();
  const first = (await (await request.get("/__fixture")).json()).lesson;
  // The loopback host never binds consent, so its lessons are drafts. A bound
  // lesson instead closes when its consent ends; Node tests cover that.
  await request.patch("/__fixture", {
    data: { advanceMs: 30 * 86400000 - 1000 },
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeVisible();
  await request.patch("/__fixture", { data: { advanceMs: 1000 } });
  await page.reload();
  // The closed draft is never shown again: a new lesson opens directly.
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lesson ended" })).toHaveCount(
    0,
  );
  const ended = await (
    await request.get("/api/study/lessons/" + first.lessonId)
  ).json();
  expect(ended.status).toBe("abandoned");
  expect(ended.completionReason).toBe("never_bound");
  expect(ended.completedAt).toBe(first.startedAt + 30 * 86400000);
  expect(
    (await (await request.get("/__fixture")).json()).lesson.lessonId,
  ).not.toBe(first.lessonId);
});

test("another account opening a lesson link gets its own lesson, never the first account's", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await setHeard(request, lineTexts[0]);
  await record(page);
  await expect(studyPrompt(page, lineTexts[1])).toBeVisible();
  const first = (await (await request.get("/__fixture")).json()).lesson;
  expect(new URL(page.url()).searchParams.get("lesson")).toBe(first.lessonId);
  // The cookie now belongs to the second account; the old link is reopened.
  await request.patch("/__fixture", { data: { account: "second" } });
  await page.reload();
  await expect(studyPrompt(page, lineTexts[0])).toBeVisible();
  const second = await (await request.get("/__fixture")).json();
  expect(second.account).toBe("0x" + "b8".repeat(20));
  expect(second.lesson.lessonId).not.toBe(first.lessonId);
  expect(second.lesson.progress.presentations).toBe(0);
  expect(second.attempts).toHaveLength(0);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("lesson"))
    .toBe(second.lesson.lessonId);
  // The first account's lesson is untouched and still its own.
  await request.patch("/__fixture", { data: { account: "first" } });
  const kept = (await (await request.get("/__fixture")).json()).lesson;
  expect(kept.lessonId).toBe(first.lessonId);
  expect(kept.status).toBe("active");
  expect(kept.progress.presentations).toBe(1);
});

test("a page left open when the session changes account clears its lesson instead of acting on it", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeVisible();
  await expect(studyPrompt(page, lineTexts[0])).toBeVisible();
  const first = (await (await request.get("/__fixture")).json()).lesson;
  await request.patch("/__fixture", { data: { account: "second" } });
  await record(page);
  await expect(
    page.getByText(
      "You are signed in with a different account. Reload to continue.",
    ),
  ).toBeVisible();
  for (const text of lineTexts)
    await expect(studyPrompt(page, text)).toHaveCount(0);
  await expect(page.locator("[data-heard-transcript]")).toHaveCount(0);
  await expect(page.locator("[data-study-result]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^(Record|Stop|Continue)$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toHaveCount(0);
  const state = await (await request.get("/__fixture")).json();
  expect(state.calls).toBe(0);
  expect(state.lesson).toBeNull();
  await request.patch("/__fixture", { data: { account: "first" } });
  const kept = (await (await request.get("/__fixture")).json()).lesson;
  expect(kept.lessonId).toBe(first.lessonId);
  expect(kept.status).toBe("active");
  expect(kept.progress.presentations).toBe(0);
  expect(
    (await (await request.get("/__fixture")).json()).attempts,
  ).toHaveLength(0);
});
test("a start refused while sign-in is being recorded retries the same request in the loading state", async ({
  page,
  request,
}) => {
  await request.patch("/__fixture", { data: { authorizationPending: 2 } });
  const traffic = observeStudyRequests(page);
  await page.goto("/");
  // Two refusals, two seconds apart, then the same request starts the lesson.
  await expect(
    page.getByRole("button", { name: "Record", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await expect(
    page.getByRole("heading", { name: "Study unavailable", exact: true }),
  ).toHaveCount(0);
  const state = await (await request.get("/__fixture")).json();
  expect(state.starts).toBe(3);
  expect(state.lesson.status).toBe("active");
  expect(state.calls).toBe(0);
  expect(state.attempts).toHaveLength(0);
  expect(traffic.starts).toHaveLength(3);
  expect(traffic.startStatuses).toEqual([409, 409, 201]);
  const originalStart = traffic.starts[0]!;
  expect(originalStart.body.requestId).toEqual(expect.any(String));
  expect(originalStart.body.requestId).not.toBe("");
  for (const start of traffic.starts) {
    expect(start.body).toEqual(originalStart.body);
    expect(start.account).toBe(state.account);
  }
  expect(traffic.attemptPosts).toBe(0);
  expect(traffic.audioPuts).toBe(0);
});
test("the pending-sign-in retry is bounded and then shows the existing failure", async ({
  page,
  request,
}) => {
  await request.patch("/__fixture", { data: { authorizationPending: 99 } });
  const traffic = observeStudyRequests(page);
  await page.clock.install();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Study unavailable", exact: true }),
  ).toBeVisible({
    timeout: 20000,
  });
  await expect(
    page.getByRole("button", { name: "Try Again", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Go Home", exact: true }),
  ).toBeEnabled();
  // Cross one configured 2000ms retry window after failure, rather than waiting
  // for readiness or issuing a new start ourselves.
  await page.clock.runFor(2000);
  const state = await (await request.get("/__fixture")).json();
  expect(state.starts).toBe(5);
  expect(state.lesson).toBeNull();
  expect(state.calls).toBe(0);
  expect(state.attempts).toHaveLength(0);
  expect(new URL(page.url()).searchParams.get("lesson")).toBeNull();
  expect(traffic.starts).toHaveLength(5);
  expect(traffic.startStatuses).toEqual([409, 409, 409, 409, 409]);
  const originalStart = traffic.starts[0]!;
  expect(originalStart.body.requestId).toEqual(expect.any(String));
  expect(originalStart.body.requestId).not.toBe("");
  for (const start of traffic.starts) {
    expect(start.body).toEqual(originalStart.body);
    expect(start.account).toBe(state.account);
  }
  expect(traffic.attemptPosts).toBe(0);
  expect(traffic.audioPuts).toBe(0);
});
