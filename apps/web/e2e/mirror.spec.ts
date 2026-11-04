// Read-only IPFS mirror through an offline Kubo subdomain gateway, with the
// canonical origin blocked so nothing can depend on it.
import { expect, test } from "@playwright/test";
import { FIXTURE_CANONICAL_ORIGIN } from "../src/fixture/site.ts";
import { observe } from "./helpers.ts";
import { mirrorOrigin } from "./kubo.ts";

const origin = () => mirrorOrigin();

test.beforeEach(async ({ context }) => {
  await context.route(`${FIXTURE_CANONICAL_ORIGIN}/**`, route => route.abort("connectionrefused"));
});

test("generated pages are readable with JavaScript disabled and carry preview metadata", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const community = await page.goto(`${origin()}/`);
  expect(community?.status()).toBe(200);
  await expect(page.locator("#public-content h1")).toHaveText("Fixture Community");
  await expect(page.locator("#public-content [data-fixture]")).toHaveText("Fixture data");
  const post = await page.goto(`${origin()}/posts/first-song/`);
  expect(post?.status()).toBe(200);
  await expect(page.locator("#public-content h1")).toHaveText("A first song for the fixture community");
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "article");
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", `${FIXTURE_CANONICAL_ORIGIN}/posts/first-song/`);
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute("content", /^(?!.*frame-ancestors).*script-src 'self' 'sha256-/);
  await expect(page.locator("html")).toHaveAttribute("data-document-version", "1");
  await expect(page.locator("#public-content")).toHaveAttribute("data-revision", "1");
  await expect(page.locator("#app-shell-root")).toBeEmpty();
  await context.close();
});

test("statuses: deep links, client fallback, real 404 and 410", async ({ page }) => {
  const noSlash = await page.goto(`${origin()}/posts/first-song`);
  expect(noSlash?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe("/posts/first-song/");

  const about = await page.goto(`${origin()}/about`);
  expect(about?.status()).toBe(200);
  await expect(page.locator('[data-content="about"]')).toBeVisible();

  const reload = await page.reload();
  expect(reload?.status()).toBe(200);
  await expect(page.locator('[data-content="about"]')).toBeVisible();

  expect((await page.goto(`${origin()}/posts/does-not-exist/`))?.status()).toBe(404);
  expect((await page.goto(`${origin()}/nothing-here`))?.status()).toBe(404);
  await expect(page.locator('[data-content="not-found"]')).toBeVisible();

  const gone = await page.goto(`${origin()}/posts/withdrawn-post/`);
  expect(gone?.status()).toBe(410);
  await expect(page.locator('[data-content="removed"]')).toBeVisible();
  await expect(page.locator('meta[property^="og:"]')).toHaveCount(0);
  expect((await page.goto(`${origin()}/posts/withdrawn-post`))?.status()).toBe(410);
});

test("mirror mode reads the snapshot only, offers no sign-in and links actions to the canonical origin", async ({ context, page }) => {
  const seen = await observe(context, page);
  await page.goto(`${origin()}/posts/first-song/`);
  await expect(page.locator("header[data-mode]")).toHaveAttribute("data-mode", "mirror");
  await expect(page.locator("[data-mirror-notice]")).toContainText("localhost:4173");
  await expect(page.locator('a[data-action="sign-in"]')).toHaveAttribute("href", `${FIXTURE_CANONICAL_ORIGIN}/posts/first-song/`);
  await expect(page.locator('a[data-action="reply"]')).toHaveAttribute("href", `${FIXTURE_CANONICAL_ORIGIN}/posts/first-song/`);
  await expect(page.locator("button[data-action]")).toHaveCount(0);

  await page.evaluate(() => { (window as unknown as { __stay: number }).__stay = 1; });
  await page.locator("header nav a").first().click();
  await expect(page.locator('[data-content="community"]')).toBeVisible();
  await page.locator('[data-content="community"] a[href="/posts/arabic-note/"]').click();
  await expect(page.locator('[data-content="post"][data-slug="arabic-note"]')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/posts/arabic-note/");
  expect(await page.evaluate(() => (window as unknown as { __stay?: number }).__stay)).toBe(1);
  await expect(page.locator('a[data-action="reply"]')).toHaveAttribute("href", `${FIXTURE_CANONICAL_ORIGIN}/posts/arabic-note/`);
  await page.goBack();
  await expect(page.locator('[data-content="community"]')).toBeVisible();
  await expect(page.locator('a[data-action="reply"]')).toHaveCount(0);

  const offOrigin = seen.requests.filter(url => !url.startsWith(origin()));
  expect(offOrigin).toEqual([]);
  expect(seen.requests.filter(url => new URL(url).pathname.startsWith("/api/"))).toEqual([]);
  expect(await seen.violations()).toEqual([]);
});

test("interface language is resolved before mount and content keeps its own direction", async ({ page }) => {
  await page.goto(`${origin()}/posts/first-song/?lang=ar`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator('#public-content article')).toHaveAttribute("dir", "ltr");
  await expect(page.locator("header nav")).toContainText("حول");
  await page.goto(`${origin()}/posts/arabic-note/`);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl"); // saved preference
  await expect(page.locator('#public-content article')).toHaveAttribute("dir", "rtl");
});

// Regression from the 2026-11-04 review: a mirror's action links must point at
// the canonical origin whatever path the mirror host preserves. Kubo
// normalizes repeated slashes; the alternate host (the fixture host reached
// on 127.0.0.1, a different origin) does not.
for (const variant of ["kubo", "alternate-host"] as const) {
  for (const path of ["//outside.invalid/path", "/\\outside.invalid/path"]) {
    test(`mirror action links stay on the canonical origin (${variant}, ${JSON.stringify(path)})`, async ({ page }) => {
      const base = variant === "kubo" ? origin() : "http://127.0.0.1:4173";
      await page.goto(`${base}${path}`);
      const action = page.locator('a[data-action="sign-in"]');
      await expect(action).toBeVisible();
      expect(new URL((await action.getAttribute("href"))!).origin).toBe(FIXTURE_CANONICAL_ORIGIN);
    });
  }
}
