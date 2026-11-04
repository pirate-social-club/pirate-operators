// Canonical mode on the FIXTURE canonical host (scripts/fixture-host.ts). This
// checks the client's canonical behaviour and the generated host headers; it
// is not an acceptance of Cloudflare or of the community service.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { FIXTURE_CANONICAL_ORIGIN, fixtureCommunity } from "../src/fixture/site.ts";
import { observe } from "./helpers.ts";

const origin = FIXTURE_CANONICAL_ORIGIN;
const scenario = (request: APIRequestContext, name: string) => request.post(`${origin}/__fixture/scenario?name=${name}`);

test.afterEach(async ({ request }) => { await scenario(request, "normal"); });

test("primary responses carry the contract security headers", async ({ request }) => {
  const response = await request.get(`${origin}/posts/first-song/`);
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  expect(headers["strict-transport-security"]).toBeDefined();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toBe("microphone=(self)");
  expect((await request.get(`${origin}/posts/withdrawn-post/`)).status()).toBe(410);
});

test("canonical mode checks the session without blocking public content", async ({ context, page, request }) => {
  await scenario(request, "session-slow");
  const seen = await observe(context, page);
  await page.goto(`${origin}/posts/first-song/`);
  await expect(page.locator("header[data-mode]")).toHaveAttribute("data-mode", "canonical");
  await expect(page.locator("#public-content h1")).toHaveText("A first song for the fixture community");
  await expect(page.locator('button[data-action="sign-in"]')).toBeDisabled();
  await expect(page.locator("[data-session]")).toHaveAttribute("data-session", "checking");
  expect(seen.requests.some(url => url.endsWith("/api/session"))).toBe(true);
  expect(await seen.violations()).toEqual([]);
});

test("the API being down leaves published and snapshot content readable", async ({ page, request }) => {
  await scenario(request, "api-down");
  await page.goto(`${origin}/posts/first-song/`);
  await expect(page.locator("#public-content h1")).toHaveText("A first song for the fixture community");
  await expect(page.locator("[data-session]")).toHaveAttribute("data-session", "unavailable");
  await page.locator('header nav a[href="/"]').click();
  await expect(page.locator('[data-content="community"]')).toBeVisible();
});

test("a stale generated page is replaced by the current record after mount", async ({ page, request }) => {
  await scenario(request, "stale");
  await page.goto(`${origin}/posts/first-song/`);
  await expect(page.locator('[data-notice="updated"]')).toBeVisible();
  await expect(page.locator("#public-content")).toContainText("FIXTURE: this body changed after publication.");
});

test("a post removed after publication shows the removal notice", async ({ page, request }) => {
  await scenario(request, "removed-after-publish");
  await page.goto(`${origin}/posts/first-song/`);
  await expect(page.locator('[data-content="removed"]')).toBeVisible();
  await expect(page.locator("#public-content")).not.toContainText("A first song");
  await expect(page.locator('[data-action="reply"]')).toHaveCount(0);
});

// Regressions from the 2026-11-04 review (pirate-web-static-release-review-20261104).

test("a removal observed from the API is kept when the API later fails", async ({ page, request }) => {
  await scenario(request, "removed-after-publish");
  await page.goto(`${origin}/posts/first-song/`);
  await expect(page.locator('[data-content="removed"]')).toBeVisible();
  await scenario(request, "api-down");
  await page.locator('header nav a[href="/"]').click();
  await expect(page.locator('[data-content="community"]')).toBeVisible();
  await page.locator('#public-content a[href="/posts/first-song/"]').click();
  await expect(page.locator('[data-content="removed"]')).toBeVisible();
  await expect(page.locator("#public-content")).not.toContainText("This post exists only to test publication-time HTML");
});

test("navigation renders known and snapshot content while the API stalls", async ({ page }) => {
  await page.goto(`${origin}/posts/first-song/`);
  await expect(page.locator('header nav a[href="/"]')).toHaveText("Fixture Community");
  const releases: Array<() => void> = [];
  await page.route("**/api/public/**", async route => {
    await new Promise<void>(resolve => releases.push(resolve));
    await route.abort().catch(() => undefined);
  });
  try {
    await page.locator('header nav a[href="/"]').click();
    await expect(page.locator("#public-content h1")).toHaveText("Fixture Community", { timeout: 1500 });
    // Never seen on this page: the snapshot answers while the API is held.
    await page.locator('#public-content a[href="/posts/arabic-note/"]').click();
    await expect(page.locator('[data-content="post"][data-slug="arabic-note"]')).toBeVisible({ timeout: 1500 });
  } finally {
    for (const release of releases) release();
  }
});

