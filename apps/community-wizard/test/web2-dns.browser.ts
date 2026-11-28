import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { hostedWizardFixture } from "../../../test/fixtures/web2-hosted-wizard.ts";

// The packaged browser rehearsal for community-owned DNS verification. The
// operator starts with the community name and custom hostname — before any
// wallet connection or enrollment preparation — sees the exact TXT challenge
// and routing records, exercises a wrong TXT value, retries successfully, and
// watches a hostname change invalidate the old proof. Then they continue to
// media storage and repeat the lost-reply recovery, still without enrollment.
test("operator proves DNS control before enrollment, then saves storage with lost-reply recovery", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  const previous = process.cwd();
  process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
  const signingOrigin = "https://signing.fixture.example";
  const f = await hostedWizardFixture({ signingOrigin, preVerifyDns: false });
  try {
    await context.addCookies([
      { name: "wizard_fixture", value: "paired", url: f.origin },
    ]);
    await page.goto(f.origin + "/?setup=linux-web2");
    await expect(
      page.getByRole("heading", { name: "Set up your HTTPS community" }),
    ).toBeVisible();

    // Before anything else: the web address step is present, and media
    // storage is not — it unlocks only after control is verified.
    await expect(
      page.getByRole("heading", { name: "Community web address" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Connect media storage" }),
    ).toHaveCount(0);

    // Community name and custom hostname first.
    const dnsSection = page.getByTestId("dns-section");
    await dnsSection
      .getByLabel("Community name", { exact: true })
      .fill("Harbor Lights");
    await dnsSection
      .getByLabel("Community web address", { exact: true })
      .fill("songs.example.com");
    await page
      .getByRole("button", { name: "Show DNS records", exact: true })
      .click();

    // The exact TXT challenge and routing instructions appear, in the
    // unresolved state: nothing verified yet.
    await expect(
      page.getByRole("heading", { name: "Verify domain control" }),
    ).toBeVisible();
    const txtName = await page.getByLabel("TXT record name").inputValue();
    expect(txtName).toBe("_pirate-challenge.songs.example.com");
    const txtValue = await page.getByLabel("TXT value").inputValue();
    expect(txtValue).toMatch(/^pirate-verify=[0-9a-f-]{36}$/);
    await expect(page.getByTestId("dns-routing")).toBeVisible();

    // A wrong TXT value at the right name: the check reports a mismatch,
    // never a verification.
    f.dnsAnswers.txt.set(txtName, ["pirate-verify=previous-code"]);
    await page
      .getByRole("button", { name: "Check the TXT record", exact: true })
      .click();
    await expect(page.getByTestId("dns-mismatch")).toBeVisible();
    await expect(page.getByTestId("dns-verified")).toHaveCount(0);

    // Correcting the record and retrying verifies the proof. Routing keeps
    // its own status throughout.
    f.dnsAnswers.txt.set(txtName, [txtValue]);
    f.dnsAnswers.a.set("songs.example.com", ["203.0.113.10"]);
    await page
      .getByRole("button", { name: "Check the TXT record", exact: true })
      .click();
    await expect(page.getByTestId("dns-verified")).toBeVisible();
    await expect(
      page.getByText("The TXT record confirms you control songs.example.com."),
    ).toBeVisible();
    await page.getByTestId("dns-routing").getByText("Route traffic").click();
    await expect(page.getByLabel("server IPv4 address")).toHaveValue("203.0.113.10");

    // Storage is now visible — still before any wallet or enrollment.
    await expect(
      page.getByRole("heading", { name: "Connect media storage" }),
    ).toBeVisible();

    // Changing the hostname invalidates the old proof: the challenge form
    // returns with a fresh code and the verified card is gone.
    await page
      .getByRole("button", { name: "Change address", exact: true })
      .first()
      .click();
    await dnsSection
      .getByLabel("Community web address", { exact: true })
      .fill("music.example.com");
    await page
      .getByRole("button", { name: "Show DNS records", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Verify domain control" }),
    ).toBeVisible();
    await expect(page.getByTestId("dns-verified")).toHaveCount(0);
    const newTxtValue = await page.getByLabel("TXT value").inputValue();
    expect(newTxtValue).not.toBe(txtValue);
    // Even publishing the old hostname's correct value cannot verify the new
    // hostname: the proof binds the exact name.
    f.dnsAnswers.txt.set("_pirate-challenge.music.example.com", [txtValue]);
    await page
      .getByRole("button", { name: "Check the TXT record", exact: true })
      .click();
    await expect(page.getByTestId("dns-mismatch")).toBeVisible();
    // The correct new value verifies.
    f.dnsAnswers.txt.set("_pirate-challenge.music.example.com", [newTxtValue]);
    await page
      .getByRole("button", { name: "Check the TXT record", exact: true })
      .click();
    await expect(page.getByTestId("dns-verified")).toBeVisible();

    // Continue to storage and repeat the lost-reply recovery, still with no
    // enrollment preparation anywhere in the run.
    await expect(
      page.getByRole("heading", { name: "Connect media storage" }),
    ).toBeVisible();
    const field = page.getByLabel("Filebase IPFS RPC API token");
    await field.fill("token-alpha");
    f.filebase.accepted.set("token-alpha", 3);
    const probesBefore = f.filebase.calls.length;
    await page.route(
      "**/api/web2/storage-save",
      async (route) => {
        const fetched = route.fetch();
        void fetched.catch(() => {});
        await fetched;
        await route.abort("failed");
      },
      { times: 1 },
    );
    await page
      .getByRole("button", { name: "Check and save token", exact: true })
      .click();
    // The reply is lost: the interrupted step offers recovery immediately,
    // without a refresh and without the token input.
    await expect(
      page.getByRole("button", { name: "Check saved token", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Filebase IPFS RPC API token")).toHaveCount(0);

    // A plain browser refresh keeps the interrupted step through the
    // retained non-secret request id.
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Check saved token", exact: true }),
    ).toBeVisible();
    // The DNS proof survives the same refresh unchanged.
    await expect(page.getByTestId("dns-verified")).toBeVisible();

    await page
      .getByRole("button", { name: "Check saved token", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Token saved" }),
    ).toBeVisible();
    // One provider probe across the entire run: the recovery reconciled the
    // original request instead of probing again.
    expect(f.filebase.calls.length).toBe(probesBefore + 1);
    // The token is nowhere in the page.
    const body = await page.content();
    expect(body).not.toContain("token-alpha");
  } finally {
    await f.close();
    process.chdir(previous);
  }
});
