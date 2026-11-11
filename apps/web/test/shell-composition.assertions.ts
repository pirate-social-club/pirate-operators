// Coordinator-isolated browser assertions, prepared but never run by this actor.
import { expect, type Page } from "@playwright/test";

/** Mount ShellCompositionPreview at 1440x1000 or 390x844 before invoking.
 * This checks the source-backed composition rather than a second mock layout.
 */
export async function assertCommunityComposition(page: Page, mobile: boolean) {
  await expect(page.locator("[data-community-page]")).toBeVisible();
  await expect(page.locator("header[data-appearance]")).toHaveCount(0);
  await expect(page.locator("[data-community-banner]")).toBeVisible();
  const tabs = page.locator("[data-community-tabs]");
  await expect(
    tabs.getByRole("button", { name: "Feed", exact: true }),
  ).toBeVisible();
  await tabs.getByRole("button", { name: "Songs", exact: true }).click();
  const card = page.locator("[data-community-post]").first();
  await expect(card.locator("[data-song-player]")).toHaveCount(1);
  await expect(
    card.getByRole("button", { name: "Play Fixture song a", exact: true }),
  ).toBeVisible();
  if (mobile) {
    await expect(
      page.getByRole("navigation", { name: "Primary navigation" }),
    ).toBeVisible();
  } else {
    const sidebar = page.getByRole("navigation", { name: "Main navigation" });
    await expect(sidebar).toBeVisible();
    await expect(
      sidebar.getByRole("link", { name: "Create", exact: true }),
    ).toHaveCount(0);
    await expect(
      sidebar
        .locator("..")
        .getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

/** Use the community-publisher input: supported Post sits beside identity. */
export async function assertPublisherPlacement(page: Page) {
  const identity = await page
    .getByRole("heading", { name: "Fixture Community", exact: true })
    .boundingBox();
  const post = page
    .locator("[data-community-post-slot]")
    .getByRole("button", { name: "Post", exact: true });
  await expect(post).toBeVisible();
  const action = await post.boundingBox();
  expect(identity).not.toBeNull();
  expect(action).not.toBeNull();
  // Source row can wrap on small screens; it still belongs to community chrome.
  await expect(
    page
      .locator("[data-community-chrome]")
      .getByRole("button", { name: "Post", exact: true }),
  ).toBeVisible();
  await post.click();
  await expect(page.locator("[data-shell-preview]")).toHaveAttribute(
    "data-last-action",
    "/#/publish",
  );
}

/** Use library-streaks, then remount library-unknown-history separately. */
export async function assertLibraryFacts(page: Page, known: boolean) {
  if (known) {
    const songs = page.getByRole("list", { name: "Your songs", exact: true });
    await expect(songs.getByRole("listitem")).toHaveCount(2);
    await expect(songs.getByRole("listitem").nth(0)).toContainText(
      "Fixture song c",
    );
    await expect(songs.getByRole("listitem").nth(1)).toContainText(
      "Fixture song a",
    );
    await expect(
      page.getByRole("list", { name: "Songs to learn", exact: true }),
    ).toContainText("Fixture song b");
  } else {
    await expect(
      page.getByRole("heading", { name: "Song history is coming soon" }),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Your songs", exact: true }),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("list", { name: "Songs to learn", exact: true })
        .getByRole("listitem"),
    ).toHaveCount(3);
  }
}

/** Inject a loader that rejects first, then returns fixtureProfileActivityPage.
 * Assert actual source error recovery/pagination and shared cards with no tabs.
 */
export async function assertProfileRecovery(page: Page) {
  await expect(page.locator("[data-profile-layout]")).toBeVisible();
  const activity = page.locator("[data-profile-activity]");
  await expect(activity.getByRole("alert")).toHaveText(
    "Posts could not be loaded.",
  );
  await activity
    .getByRole("button", { name: "Try again", exact: true })
    .click();
  await expect(activity.locator("[data-community-post]")).toHaveCount(1);
  await activity
    .getByRole("button", { name: "Load more", exact: true })
    .click();
  await expect(activity.locator("[data-community-post]")).toHaveCount(2);
  await expect(
    activity.getByRole("button", { name: "Load more", exact: true }),
  ).toHaveCount(0);
  await expect(activity.getByRole("tab")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Settings", exact: true }),
  ).toBeVisible();
}