test("a fresher community record replaces the generated landing page", async ({ page }) => {
  const added = { slug: "new-song", title: "A newer fixture song", author: fixtureCommunity.posts[0].author, publishedAt: "2026-11-05T00:00:00.000Z" };
  await page.route("**/api/public/community", route => route.fulfill({
    json: { ...fixtureCommunity, revision: 2, name: "Updated fixture community", description: "Updated fixture description", posts: [fixtureCommunity.posts[1], added] },
  }));
  await page.goto(`${origin}/`);
  await expect(page.locator('header nav a[href="/"]')).toHaveText("Updated fixture community");
  await expect(page.locator("#public-content h1")).toHaveText("Updated fixture community", { timeout: 1500 });
  await expect(page.locator("#public-content")).toContainText("Updated fixture description");
  await expect(page.locator('#public-content a[href="/posts/new-song/"]')).toHaveCount(1);
  await expect(page.locator('#public-content a[href="/posts/first-song/"]')).toHaveCount(0);
  await expect(page.locator('#public-content a[href="/posts/arabic-note/"]')).toHaveCount(1);
});

for (const revision of [0, 1]) {
  test(`an API record at revision ${revision} leaves the revision 1 page in place`, async ({ page }) => {
    await page.route("**/api/public/community", route => route.fulfill({ json: { ...fixtureCommunity, revision, name: "Not newer" } }));
    const answered = page.waitForResponse("**/api/public/community");
    await page.goto(`${origin}/`);
    await answered;
    await page.waitForTimeout(300);
    await expect(page.locator("#public-content")).toHaveAttribute("data-revision", "1");
    await expect(page.locator("#public-content h1")).toHaveText("Fixture Community");
  });
}

// Regressions from the independent review of 77cc4c9.

test("post actions appear after client navigation to a post not yet stored", async ({ page }) => {
  await page.goto(`${origin}/`);
  await page.locator('#public-content a[href="/posts/first-song/"]').click();
  await expect(page.locator('[data-content="post"][data-slug="first-song"]')).toBeVisible();
  await expect(page.locator('button[data-action="reply"]')).toHaveCount(1);
});

test("a record stored by another read updates a waiting view", async ({ page }) => {
  await page.route("**/public/data/community.json", async route => {
    await new Promise(resolve => setTimeout(resolve, 700));
    await route.continue();
  });
  const releases: Array<() => void> = [];
  await page.route("**/api/public/**", async route => {
    await new Promise<void>(resolve => releases.push(resolve));
    await route.abort().catch(() => undefined);
  });
  try {
    await page.goto(`${origin}/posts/first-song/`);
    await page.locator('header nav a[href="/"]').click();
    await expect(page.locator("#public-content h1")).toHaveText("Fixture Community", { timeout: 1500 });
  } finally {
    for (const release of releases) release();
  }
});

test("an authoritative 404 is remembered when the API later fails", async ({ page }) => {
  let api = 404;
  await page.route("**/api/public/posts/first-song", route => route.fulfill({ status: api, json: { error: "fixture" } }));
  await page.goto(`${origin}/`);
  await page.locator('#public-content a[href="/posts/first-song/"]').click();
  await expect(page.locator('[data-content="not-found"]')).toBeVisible();
  api = 503;
  await page.locator('header nav a[href="/"]').click();
  await expect(page.locator('[data-content="community"]')).toBeVisible();
  await page.locator('#public-content a[href="/posts/first-song/"]').click();
  await expect(page.locator('[data-content="not-found"]')).toBeVisible();
  await expect(page.locator("#public-content")).not.toContainText("This post exists only");
});

test("focus survives the read timeout when nothing changed", async ({ page }) => {
  await page.goto(`${origin}/posts/first-song/`);
  await expect(page.locator('header nav a[href="/"]')).toHaveText("Fixture Community");
  await page.route("**/api/public/**", async route => {
    await new Promise(resolve => setTimeout(resolve, 6000));
    await route.abort().catch(() => undefined);
  });
  await page.locator('header nav a[href="/"]').click();
  const link = page.locator('#public-content a[href="/posts/arabic-note/"]');
  await link.focus();
  await page.waitForTimeout(4500);
  expect(await page.evaluate(() => (document.activeElement as HTMLAnchorElement | null)?.getAttribute("href"))).toBe("/posts/arabic-note/");
});
