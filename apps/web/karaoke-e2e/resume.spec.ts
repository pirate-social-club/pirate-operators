import { test, expect } from "@playwright/test";

// The normal learning browser workflow includes this published-song regression.
test("Karaoke refresh restores the song and reuses the server take without a new publication", async ({
  page,
}) => {
  await page.goto("/?learner=10");
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Sing", exact: true }).click();
  await expect(page).toHaveURL(/[?&]sing=0x[0-9a-f]{64}/);
  const operator = async () =>
    (await (await page.request.get("/__fixture/operator")).json()) as {
      attempts: { attemptId: string }[];
    };
  const baseline = new Set(
    (await operator()).attempts.map((attempt) => attempt.attemptId),
  );
  await page
    .getByRole("button", { name: "Start karaoke", exact: true })
    .click();
  await expect(page.locator(".karaoke-stage-rating")).toBeVisible({
    timeout: 30000,
  });
  const added = (await operator()).attempts.filter(
    (attempt) => !baseline.has(attempt.attemptId),
  );
  expect(added).toHaveLength(1);
  const originalId = added[0].attemptId;
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
  const resumed = after.attempts.filter(
    (attempt) => !baseline.has(attempt.attemptId),
  );
  expect(resumed).toHaveLength(1);
  expect(resumed[0].attemptId).toBe(originalId);
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/__fixture/records?learner=10")).json())
          .length,
    )
    .toBe(1);
  const events = (await (
    await page.request.get("/__fixture/result-events?learner=10")
  ).json()) as { sessionId: string; revision: number; verified: boolean }[];
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    sessionId: originalId,
    revision: 1,
    verified: true,
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).not.toHaveURL(/[?&]sing=/);
});
