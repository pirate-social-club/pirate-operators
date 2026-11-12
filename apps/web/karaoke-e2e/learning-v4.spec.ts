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

// A V4 community (karaoke-e2e/live-host.ts with KARAOKE_RESULTS_V4=1): the
// learner's one sign-in is the publication permission. A take starts with no
// further signature, no enrollment request and no policy link on the exercise
// surface; the Terms and Privacy documents stay in normal site navigation.
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    console.log(
      JSON.stringify(
        await (await page.request.get("/__fixture/operator")).json(),
      ).slice(0, 8000),
    );
});

test("a V4 take starts with no signature request and no policy link on the exercise surface", async ({
  page,
}) => {
  const signatures: string[] = [];
  let enrollmentRequests = 0;
  page.on("dialog", () => {
    throw new Error("Native browser alerts are not part of the Karaoke design");
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/__fixture/sign") {
      const input = request.postDataJSON();
      // The V4 sign-in is a SIWE text that names the V4 policy; it is
      // recorded as "SignIn".
      if (input.kind !== "address")
        signatures.push(
          input.kind === "typed"
            ? input.data?.primaryType
            : input.kind === "message" &&
                / wants you to sign in with your Ethereum account:\n/.test(
                  String(input.message),
                ) &&
                String(input.message).includes(
                  "\n- urn:pirate:publication-policy:4:0x",
                )
              ? "SignIn"
              : input.kind,
        );
    }
    if (path.startsWith("/api/karaoke/enrollment")) enrollmentRequests++;
  });
  await page.goto("/?learner=5");
  const documents = page.getByRole("navigation", {
    name: "Community documents",
    exact: true,
  });
  await expect(
    documents.getByRole("link", { name: "Terms", exact: true }),
  ).toHaveAttribute("href", "/terms");
  await expect(
    documents.getByRole("link", { name: "Privacy", exact: true }),
  ).toHaveAttribute("href", "/privacy");
  // The V4 learning documents the sign-in accepts, beside them.
  await expect(
    documents.getByRole("link", { name: "Learning terms", exact: true }),
  ).toHaveAttribute("href", "/learning/v4/terms");
  await expect(
    documents.getByRole("link", { name: "Learning privacy", exact: true }),
  ).toHaveAttribute("href", "/learning/v4/privacy");
  await connectLearner(page, 5);
  // One sign-in, which is also the permission.
  expect(signatures).toEqual(["SignIn"]);
  await openPublishedKaraoke(page);
  await expect(page.getByRole("button", { name: "Start karaoke" })).toBeVisible(
    { timeout: 30000 },
  );
  const surface = page.locator(".live-karaoke-overlay");
  const footer = page.locator("footer").filter({
    has: page.locator('nav[aria-label="Community documents"]'),
  });
  await expect(footer).toHaveAttribute("inert", "");
  await expect(
    page.getByRole("navigation", { name: "Karaoke policies" }),
  ).toHaveCount(0);
  await expect(surface.getByRole("link")).toHaveCount(0);
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".karaoke-stage-rating")).toBeVisible({
    timeout: 30000,
  });
  await expect(surface.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 90000,
  });
  await expect(surface.getByRole("link")).toHaveCount(0);
  expect(signatures).toEqual(["SignIn"]);
  expect(enrollmentRequests).toBe(0);
  // The take is public under the sign-in's authorization.
  const [authorization] = (await (
    await page.request.get("/__fixture/authorizations?learner=5")
  ).json()) as { authorization_id: string; state: string }[];
  expect(authorization!.state).toBe("recorded");
  const records = async () =>
    (await (await page.request.get("/__fixture/records?learner=5")).json()) as {
      verified: boolean;
      problems: string[];
      enrollmentId: string;
      lines: { status: string }[];
    }[];
  await expect
    .poll(async () => (await records()).length, { timeout: 20000 })
    .toBe(1);
  const [record] = await records();
  expect(record!.verified, record!.problems.join(", ")).toBe(true);
  expect(record!.lines).toHaveLength(23);
  expect(record!.enrollmentId).toBe(authorization!.authorization_id);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(footer).not.toHaveAttribute("inert", "");
  for (const [name, href] of [
    ["Terms", "/terms"],
    ["Privacy", "/privacy"],
    ["Learning terms", "/learning/v4/terms"],
    ["Learning privacy", "/learning/v4/privacy"],
  ])
    await expect(
      documents.getByRole("link", { name, exact: true }),
    ).toHaveAttribute("href", href);
});
