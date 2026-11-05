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
  releasing = false,
  referrerPolicy = "strict-origin",
) {
  let connected = releasing,
    exchanges = 0,
    reservations = 0,
    storedUploads = 0,
    uploadCalls = 0,
    phase = "admission";
  let submissionId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    postId = "0x" + "4".repeat(64),
    jobId = `publication:${submissionId}`;
  let reserved = false,
    sealed = false;
  const keys = new Set<string>(),
    stored = new Set<string>();
  const stemRows = new Map<
    string,
    { slot: string; state: string; sha256: string; byteLength: number }
  >();
  type Upload = {
    submissionId: string;
    postId: string;
    title: string;
    state: string;
    jobId: string | null;
  };
  const history: Upload[] = [];
  let songTitle = "Browser saved song";
  const currentUpload = (): Upload => ({
    submissionId,
    postId,
    title: songTitle,
    state: sealed ? phase : "uploaded",
    jobId: sealed ? jobId : null,
  });
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
        upload: releasing,
        publication: releasing,
        policyVersion: "pirate-release/2026-08-29",
      });
    if (path === "/api/feed") return json({ posts: [] });
    if (path === "/api/uploads" && request.method() === "GET")
      return json({ uploads: reserved ? [currentUpload(), ...history] : [] });
    if (releasing && path === "/api/uploads" && request.method() === "POST") {
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      expect(request.postDataJSON().original).toBe(true);
      const key = request.headers()["idempotency-key"]!;
      if (!keys.has(key)) {
        if (reserved) history.push(currentUpload());
        keys.add(key);
        reservations++;
        if (reservations > 1) {
          submissionId = `bbbbbbbb-bbbb-4bbb-bbbb-${String(reservations).padStart(12, "0")}`;
          postId = "0x" + String(reservations + 4).repeat(64);
          jobId = `publication:${submissionId}`;
        }
        reserved = true;
        sealed = false;
        phase = "admission";
        songTitle = request.postDataJSON().title;
      }
      return json({ submissionId, postId, state: "reserved" }, 201);
    }
    if (releasing && path === `/api/uploads/${submissionId}/audio`) {
      uploadCalls++;
      expect(request.method()).toBe("PUT");
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      if (!stored.has(submissionId)) {
        stored.add(submissionId);
        storedUploads++;
        if (storedUploads === 1) return route.abort("connectionreset");
      }
      return json({ uploaded: true });
    }
    const stem =
      /^\/api\/uploads\/([^/]+)\/stems(?:\/(instrumental|vocals))?$/.exec(path);
    if (releasing && stem) {
      if (!stem[2])
        return json({
          stems: [...stemRows]
            .filter(([key]) => key.startsWith(stem[1]! + "/"))
            .map(([, row]) => row),
        });
      const key = stem[1] + "/" + stem[2];
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      if (request.method() === "POST") {
        const input = request.postDataJSON(),
          existing = stemRows.get(key);
        if (existing) expect(existing.sha256).toBe(input.sha256);
        else stemRows.set(key, { slot: stem[2], state: "reserved", ...input });
        return json({ stem: stemRows.get(key) }, 201);
      }
      expect(request.method()).toBe("PUT");
      const row = stemRows.get(key)!;
      expect(row).toBeTruthy();
      expect(request.postDataBuffer()!.length).toBe(row.byteLength);
      row.state = "sealed";
      return json({ sealed: true });
    }
    if (releasing && path === `/api/uploads/${submissionId}/seal`) {
      expect(
        ["instrumental", "vocals"].every(
          (slot) => stemRows.get(submissionId + "/" + slot)?.state === "sealed",
        ),
      ).toBe(true);
      sealed = true;
      return json({ jobId, postId }, 202);
    }
    if (
      releasing &&
      path.startsWith("/api/jobs/") &&
      request.method() === "GET"
    ) {
      const id = decodeURIComponent(path.slice("/api/jobs/".length)),
        row = [currentUpload(), ...history].find((row) => row.jobId === id)!;
      expect(row).toBeTruthy();
      return json({
        schema: "pirate.publication-job-view/1",
        jobId: row.jobId,
        submissionId: row.submissionId,
        postId: row.postId,
        phase: row.state,
        errorCode: null,
        resumable: row.state === "uncertain",
      });
    }
    if (releasing && path === `/api/jobs/${encodeURIComponent(jobId)}/resume`) {
      expect(request.headers()["x-csrf-token"]).toBe("fixture-csrf");
      phase = "publication";
      return json({ resuming: true });
    }
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
    await route.fulfill({
      contentType,
      body: await readFile(file),
      headers: { "referrer-policy": referrerPolicy },
    });
  });
  return {
    pending,
    exchanges: () => exchanges,
    reservations: () => reservations,
    storedUploads: () => storedUploads,
    uploadCalls: () => uploadCalls,
    phase: (value: string) => {
      phase = value;
    },
  };
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
  await expect(page.locator(".live-status")).toContainText(
    "temporarily unavailable",
  );
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator(".live-status")).toHaveText("Signed out.");
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
  await expect(page.getByRole("checkbox")).toHaveCount(1);
  await expect(
    page.getByText("Original composition", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Historical recording", { exact: true }),
  ).toHaveCount(0);
});

