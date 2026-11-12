import { expect, test, type Page } from "@playwright/test";

const learnerScopes = new WeakMap<Page, { learner: number; wallet: string }>();
async function assertLearnerSession(page: Page) {
  const expected = learnerScopes.get(page);
  expect(expected).toBeTruthy();
  expect(new URL(page.url()).searchParams.get("learner")).toBe(
    String(expected!.learner),
  );
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/session");
        const value = await response.json();
        return {
          status: response.status(),
          authenticated: value.authenticated,
          wallet: value.mossAddress?.toLowerCase(),
        };
      },
      { timeout: 20000 },
    )
    .toEqual({
      status: 200,
      authenticated: true,
      wallet: expected!.wallet,
    });
}
async function connectLearner(page: Page, learner: number) {
  expect(new URL(page.url()).searchParams.get("learner")).toBe(String(learner));
  const connected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/__fixture/sign" &&
      response.request().postDataJSON()?.kind === "address",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const response = await connected;
  expect(response.request().postDataJSON()).toEqual({
    learner: String(learner),
    kind: "address",
  });
  const { address } = await response.json();
  expect(address).toMatch(/^0x[0-9a-f]{40}$/i);
  learnerScopes.set(page, { learner, wallet: address.toLowerCase() });
  await expect(
    page.getByText("Signed in. Choose a song to study or sing.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 20000 });
  await assertLearnerSession(page);
}
async function rawFragmentContext(page: Page) {
  const owner = await documentOwner(page);
  const search = await page.evaluate(() => {
    // Seed literal encoded bytes without URLSearchParams normalization. Keep
    // every other query value, hash and history state in the same document.
    const current = location.search;
    const next = /[?&]filter=/.test(current)
      ? current.replace(/([?&])filter=[^&]*/, "$1filter=a%20b")
      : current + (current ? "&" : "?") + "filter=a%20b";
    history.replaceState(
      history.state,
      "",
      location.pathname + next + location.hash,
    );
    return location.search;
  });
  expect(search).toMatch(/[?&]filter=a%20b(?:&|$)/);
  expect(search).not.toContain("filter=a+b");
  expect(await documentOwner(page)).toBe(owner);
  return search;
}
async function documentOwner(page: Page) {
  return page.evaluate(() => {
    const value = window as unknown as { __karaokeDocument?: string };
    return (value.__karaokeDocument ??= crypto.randomUUID());
  });
}
async function openPublishedKaraoke(page: Page) {
  await assertLearnerSession(page);
  const document = await documentOwner(page);
  const rawSearch = await rawFragmentContext(page);
  const manifest = await (await page.request.get("/__fixture/manifest")).json();
  const postId = manifest.song.postId;
  expect(postId).toMatch(/^0x[0-9a-f]{64}$/i);
  if (new URL(page.url()).hash !== `#song-${postId}`) {
    if (new URL(page.url()).hash && new URL(page.url()).hash !== "#/")
      await page.getByRole("link", { name: "Home", exact: true }).click();
    expect(new URL(page.url()).search).toBe(rawSearch);
    expect(await documentOwner(page)).toBe(document);
    const feed = await (await page.request.get("/api/feed")).json();
    const selected = feed.posts.find(
      (post: { manifest: { postId: string } }) =>
        post.manifest.postId === postId,
    );
    expect(selected).toBeTruthy();
    const link = page
      .getByRole("link", { name: selected.manifest.title, exact: true })
      .and(page.locator(`a[href="/#song-${postId}"]`));
    await expect(link).toHaveCount(1);
    expect(new URL(page.url()).search).toBe(rawSearch);
    await link.click();
    expect(new URL(page.url()).search).toBe(rawSearch);
    expect(await documentOwner(page)).toBe(document);
  }
  const karaoke = page
    .getByRole("link", { name: "Karaoke", exact: true })
    .and(page.locator(`a[href="/?sing=${postId}"]`));
  await expect(karaoke).toHaveCount(1);
  await karaoke.click();
  expect(new URL(page.url()).searchParams.get("sing")).toBe(postId);
  expect(await documentOwner(page)).toBe(document);
  await assertLearnerSession(page);
}

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
  await connectLearner(page, learner);
}
async function openSong(page: Page) {
  await openPublishedKaraoke(page);
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
    // No policy links on the exercise surface; the documents stay in the
    // normal Community documents navigation.
    const surface = page.locator(".live-karaoke-overlay");
    await expect(
      page.getByRole("navigation", { name: "Karaoke policies" }),
    ).toHaveCount(0);
    await expect(surface.getByRole("link")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("direct-enrollment-mobile.png"),
    });
    await page.getByRole("button", { name: "Start karaoke" }).click();
    await expect.poll(() => signing).toBe(true);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(surface.getByRole("link")).toHaveCount(0);
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
    await assertLearnerSession(page);
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
  await assertLearnerSession(page);
  // The shell restores the direct Karaoke route on reload. Its overlay already
  // covers the background song action; resume this take instead of opening it again.
  await expect(
    page
      .locator(".live-karaoke-overlay")
      .getByRole("button", { name: "Start karaoke" }),
  ).toBeVisible({ timeout: 30000 });
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
