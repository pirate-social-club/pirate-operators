// Canonical mode on the FIXTURE canonical host (scripts/fixture-host.ts). This
// checks the client's canonical behaviour and the generated host headers; it
// is not an acceptance of Cloudflare or of the community service.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { FIXTURE_CANONICAL_ORIGIN } from "../src/fixture/site.ts";
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
