import { expect, test, type Page } from "@playwright/test";

// The live community page, its Sing screen and the real application, operator,
// simulated provider and local chain behind it (karaoke-e2e/live-host.ts).
test.describe.configure({ mode: "serial" });

interface ReadAttempt {
  verified: boolean;
  problems: string[];
  lines: { ordinal: number; status: string; scoreBps: number | null }[];
}
const fixture = async <T>(page: Page, path: string) =>
  (await (await page.request.get(path)).json()) as T;
const songMs = (page: Page) =>
  page.evaluate(
    () =>
      (document.querySelector(".live-karaoke audio") as HTMLAudioElement)
        .currentTime * 1000,
  );

const consoleLines: string[] = [];
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const operator = await fixture(page, "/__fixture/operator").catch(() => null);
  console.log(
    `console:\n${consoleLines.join("\n")}\noperator: ${JSON.stringify(operator).slice(0, 4000)}`,
  );
});
async function signIn(page: Page, learner: number) {
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));
  page.on("response", async (r) => {
    if (r.status() >= 400)
      consoleLines.push(
        `http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}: ${(await r.text().catch(() => "")).slice(0, 200)}`,
      );
  });
  await page.goto(`/?learner=${learner}`);
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
}
async function openSong(page: Page) {
  await page.getByRole("button", { name: "Sing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start karaoke" })).toBeVisible(
    { timeout: 30000 },
  );
}
async function startEnrolledTake(page: Page) {
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function published(page: Page, learner: number) {
  await expect
    .poll(
      async () =>
        (
          await fixture<ReadAttempt[]>(
            page,
            `/__fixture/records?learner=${learner}`,
          )
        ).length,
      { timeout: 20000 },
    )
    .toBe(1);
  const [result] = await fixture<ReadAttempt[]>(
    page,
    `/__fixture/records?learner=${learner}`,
  );
  expect(result!.verified, result!.problems.join(", ")).toBe(true);
  expect(result!.lines).toHaveLength(23);
  return result!;
}
test("leaving while the wallet signs never submits enrollment or starts Karaoke", async ({
  page,
}) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signing = false,
    submissions = 0,
    tickets = 0;
  await page.route("**/__fixture/sign", async (route) => {
    const input = route.request().postDataJSON();
    if (input.kind === "typed" && input.data?.primaryType === "Enrollment") {
      signing = true;
      await wait;
    }
    await route.continue();
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/api/karaoke/tickets")) tickets++;
    if (
      request.url().endsWith("/api/karaoke/enrollment") &&
      request.postDataJSON()?.signature
    )
      submissions++;
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 7);
    await openSong(page);
    const policies = page.getByRole("navigation", { name: "Karaoke policies" });
    await expect(
      policies.getByRole("link", { name: "Terms", exact: true }),
    ).toBeVisible();
    const box = await policies.boundingBox();
    const start = await page
      .getByRole("button", { name: "Start karaoke" })
      .boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(start!.y + start!.height);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    await page.screenshot({
      path: test.info().outputPath("direct-enrollment-mobile.png"),
    });
    await page.getByRole("button", { name: "Start karaoke" }).click();
    await expect.poll(() => signing).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      policies.getByRole("link", { name: "Terms", exact: true }),
    ).toHaveAttribute("href", "/terms");
    await page.getByRole("button", { name: "Exit karaoke" }).click();
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/__fixture/sign"),
    );
    release();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(submissions).toBe(0);
    expect(tickets).toBe(0);
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  } finally {
    release();
  }
});

test("a learner sings the published song and gets one automatic terminal publication", async ({
  page,
}) => {
  test.setTimeout(180000);
  await signIn(page, 5);
  await openSong(page);
  await startEnrolledTake(page);
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 90000,
  });
  await expect(
    page.getByRole("region", { name: "Results" }).locator("dt"),
  ).toHaveText(["Lyrics", "Timing", "Best combo"]);
  await expect(
    page.getByRole("button", { name: "Save your score" }),
  ).toHaveCount(0);
  const manifest = await fixture<{ lines: { ordinal: number }[] }>(
    page,
    "/__fixture/manifest",
  );
  const record = await published(page, 5);
  // The published song's own line IDs, graded and on chain.
  expect(record!.lines.map((l) => l.ordinal)).toEqual(
    manifest.lines.map((l) => l.ordinal),
  );
  expect(
    record!.lines.filter((l) => l.status === "assessed").length,
  ).toBeGreaterThan(18);
  expect(record!.lines.some((l) => (l.scoreBps ?? 0) >= 9000)).toBe(true);
});

test("a reload resumes the open take where the song is and still scores it", async ({
  page,
}) => {
  test.setTimeout(180000);
  await signIn(page, 6);
  await openSong(page);
  await startEnrolledTake(page);
  await expect
    .poll(() => songMs(page), { timeout: 30000 })
    .toBeGreaterThan(6500);
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await openSong(page);
  // The old page is gone and no new capture has started. Retained grades alone
  // cannot prove that this fresh page's audio is accepted by the same take.
  const paused = await fixture<{
    attempts: { ticketId: string; ended: unknown | null }[];
    audio: { ticketId: string; lastSequence: number }[];
  }>(page, "/__fixture/operator");
  const active = paused.attempts.filter((attempt) => attempt.ended === null);
  expect(active).toHaveLength(1);
  const cursor = paused.audio.find(
    (row) => row.ticketId === active[0].ticketId,
  )!;
  expect(cursor).toBeTruthy();
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect
    .poll(
      async () => {
        const current = await fixture<{
          audio: { ticketId: string; lastSequence: number }[];
        }>(page, "/__fixture/operator");
        return (
          current.audio.find((row) => row.ticketId === cursor.ticketId)
            ?.lastSequence ?? 0
        );
      },
      { timeout: 5000 },
    )
    .toBeGreaterThan(cursor.lastSequence);
  // Resumed at the take's elapsed time on the operator's clock, not from zero.
  await expect
    .poll(() => songMs(page), { timeout: 15000 })
    .toBeGreaterThan(7000);
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 90000,
  });
  const record = await published(page, 6);
  // Audio after reload is accepted above. This simulated transcript assertion
  // separately preserves the grades already measured before reload.
  expect(
    record.lines.filter((line) => line.status === "assessed").length,
  ).toBeGreaterThan(2);
  const operator = await fixture<{
    attempts: { generation: number; ended: { status: string } | null }[];
  }>(page, "/__fixture/operator");
  expect(
    operator.attempts.some(
      (a) => a.generation >= 2 && a.ended?.status === "completed",
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Save your score" }),
  ).toHaveCount(0);
});
