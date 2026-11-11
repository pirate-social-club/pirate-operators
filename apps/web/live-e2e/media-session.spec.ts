// Actual built App, source MOSS adapter, private-profile producer and composer.
// HTTP/SDK are explicit protocol fixtures; IDB/Files/browser controls are real.
// No real MOSS, provider, publication, device or financial acceptance is implied.
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { accounts, origin, serveAccounts } from "./account-fixture.ts";
import { OWNER_RELEASE_POLICY } from "../src/media/community-contracts.ts";

declare global {
  interface Window {
    __ownerSessionCase: {
      denial: number;
      headers: number;
      bodyReads: number;
      release(): void;
    };
  }
}
const communityId = `0x${"2".repeat(64)}`;
const authorId = `0x${"c".repeat(64)}`;
async function retained(page: Page, accountId: string) {
  return page.evaluate(
    async ({ communityId, accountId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("pirate-community-composer-v1", 1);
        request.onupgradeneeded = () => request.transaction?.abort();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const cell = await new Promise<{
          value:
            | import("../src/media/community-song-controller.ts").CommunitySongDraft
            | null;
        }>((resolve, reject) => {
          const request = db
            .transaction("records", "readonly")
            .objectStore("records")
            .get(JSON.stringify([communityId, accountId, "song"]));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const value = cell?.value;
        if (!value) throw new Error("Actual fixture draft was not retained");
        return {
          accountId: value.accountId,
          communityId: value.communityId,
          requestId: value.requestId,
          bodyDigest: value.bodyDigest,
          body: value.body,
          hashes: value.hashes,
          pending: value.pending,
          files: await Promise.all(
            Object.values(value.files).map(async (file) => ({
              nativeFile: file instanceof File,
              name: file.name,
              type: file.type,
              size: file.size,
              sha256: Array.from(
                new Uint8Array(
                  await crypto.subtle.digest(
                    "SHA-256",
                    await file.arrayBuffer(),
                  ),
                ),
              )
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join(""),
            })),
          ),
        };
      } finally {
        db.close();
      }
    },
    { communityId, accountId },
  );
}

for (const width of [1440, 390])
  for (const status of [401, 403]) {
    test(`actual App global Retry masks a ${status} session before its body at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await serveAccounts(page);
      await page.addInitScript(() => {
        const original = window.fetch.bind(window);
        const control = {
          denial: 0,
          headers: 0,
          bodyReads: 0,
          release: () => {},
        };
        const held = new Promise<void>((resolve) => {
          control.release = resolve;
        });
        window.__ownerSessionCase = control;
        window.fetch = async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
            location.href,
          );
          if (control.denial && url.pathname === "/api/session") {
            control.headers++;
            const response = new Response(null, { status: control.denial });
            response.json = async () => {
              control.bodyReads++;
              await held;
              return { error: "session_required" };
            };
            return response;
          }
          return original(input, init);
        };
      });
      const accountId = crypto.randomUUID();
      let signed = false,
        failedPublicRead = false;
      const reservations: { key: string | undefined; body: unknown }[] = [];
      await page.route(`${origin}/**`, async (route) => {
        const request = route.request(),
          path = new URL(request.url()).pathname;
        const json = (body: unknown, status = 200) =>
          route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify(body),
          });
        if (path === "/api/auth/verify") {
          signed = true;
          return route.fallback();
        }
        if (path === "/.well-known/pirate-client.json")
          return json({
            schema: "pirate.community-client-config/1",
            canonicalOrigin: origin,
            communityId,
            apiBase: "/api",
            protocolVersions: [1],
            defaultLanguage: "en",
            supportedLanguages: ["en"],
            mirrors: [],
          });
        if (path === "/api/capabilities")
          return json({
            schema: "pirate.community-capabilities/1",
            signIn: true,
            creatorConnection: false,
            upload: true,
            publication: true,
            rewards: false,
            study: false,
            policyVersion: OWNER_RELEASE_POLICY,
          });
        if (path === "/api/feed") {
          if (signed && !failedPublicRead) {
            failedPublicRead = true;
            return json({ error: "fixture_public_read_unavailable" }, 503);
          }
          return json({
            schema: "pirate.community-feed/1",
            communityId,
            posts: [],
          });
        }
        if (path === "/api/session")
          return signed
            ? json({
                authenticated: true,
                authorId,
                mossAddress: accounts.first,
                csrf: "csrf-first",
                publisher: true,
                publicResults: "on",
                creator: null,
                pendingConnection: null,
              })
            : json({ error: "session_required" }, 401);
        if (path === "/api/profile/owner")
          return json({
            schema: "pirate.community-profile-owner/1",
            communityId,
            accountId,
            profile: {
              schema: "pirate.community-profile/1",
              communityId,
              authorId,
              revision: 1,
              displayName: "Fixture member",
              bio: null,
              avatarRef: null,
              coverRef: null,
            },
            capabilities: {
              metadata: true,
              handles: false,
              publicMedia: false,
            },
          });
        if (path === "/api/uploads") {
          if (request.method() === "POST") {
            reservations.push({
              key: request.headers()["idempotency-key"],
              body: request.postDataJSON(),
            });
            return json({ error: "release_processing_unavailable" }, 503);
          }
          return json({ uploads: [] });
        }
        return route.fallback();
      });
      try {
        await page.goto(origin + "/#/publish");
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .first()
          .click();
        const retry = page.locator(".live-status.live-error + button");
        await expect(retry).toHaveText("Try again");
        await expect(retry).toBeEnabled();
        await expect(
          page.locator('input[aria-label="Upload audio"]'),
        ).toHaveCount(1);
        const mp3 = await readFile(
          new URL("./fixtures/owner-ui-silence.mp3", import.meta.url),
        );
        const file = {
          name: "Fixture.mp3",
          mimeType: "audio/mpeg",
          buffer: mp3,
        };
        await page
          .locator('input[aria-label="Upload audio"]')
          .setInputFiles(file);
        await page.locator("#song-stem-instrumental").setInputFiles(file);
        await page.locator("#song-stem-vocals").setInputFiles(file);
        await page.locator("#song-track-title").fill("Fixture");
        await page.locator("#song-lyrics").fill("Fixture line.");
        await page.getByRole("button", { name: "Next", exact: true }).click();
        const consent = page.getByRole("checkbox");
        await consent.press("Space");
        await expect(consent).toBeChecked();
        const rating = page.getByRole("radio", {
          name: "General",
          exact: true,
        });
        await rating.press("Space");
        await expect(rating).toBeChecked();
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect.poll(() => reservations.length).toBe(1);
        const before = await retained(page, accountId);
        expect(before.accountId).toBe(accountId);
        expect(before.accountId).not.toBe(accounts.first);
        expect(
          before.files.every((file) => file.nativeFile && file.size > 0),
        ).toBe(true);
        await page.screenshot({
          path: test.info().outputPath("member-retained-release.png"),
          fullPage: true,
        });
        await expect(retry).toBeEnabled();
        await page.evaluate((status) => {
          window.__ownerSessionCase.denial = status;
        }, status);
        await retry.click();
        await expect
          .poll(() => page.evaluate(() => window.__ownerSessionCase.headers))
          .toBe(1);
        await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Sign in", exact: true }).first(),
        ).toBeVisible();
        expect(
          await page.evaluate(() => window.__ownerSessionCase.bodyReads),
        ).toBe(0);
        expect(await retained(page, accountId)).toEqual(before);
        expect(reservations).toHaveLength(1);
        expect(errors).toEqual([]);
        await page.screenshot({
          path: test.info().outputPath("session-denied-before-body.png"),
          fullPage: true,
        });
      } finally {
        await page
          .evaluate(() => window.__ownerSessionCase.release())
          .catch(() => {});
      }
    });
  }
