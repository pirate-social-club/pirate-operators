import { test, expect, type Page } from "@playwright/test";

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

// The normal learning browser workflow includes this published-song regression.
test("Karaoke refresh restores the song and reuses the server take without a new publication", async ({
  page,
}) => {
  await page.goto("/?learner=10");
  await connectLearner(page, 10);
  await openPublishedKaraoke(page);
  await expect(page).toHaveURL(/[?&]sing=0x[0-9a-f]{64}/);
  const operator = async () =>
    (await (await page.request.get("/__fixture/operator")).json()) as {
      attempts: { attemptId: string }[];
    };
  const baseline = new Set(
    (await operator()).attempts.map((attempt) => attempt.attemptId),
  );
  await page
    .getByRole("button", { name: "Start karaoke", exact: true })
    .click();
  await expect(page.locator(".karaoke-stage-rating")).toBeVisible({
    timeout: 30000,
  });
  const added = (await operator()).attempts.filter(
    (attempt) => !baseline.has(attempt.attemptId),
  );
  expect(added).toHaveLength(1);
  const originalId = added[0].attemptId;
  await page.reload();
  // Route restoration is automatic; no second Sing tap after refresh.
  await expect(
    page.getByRole("button", { name: "Start karaoke", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page
    .getByRole("button", { name: "Start karaoke", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 90000,
  });
  const after = await operator();
  const resumed = after.attempts.filter(
    (attempt) => !baseline.has(attempt.attemptId),
  );
  expect(resumed).toHaveLength(1);
  expect(resumed[0].attemptId).toBe(originalId);
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/__fixture/records?learner=10")).json())
          .length,
    )
    .toBe(1);
  const events = (await (
    await page.request.get("/__fixture/result-events?learner=10")
  ).json()) as { sessionId: string; revision: number; verified: boolean }[];
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    sessionId: originalId,
    revision: 1,
    verified: true,
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]sing=/);
});
