import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    console.log(
      JSON.stringify(
        await (await page.request.get("/__fixture/operator")).json(),
      ).slice(0, 14000),
    );
});

test("one enrollment sponsors repeated terminal publications, history export and revocation", async ({
  page,
}) => {
  let approvals = 0;
  page.on("dialog", () => {
    throw new Error("Native browser alerts are not part of the Karaoke design");
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/__fixture/sign")) {
      const input = request.postDataJSON();
      if (input.kind === "typed" && input.data?.primaryType === "Enrollment")
        approvals++;
    }
  });
  const capture = async (scene: string) => {
    for (const size of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await page.screenshot({
        path: test.info().outputPath(`${scene}-${size.width}.png`),
        animations: "disabled",
      });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  };
  let releaseSong!: () => void;
  const songWait = new Promise<void>((resolve) => {
    releaseSong = resolve;
  });
  await page.route("**/api/public/posts/*/karaoke", async (route) => {
    await songWait;
    await route.continue();
  });
  await page.goto("/?learner=8");
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Sing", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Loading karaoke" }),
  ).toBeVisible();
  await capture("loading");
  releaseSong();
  await expect(
    page.getByRole("button", { name: "Start karaoke" }),
  ).toBeVisible();
  await capture("ready");
  const records = async () =>
    (await (await page.request.get("/__fixture/records?learner=8")).json()) as {
      verified: boolean;
      problems: string[];
      lines: { status: string }[];
    }[];
  for (let run = 1; run <= 2; run++) {
    if (run === 1) {
      await page.getByRole("button", { name: "Start karaoke" }).click();
      const consent = page.getByRole("dialog", {
        name: "Enable public learning results",
      });
      await expect(consent).toBeVisible();
      await consent
        .getByRole("button", { name: "Continue", exact: true })
        .click();
    } else
      await page
        .getByRole("button", { name: "Sing again", exact: true })
        .click();
    await expect(page.locator(".karaoke-stage-rating")).toBeVisible({
      timeout: 25000,
    });
    if (run === 1) await capture("live-rating");
    await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
      timeout: 90000,
    });
    await expect(
      page.getByRole("button", { name: "Save your score" }),
    ).toHaveCount(0);
    const results = page.getByRole("region", { name: "Results" });
    await expect(results.locator("dt")).toHaveText([
      "Lyrics",
      "Timing",
      "Best combo",
    ]);
    await expect(results.getByRole("button")).toHaveCount(0);
    if (run === 1) await capture("completion");
    await expect(
      page.getByRole("button", { name: "Sing again", exact: true }),
    ).toHaveCount(1);
    await expect(page.locator(".live-karaoke > .live-status")).toHaveCount(0);
    await expect
      .poll(async () => (await records()).length, { timeout: 15000 })
      .toBe(run);
    for (const result of await records()) {
      expect(result.verified, result.problems.join(", ")).toBe(true);
      expect(result.lines).toHaveLength(23);
      expect(result.lines.some((line) => line.status === "unpaid")).toBe(false);
    }
    expect(approvals).toBe(1);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    if (run === 1) {
      await page.getByRole("button", { name: "Learning settings" }).click();
      const download = page.waitForEvent("download");
      await page
        .getByRole("menuitem", { name: "Download private history" })
        .click();
      const path = await (await download).path();
      const receipt = JSON.parse(await readFile(path!, "utf8"));
      expect(receipt).toBeTruthy();
      expect(JSON.stringify(receipt)).toContain("scribe_v2_realtime");
      await page.getByRole("button", { name: "Sing", exact: true }).click();
      await expect(page.getByRole("region", { name: "Results" })).toBeVisible();
    }
  }
  await page.getByRole("button", { name: "Learning settings" }).click();
  await page.getByRole("menuitem", { name: "Stop public enrollment" }).click();
  await expect(
    page.getByText(
      "Public enrollment stopped. Earlier publications remain public.",
    ),
  ).toBeVisible({ timeout: 20000 });
  expect((await records()).length).toBe(2);
});
