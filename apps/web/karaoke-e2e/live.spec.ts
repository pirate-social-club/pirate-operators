import { expect, test, type Page } from "@playwright/test";

// The live community page, its Sing screen and the real application, operator,
// simulated provider and local chain behind it (karaoke-e2e/live-host.ts).
test.describe.configure({ mode: "serial" });

interface ReadAttempt {
  attemptId: string;
  verified: boolean;
  problems: string[];
  songKey: string;
  lines: { lineId: string; status: string; scoreBps: number | null }[];
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
const linesStat = async (page: Page) => {
  const text = await page
    .getByRole("region", { name: "Results" })
    .getByText(/^\d+ of \d+$/)
    .innerText();
  const [sung, total] = text.split(" of ").map(Number);
  return { sung: sung!, total: total! };
};

test("a learner sings the published song and saves the score to the learning record", async ({
  page,
}) => {
  test.setTimeout(180000);
  await signIn(page, 5);
  await openSong(page);
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 90000,
  });
  const { sung, total } = await linesStat(page);
  expect(total).toBe(23);
  expect(sung).toBeGreaterThan(18);

  await page.getByRole("button", { name: "Save your score" }).click();
  await expect(page.getByText("Saved to your learning record.")).toBeVisible({
    timeout: 90000,
  });
  const manifest = await fixture<{ lines: { lineId: string }[] }>(
    page,
    "/__fixture/manifest",
  );
  const [record] = await fixture<ReadAttempt[]>(
    page,
    "/__fixture/records?learner=5",
  );
  expect(record?.verified, record?.problems.join(", ")).toBe(true);
  // The published song's own line IDs, graded and on chain.
  expect(record!.lines.map((l) => l.lineId)).toEqual(
    manifest.lines.map((l) => l.lineId),
  );
  expect(record!.lines.filter((l) => l.status === "assessed")).toHaveLength(
    sung,
  );
  expect(record!.lines.some((l) => (l.scoreBps ?? 0) >= 9000)).toBe(true);
});

test("a reload resumes the open take where the song is and still scores it", async ({
  page,
}) => {
  test.setTimeout(180000);
  await signIn(page, 6);
  await openSong(page);
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect
    .poll(() => songMs(page), { timeout: 30000 })
    .toBeGreaterThan(6500);
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await openSong(page);
  await page.getByRole("button", { name: "Start karaoke" }).click();
  // Resumed at the take's elapsed time on the operator's clock, not from zero.
  await expect
    .poll(() => songMs(page), { timeout: 15000 })
    .toBeGreaterThan(7000);
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 90000,
  });
  const { sung, total } = await linesStat(page);
  expect(total).toBe(23);
  // Lines sung before the reload were heard; the rest of the take was silent.
  expect(sung).toBeGreaterThan(2);
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
  ).toBeVisible();
});
