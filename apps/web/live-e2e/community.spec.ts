// Explicit browser fixture. HTTP cryptography/D1 and live acceptance are
// qualified separately; these tests exercise the built client and reload flow.
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const origin = "https://community.example",
  wallet = "https://pirate-wallet-test.piratesocialclub.workers.dev";
async function serve(
  page: Page,
  authenticated = false,
  directoryOutage = false,
) {
  let connected = false,
    exchanges = 0;
  const pending = {
    connectionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    state: "s".repeat(43),
    requestId: "a".repeat(64),
    expiresAt: Date.now() + 86400000,
  };
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/.well-known/pirate-client.json" && directoryOutage)
      return json({ error: "fixture_directory_unavailable" }, 503);
    if (path === "/.well-known/pirate-client.json")
      return json({
        schema: "pirate.community-client-config/1",
        communityId: "fixture",
        canonicalOrigin: origin,
        apiBase: "/api",
      });
    if (path === "/api/public/community")
      return json({ name: "Browser Fixture Community" });
    if (path === "/api/capabilities")
      return json({
        signIn: true,
        creatorConnection: true,
        upload: false,
        publication: false,
      });
    if (path === "/api/feed") return json({ posts: [] });
    if (path === "/api/session")
      return authenticated
        ? json({
            authenticated: true,
            authorId: "0x" + "1".repeat(64),
            mossAddress: "0x" + "2".repeat(40),
            csrf: "fixture-csrf",
            creator: connected
              ? { evmAddress: "0x" + "3".repeat(40), verifiedAt: Date.now() }
              : null,
            pendingConnection: connected ? null : pending,
          })
        : json({ error: "session_required" }, 401);
    if (path === "/api/creator/complete") {
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      expect(request.postDataJSON()).toEqual({
        connectionId: pending.connectionId,
        state: pending.state,
      });
      exchanges++;
      connected = true;
      return json({ state: "connected" });
    }
    if (path === "/api/logout") {
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      authenticated = false;
      return json({ signedOut: true });
    }
    if (path.startsWith("/api/"))
      throw new Error(`Unexpected fixture call: ${path}`);
    const filename = path.startsWith("/app/assets/")
        ? path.slice(1)
        : "index.html",
      file = resolve("dist/live", filename);
    expect(file.startsWith(resolve("dist/live") + "/")).toBe(true);
    const contentType = filename.endsWith(".js")
      ? "application/javascript"
      : filename.endsWith(".css")
        ? "text/css"
        : "text/html";
    await route.fulfill({ contentType, body: await readFile(file) });
  });
  return { pending, exchanges: () => exchanges };
}

test("fresh anonymous browser loads the real client, offers sign-in and preserves the empty feed on reload", async ({
  page,
}) => {
  await serve(page);
  await page.goto(origin);
  await expect(
    page.getByRole("heading", { name: "Browser Fixture Community" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with MOSS" }),
  ).toBeEnabled();
  await expect(page.getByText("The first release starts here.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect creator wallet" }),
  ).toHaveCount(0);
  await expect(
    page.locator(`iframe[src^="https://account.megaeth.com"]`),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in with MOSS" }),
  ).toBeEnabled();
  await expect(page.getByText("The first release starts here.")).toBeVisible();
  await page.screenshot({
    path: "/tmp/pirate-first-song-community-client.png",
    fullPage: true,
  });
});

test("an existing session can sign out after a reload during a directory outage", async ({
  page,
}) => {
  await serve(page, true, true);
  await page.goto(origin);
  await expect(page.getByRole("status")).toContainText(
    "temporarily unavailable",
  );
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed out.");
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("same-window wallet return completes its saved connection with CSRF, then survives reload", async ({
  page,
}) => {
  const state = await serve(page, true);
  await page.goto(
    `${origin}/creator/complete?connection=${state.pending.connectionId}&state=${state.pending.state}`,
  );
  await expect(
    page.getByText("Your creator wallet is connected."),
  ).toBeVisible();
  expect(state.exchanges()).toBe(1);
  await expect(page).toHaveURL(origin + "/");
  await page.reload();
  await expect(
    page.getByText("Your creator wallet is connected."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reopen creator wallet" }),
  ).toBeEnabled();
  expect(state.exchanges()).toBe(1);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(
    page.getByText("Original composition", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Historical recording", { exact: true }),
  ).toHaveCount(0);
});