test("saved binary and release intent survive an interrupted upload and reload; held/rejected jobs cannot publish", async ({
  page,
}) => {
  const state = await serve(page, true, false, true);
  await page.goto(origin);
  await page
    .getByLabel("Song title", { exact: true })
    .fill("Browser saved song");
  await page.getByLabel("Lyrics", { exact: true }).fill("A saved lyric line");
  await page.getByLabel("Recording", { exact: true }).setInputFiles({
    name: "saved-song.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("ID3browser-local-upload-fixture"),
  });
  await page.getByRole("checkbox").check();
  for (const slot of ["Instrumental", "Vocals"])
    await page.getByLabel(slot, { exact: true }).setInputFiles({
      name: slot + ".mp3",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("ID3" + slot + "-browser-fixture"),
    });
  await page.getByRole("button", { name: "Submit song", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue saved release" }),
  ).toBeEnabled();
  expect(state.reservations()).toBe(1);
  expect(state.storedUploads()).toBe(1);
  await page.reload();
  await expect(page.getByText("Saved recording: saved-song.mp3")).toBeVisible();
  await expect(page.getByLabel("Song title", { exact: true })).toHaveValue(
    "Browser saved song",
  );
  await page.getByRole("button", { name: "Continue saved release" }).click();
  await expect(
    page.getByText(
      "Submitted. Your progress is saved; processing continues after you leave.",
    ),
  ).toBeVisible();
  expect(state.reservations()).toBe(1);
  expect(state.storedUploads()).toBe(1);
  expect(state.uploadCalls()).toBe(2);
  state.phase("uncertain");
  await page.reload();
  await page.getByRole("button", { name: "Check and resume" }).click();
  await expect(page.getByText("Publishing to the community.")).toBeVisible();
  state.phase("held");
  await page.reload();
  await expect(
    page.getByText(
      "This release is held for review and has not been published.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check and resume" }),
  ).toHaveCount(0);
  state.phase("failed");
  await page.reload();
  await expect(
    page.getByText("This release was rejected and has not been published."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Check and resume" }),
  ).toHaveCount(0);
  expect(state.reservations()).toBe(1);
  await page.getByRole("button", { name: "Start another release" }).click();
  await page
    .getByLabel("Song title", { exact: true })
    .fill("Corrected browser song");
  await page.getByLabel("Recording", { exact: true }).setInputFiles({
    name: "corrected.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("ID3corrected-local-fixture"),
  });
  await page.getByRole("checkbox").check();
  for (const slot of ["Instrumental", "Vocals"])
    await page
      .getByLabel(slot, { exact: true })
      .first()
      .setInputFiles({
        name: slot + "-corrected.mp3",
        mimeType: "audio/mpeg",
        buffer: Buffer.from("ID3corrected-" + slot + "-browser-fixture"),
      });
  await page.getByRole("button", { name: "Submit song", exact: true }).click();
  await expect(
    page.getByText(
      "Submitted. Your progress is saved; processing continues after you leave.",
    ),
  ).toBeVisible();
  expect(state.reservations()).toBe(2);
  expect(state.storedUploads()).toBe(2);
  await expect(
    page.getByText("This release was rejected and has not been published."),
  ).toBeVisible();
  state.phase("published");
  await page.reload();
  await expect(
    page.getByText("Published. Find your song in Latest songs."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start another release" }).click();
  await expect(page.getByLabel("Song title", { exact: true })).toBeEditable();
  await page.screenshot({
    path: "/tmp/pirate-first-song-upload-recovery.png",
    fullPage: true,
  });
});

for (const policy of ["same-origin", "strict-origin"]) {
  test(`real pinned MOSS SDK parent-origin handshake with ${policy} referrer policy`, async ({
    page,
  }) => {
    // Controlled wallet peer, using the SDK's actual pinned Penpal transport.
    // It cancels connection; no fixture account or authenticated session exists.
    const moss = "https://account.megaeth.com";
    await serve(page, false, false, false, policy);
    await page.route(`${moss}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/penpal.mjs")
        return route.fulfill({
          contentType: "application/javascript",
          body: await readFile("node_modules/penpal/dist/penpal.mjs"),
        });
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><body><script type="module">
        import {connect,WindowMessenger} from '/penpal.mjs';
        document.body.dataset.referrer=document.referrer;
        const origin=document.referrer ? new URL(document.referrer).origin : null;
        if(origin) {
          const connection=connect({messenger:new WindowMessenger({remoteWindow:window.parent,allowedOrigins:[origin]}),methods:{status:()=>({status:'disconnected'}),connect:()=>({status:'cancelled'})}});
          const app=await connection.promise; await app.ready();
        }
      </script></body>`,
      });
    });
    await page.goto(origin + "/draft?draft=fixture-private-context");
    await page.getByRole("button", { name: "Sign in with MOSS" }).click();
    const body = page.frameLocator("iframe").locator("body");
    await expect(body).toHaveAttribute(
      "data-referrer",
      policy === "same-origin" ? "" : origin + "/",
    );
    if (policy === "strict-origin")
      await expect(page.locator(".live-status")).toHaveText(
        "MOSS sign-in was cancelled.",
      );
    else await expect(page.locator(".live-status")).toHaveText("Opening MOSS…");
    await expect(
      page.getByRole("button", { name: "Connect creator wallet" }),
    ).toHaveCount(0);
  });
}
