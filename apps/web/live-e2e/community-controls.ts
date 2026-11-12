// Actual source controls and native read-only storage inspection. No App hook,
// fake success, force click, localStorage or replacement component is mounted.
import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { communityId } from "./community-fixture.ts";
export async function chooseRelease(
  page: Page,
  title: string,
  filename: string,
  lyrics: string,
) {
  const buffer = await readFile(
    new URL("./fixtures/owner-ui-silence.mp3", import.meta.url),
  );
  const file = { name: filename, mimeType: "audio/mpeg", buffer };
  await page.locator('input[aria-label="Upload audio"]').setInputFiles(file);
  await page
    .locator("#song-stem-instrumental")
    .setInputFiles({ ...file, name: "Instrumental-" + filename });
  await page
    .locator("#song-stem-vocals")
    .setInputFiles({ ...file, name: "Vocals-" + filename });
  await expect(page.locator("#song-track-title")).toBeEditable();
  await page.locator("#song-track-title").fill(title);
  await page.locator("#song-lyrics").fill(lyrics);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const consent = page.getByRole("checkbox");
  await consent.press("Space");
  await expect(consent).toBeChecked();
  const rating = page.getByRole("radio", { name: "General", exact: true });
  await rating.press("Space");
  await expect(rating).toBeChecked();
  await page.getByRole("button", { name: "Next", exact: true }).click();
}
export async function retainedRelease(page: Page, accountId: string) {
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
        if (!value) return null;
        const digest = async (bytes: ArrayBuffer) =>
          "0x" +
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
        return {
          version: value.version,
          accountId: value.accountId,
          communityId: value.communityId,
          authorId: value.authorId,
          requestId: value.requestId,
          body: value.body,
          bodyDigest: value.bodyDigest,
          measuredBodyDigest: await digest(
            new TextEncoder().encode(JSON.stringify(value.body)).buffer,
          ),
          hashes: value.hashes,
          pending: value.pending,
          submissionId: value.submissionId,
          postId: value.postId,
          jobId: value.jobId,
          job: value.job,
          forbiddenCredentials: "csrf" in value || "session" in value,
          files: await Promise.all(
            Object.entries(value.files).map(async ([slot, file]) => ({
              slot,
              nativeFile: file instanceof File,
              name: file.name,
              type: file.type,
              size: file.size,
              lastModified: file.lastModified,
              sha256: await digest(await file.arrayBuffer()),
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
export async function readyStudy(page: Page) {
  const overlay = page.locator(".live-study-overlay");
  await expect(
    overlay.getByRole("heading", { name: "Hold me close", exact: true }),
  ).toBeVisible();
  await expect(
    overlay.getByRole("button", { name: "Record", exact: true }),
  ).toBeVisible();
  await expect(
    overlay.getByRole("button", { name: "Exit study", exact: true }),
  ).toBeVisible();
  return overlay;
}
export async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
