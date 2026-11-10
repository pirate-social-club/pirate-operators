import { expect, test } from "@playwright/test";
import { documents, origin, serveV4 } from "./v4-fixture.ts";

// A V4 community: one normal sign-in, then exercises only. Study makes no
// enrollment request or signature, the exercise surface has no policy link,
// the documents stay in normal site navigation, and public results are turned
// off and on only from account settings.
test.use({ viewport: { width: 1280, height: 900 } });

async function signIn(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

test("a V4 Study lesson starts after one sign-in with no other signature and no policy link on the exercise surface", async ({
  page,
}) => {
  const state = await serveV4(page);
  await page.goto(state.url);
  // The sign-in screen links the documents the sign-in accepts.
  const header = page.locator("header.live-header");
  await expect(
    header.getByRole("link", { name: "Learning terms", exact: true }),
  ).toHaveAttribute("href", "/learning/v4/terms");
  await expect(
    header.getByRole("link", { name: "Learning privacy", exact: true }),
  ).toHaveAttribute("href", "/learning/v4/privacy");
  await signIn(page);
  expect(state.signatures).toEqual(["SignIn"]);
  await page.getByRole("button", { name: "Study", exact: true }).click();
  await expect(page.locator(".study-surface h2")).toBeVisible();
  expect(state.counts.starts).toBe(1);
  expect(state.counts.enrollment).toBe(0);
  expect(state.signatures).toEqual(["SignIn"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const overlay = page.locator(".live-study-overlay");
  await expect(
    page.getByRole("navigation", { name: "Study policies" }),
  ).toHaveCount(0);
  await expect(overlay.getByRole("link")).toHaveCount(0);
  await expect(overlay.getByText(/Terms|Privacy/)).toHaveCount(0);
});

test("Terms and Privacy stay reachable while signed in, in the footer outside the overlay", async ({
  page,
}) => {
  const state = await serveV4(page);
  await page.goto(state.url);
  await signIn(page);
  // Signed in, the header no longer carries them; the footer does.
  const header = page.locator("header.live-header");
  await expect(header.getByRole("link", { name: /Terms|Privacy/ })).toHaveCount(
    0,
  );
  const footer = page.getByRole("navigation", { name: "Community documents" });
  await expect(footer.locator("xpath=ancestor::footer")).toHaveCount(1);
  for (const [name, href] of [
    ["Terms", "/terms"],
    ["Privacy", "/privacy"],
    ["Learning terms", "/learning/v4/terms"],
    ["Learning privacy", "/learning/v4/privacy"],
  ] as const) {
    const link = footer.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", href);
    const opened = page.waitForEvent("popup");
    await link.click();
    const tab = await opened;
    await expect(tab.locator("body")).toHaveText(documents[href]!);
    expect(tab.url()).toBe(origin + href);
    await tab.close();
  }
  // Opening Study leaves the documents outside it, never inside.
  await page.getByRole("button", { name: "Study", exact: true }).click();
  await expect(page.locator(".study-surface h2")).toBeVisible();
  await expect(
    page.locator(".live-study-overlay").getByRole("link"),
  ).toHaveCount(0);
  await expect(page.locator(".live-study-overlay .live-footer")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Community documents" }),
  ).toHaveCount(1);
  expect(state.signatures).toEqual(["SignIn"]);
});

test("settings offer no public results switch", async ({ page }) => {
  const state = await serveV4(page);
  await page.goto(state.url);
  await signIn(page);
  // Nothing to offer yet: no settings menu at all.
  await expect(
    page.getByRole("button", { name: "Learning settings" }),
  ).toHaveCount(0);
  // After Study, the menu offers only the private history download.
  await page.getByRole("button", { name: "Study", exact: true }).click();
  await expect(page.locator(".study-surface h2")).toBeVisible();
  await page.getByRole("button", { name: "Exit study" }).click();
  await page.getByRole("button", { name: "Learning settings" }).click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Download private history",
  ]);
  await page.keyboard.press("Escape");
  expect(state.signatures).toEqual(["SignIn"]);
  expect(state.counts.revocations).toBe(0);
});
