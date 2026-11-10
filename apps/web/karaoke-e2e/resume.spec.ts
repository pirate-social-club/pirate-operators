import { test, expect } from "@playwright/test";

// Requires the shell owner's route mount. Lane 5 runs it against a local
// artifact compiled from .local/integration.patch, without changing entry.tsx.
test("Karaoke refresh restores the song and reuses the server take without a new publication", async ({
  page,
}) => {
  await page.goto("/?learner=7");
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Sing", exact: true }).click();
  await expect(page).toHaveURL(/[?&]sing=0x[0-9a-f]{64}/);
  await page
    .getByRole("button", { name: "Start karaoke", exact: true })
    .click();
  await expect(page.locator(".karaoke-stage-rating")).toBeVisible({
    timeout: 30000,
  });
  const operator = async () =>
    (await (await page.request.get("/__fixture/operator")).json()) as {
      attempts: { attemptId: string }[];
    };
  const before = await operator();
  expect(before.attempts).toHaveLength(1);
  const originalId = before.attempts[0].attemptId;
  await page.reload();
  // Route restoration is automatic; no second Sing tap after refresh.
  await expect(
    page.getByRole("button", { name: "Start karaoke", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await page
    .getByRole("button", { name: "Start karaoke", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 90000,
  });
  const after = await operator();
  expect(after.attempts).toHaveLength(1);
  expect(after.attempts[0].attemptId).toBe(originalId);
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/__fixture/records?learner=7")).json())
          .length,
    )
    .toBe(1);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]sing=/);
});
