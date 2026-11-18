import { expect, test, type Page } from "@playwright/test";
import { catalogPostId, origin, serveCommunity } from "./community-fixture.ts";

async function advertiseDanceOffers(page: Page) {
  await page.route(origin + "/api/capabilities", (route) =>
    route.fulfill({ json: {
      schema: "pirate.community-capabilities/1",
      signIn: true,
      creatorConnection: false,
      upload: false,
      publication: false,
      policyVersion: "fixture",
      danceRewardOffers: true,
    } }),
  );
}

test("the selected Dance-only drawing is discoverable on its song without a wallet", async ({ page }) => {
  const state = await serveCommunity(page, true, false, false, "strict-origin", { songs: true });
  await advertiseDanceOffers(page);
  let selected = false;
  const reads = () => state.events.filter((event) => event.path === "/api/rewards/offers");
  await page.route(origin + "/api/rewards/offers", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ json: {
      practiceOnly: true,
      offers: selected ? [{
        offerId: "selected_dance_fixture",
        postId: catalogPostId,
        drawingId: "11",
        opensAt: Date.UTC(2026, 10, 18),
        cutoffAt: Date.UTC(2026, 10, 19),
        ticketCount: 1,
        eligibility: "dance-pass",
      }] : [],
    } });
  });
  await page.goto(origin);
  await expect.poll(() => reads().length).toBe(1);
  await expect(page.getByRole("link", { name: "Wallet", exact: true })).toHaveCount(0);

  selected = true;
  await page.getByRole("link", { name: "Published fixture song", exact: true }).click();
  const post = page.locator("[data-public-post-state=content]");
  const panel = post.locator("details").filter({ hasText: "Lottery reward · 1 ticket" });
  await panel.locator("summary").click();
  await expect(panel.getByText(/Explicitly submit an eligible Dance recording/u)).toBeVisible();
  await expect(panel.getByText(/passing verdict from an authorized reviewer/u)).toBeVisible();
  await expect(panel.getByText(/Private practice and saved recordings without submission do not qualify/u)).toBeVisible();
  await expect(panel.getByText(/70%|90%|Scan your palm|shares appear in your wallet/u)).toHaveCount(0);
  await expect.poll(() => reads().length).toBe(2);
  await page.reload();
  await expect(panel.locator("summary")).toBeVisible();
  await expect.poll(() => reads().length).toBe(3);
  expect(state.events.filter((event) =>
    event.path.startsWith("/api/rewards/") &&
    (event.method !== "GET" || event.path !== "/api/rewards/offers"),
  )).toEqual([]);
});

test("a signed-out visitor does not load the selected learner drawing", async ({ page }) => {
  const state = await serveCommunity(page, false, false, false, "strict-origin", { songs: true });
  await advertiseDanceOffers(page);
  await page.goto(origin + "/#song-" + catalogPostId);
  const post = page.locator("[data-public-post-state=content]");
  await expect(post.getByRole("button", { name: "Play Published fixture song" })).toBeVisible();
  await expect(post.getByText(/Lottery reward/u)).toHaveCount(0);
  expect(state.events.filter((event) => event.path.startsWith("/api/rewards/"))).toEqual([]);
});
