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
  page.on("dialog", async (dialog) => {
    approvals++;
    await dialog.accept();
  });
  await page.goto("/?learner=8");
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Sing", exact: true }).click();
  const records = async () =>
    (await (await page.request.get("/__fixture/records?learner=8")).json()) as {
      verified: boolean;
      problems: string[];
      lines: { status: string }[];
    }[];
  for (let run = 1; run <= 2; run++) {
    await page.getByRole("button", { name: "Start karaoke" }).click();
    await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
      timeout: 90000,
    });
    await expect(
      page.getByRole("button", { name: "Save your score" }),
    ).toHaveCount(0);
    await expect(page.getByText("Saved to your learning record.")).toBeVisible({
      timeout: 45000,
    });
    await expect
      .poll(async () => (await records()).length, { timeout: 15000 })
      .toBe(run);
    for (const result of await records()) {
      expect(result.verified, result.problems.join(", ")).toBe(true);
      expect(result.lines).toHaveLength(23);
      expect(result.lines.some((line) => line.status === "unpaid")).toBe(false);
    }
    expect(approvals).toBe(1);
    if (run === 1) {
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Download private history" })
        .click();
      const path = await (await download).path();
      const receipt = JSON.parse(await readFile(path!, "utf8"));
      expect(receipt).toBeTruthy();
      expect(JSON.stringify(receipt)).toContain("scribe_v2_realtime");
      await page
        .getByRole("button", { name: "Sing again", exact: true })
        .first()
        .click();
    }
  }
  await page.getByRole("button", { name: "Stop public enrollment" }).click();
  await expect(
    page.getByText(
      "Public enrollment stopped. Earlier publications remain public.",
    ),
  ).toBeVisible({ timeout: 20000 });
  expect((await records()).length).toBe(2);
});
