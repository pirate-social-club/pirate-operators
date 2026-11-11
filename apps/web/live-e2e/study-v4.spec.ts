import {
  studyOverlay,
  studyHeading,
  openSettings,
  startStudy,
  signInCurrent as signIn,
} from "./account-fixture.ts";
import { expect, test } from "@playwright/test";
import { documents, origin, serveV4 } from "./v4-fixture.ts";

// A V4 community: one normal sign-in, then exercises only. Study makes no
// enrollment request or signature, the exercise surface has no policy link,
// the documents stay in normal site navigation, and public results are turned
// off and on only from account settings.
test.use({ viewport: { width: 1280, height: 900 } });

test("a V4 Study lesson starts after one sign-in with no other signature and no policy link on the exercise surface", async ({
  page,
}) => {
  const state = await serveV4(page);
  await page.goto(state.url);
  // The sign-in screen links the documents the sign-in accepts.
  const header = page.getByRole("navigation", { name: "Community documents" });
  await expect(header).toBeVisible();
  await expect(
    header.getByRole("link", { name: "Learning terms", exact: true }),
  ).toHaveAttribute("href", "/learning/v4/terms");
  await expect(
    header.getByRole("link", { name: "Learning privacy", exact: true }),
  ).toHaveAttribute("href", "/learning/v4/privacy");
  await signIn(page);
  expect(state.signatures).toEqual(["SignIn"]);
  await startStudy(page);
  await expect(studyHeading(page)).toBeVisible();
  expect(state.counts.starts).toBe(1);
  expect(state.counts.enrollment).toBe(0);
  expect(state.signatures).toEqual(["SignIn"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const overlay = studyOverlay(page);
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
  // The current normal site navigation owns the one copy of each policy link.
  await expect(
    page.getByRole("navigation", { name: "Community documents" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Learning terms", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "Learning privacy", exact: true }),
  ).toHaveCount(1);
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
  await startStudy(page);
  await expect(studyHeading(page)).toBeVisible();
  await expect(studyOverlay(page).getByRole("link")).toHaveCount(0);
  await expect(
    studyOverlay(page).getByRole("navigation", { name: "Community documents" }),
  ).toHaveCount(0);
  const underlay = page.getByRole("navigation", {
    name: "Community documents",
    includeHidden: true,
  });
  await expect(underlay).toHaveCount(1);
  await expect(underlay.locator("xpath=ancestor::footer")).toHaveJSProperty(
    "inert",
    true,
  );
  await page.getByRole("button", { name: "Exit study", exact: true }).click();
  await expect(footer).toBeVisible();
  await expect(footer.locator("xpath=ancestor::footer")).toHaveJSProperty(
    "inert",
    false,
  );
  const openedAfterExit = page.waitForEvent("popup");
  await footer
    .getByRole("link", { name: "Learning terms", exact: true })
    .click();
  const afterExit = await openedAfterExit;
  expect(afterExit.url()).toBe(origin + "/learning/v4/terms");
  await expect(afterExit.locator("body")).toHaveText(
    documents["/learning/v4/terms"]!,
  );
  await afterExit.close();
  expect(state.signatures).toEqual(["SignIn"]);
});

test("settings offer no public results switch", async ({ page }) => {
  const state = await serveV4(page);
  await page.goto(state.url);
  await signIn(page);
  await openSettings(page);
  await expect(
    page.getByRole("button", { name: "Download private history", exact: true }),
  ).toHaveCount(0);
  // After Study, the menu offers only the private history download.
  await startStudy(page);
  await expect(studyHeading(page)).toBeVisible();
  await page.getByRole("button", { name: "Exit study" }).click();
  await openSettings(page);
  await expect(
    page.getByRole("button", { name: "Download private history", exact: true }),
  ).toHaveText("Download private history");
  await expect(
    page.getByRole("button", { name: /public results|turn.*off|turn.*on/i }),
  ).toHaveCount(0);
  expect(state.signatures).toEqual(["SignIn"]);
  expect(state.counts.revocations).toBe(0);
});

test("an account withdrawn earlier is restored by signing in", async ({
  page,
}) => {
  const state = await serveV4(page, { withdrawn: true });
  await page.goto(state.url);
  await signIn(page);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Signed in. Choose a song to study or sing." }),
  ).toHaveText("Signed in. Choose a song to study or sing.");
  // The old withdrawal is cleared, then the same sign-in text is signed once
  // more; nothing else is asked.
  expect(state.counts.turnedOn).toBe(1);
  expect(state.signatures).toEqual(["SignIn", "SignIn"]);
  expect(state.publicResults()).toBe("on");
  await startStudy(page);
  await expect(studyHeading(page)).toBeVisible();
  expect(state.counts.starts).toBe(1);
});

test("an account already on signs in once", async ({ page }) => {
  const state = await serveV4(page);
  await page.goto(state.url);
  await signIn(page);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Signed in. Choose a song to study or sing." }),
  ).toHaveText("Signed in. Choose a song to study or sing.");
  expect(state.counts.turnedOn).toBe(0);
  expect(state.signatures).toEqual(["SignIn"]);
});

test("a withdrawn account opening a Study link signs in straight into a lesson", async ({
  page,
}) => {
  const state = await serveV4(page, { withdrawn: true });
  await page.goto(state.studyUrl);
  await signIn(page);
  // Study opens only after the permission is settled, so it starts cleanly.
  await expect(studyHeading(page)).toBeVisible();
  await expect(
    page.getByText("Sign out, then sign in again to continue."),
  ).toHaveCount(0);
  expect(state.signatures).toEqual(["SignIn", "SignIn"]);
  expect(state.counts.starts).toBe(1);
});
