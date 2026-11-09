import { expect, test } from "@playwright/test";

// A V4 community (karaoke-e2e/live-host.ts with KARAOKE_RESULTS_V4=1): the
// learner's one sign-in is the publication permission. A take starts with no
// further signature, no enrollment request and no policy link on the exercise
// surface; the Terms and Privacy documents stay in normal site navigation.
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus)
    console.log(
      JSON.stringify(
        await (await page.request.get("/__fixture/operator")).json(),
      ).slice(0, 8000),
    );
});

test("a V4 take starts with no signature request and no policy link on the exercise surface", async ({
  page,
}) => {
  const signatures: string[] = [];
  let enrollmentRequests = 0;
  page.on("dialog", () => {
    throw new Error("Native browser alerts are not part of the Karaoke design");
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/__fixture/sign") {
      const input = request.postDataJSON();
      // The V4 sign-in is a SIWE text that names the V4 policy; it is
      // recorded as "SignIn".
      if (input.kind !== "address")
        signatures.push(
          input.kind === "typed"
            ? input.data?.primaryType
            : input.kind === "message" &&
                / wants you to sign in with your Ethereum account:\n/.test(
                  String(input.message),
                ) &&
                String(input.message).includes(
                  "\n- urn:pirate:publication-policy:4:0x",
                )
              ? "SignIn"
              : input.kind,
        );
    }
    if (path.startsWith("/api/karaoke/enrollment")) enrollmentRequests++;
  });
  await page.goto("/?learner=5");
  const header = page.locator("header.live-header");
  await expect(
    header.getByRole("link", { name: "Terms", exact: true }),
  ).toHaveAttribute("href", "/terms");
  await expect(
    header.getByRole("link", { name: "Privacy", exact: true }),
  ).toHaveAttribute("href", "/privacy");
  // The V4 learning documents the sign-in accepts, beside them.
  await expect(
    header.getByRole("link", { name: "Learning terms", exact: true }),
  ).toHaveAttribute("href", "/learning/v4/terms");
  await expect(
    header.getByRole("link", { name: "Learning privacy", exact: true }),
  ).toHaveAttribute("href", "/learning/v4/privacy");
  await page.getByRole("button", { name: "Sign in with MOSS" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
    timeout: 20000,
  });
  // One sign-in, which is also the permission.
  expect(signatures).toEqual(["SignIn"]);
  await page.getByRole("button", { name: "Sing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start karaoke" })).toBeVisible(
    { timeout: 30000 },
  );
  const surface = page.locator(".live-karaoke-overlay");
  await expect(
    page.getByRole("navigation", { name: "Karaoke policies" }),
  ).toHaveCount(0);
  await expect(surface.getByRole("link")).toHaveCount(0);
  await page.getByRole("button", { name: "Start karaoke" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".karaoke-stage-rating")).toBeVisible({
    timeout: 30000,
  });
  await expect(surface.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Results" })).toBeVisible({
    timeout: 90000,
  });
  await expect(surface.getByRole("link")).toHaveCount(0);
  expect(signatures).toEqual(["SignIn"]);
  expect(enrollmentRequests).toBe(0);
  // The take is public under the sign-in's authorization.
  const [authorization] = (await (
    await page.request.get("/__fixture/authorizations?learner=5")
  ).json()) as { authorization_id: string; state: string }[];
  expect(authorization!.state).toBe("recorded");
  const records = async () =>
    (await (await page.request.get("/__fixture/records?learner=5")).json()) as {
      verified: boolean;
      problems: string[];
      enrollmentId: string;
      lines: { status: string }[];
    }[];
  await expect.poll(async () => (await records()).length, { timeout: 20000 }).toBe(1);
  const [record] = await records();
  expect(record!.verified, record!.problems.join(", ")).toBe(true);
  expect(record!.lines).toHaveLength(23);
  expect(record!.enrollmentId).toBe(authorization!.authorization_id);
});
