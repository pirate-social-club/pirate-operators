import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { hostedWizardFixture } from "../../../test/fixtures/web2-hosted-wizard.ts";

// The packaged browser rehearsal for community media storage: the operator
// enters the token once, the save reply is dropped after the server committed,
// and a plain browser refresh recovers the same generation through the
// retained non-secret request id — one provider probe, no second token entry.
test("operator saves the media token, loses the reply, and recovers the same generation after refresh", async ({
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
    const penpal = await readFile(new URL(import.meta.resolve("penpal")), "utf8");
    await context.exposeBinding("wizardFixtureAccount", () => ({
      status: "connected",
      network: "testnet",
      address: f.prepareInput.controller,
    }));
    await context.exposeBinding("wizardFixtureSign", async (_, typed: unknown) => {
      const signature = await f.sign(typed);
      return { status: "success", signature };
    });
    await context.route(signingOrigin + "/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const file = path === "/operator-signing" ? "moss-signing.html" : path.slice(1);
      if (!/^(moss-signing\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(file))
        return route.fulfill({ status: 404 });
      await route.fulfill({
        contentType: file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "text/javascript",
        headers: {
          "referrer-policy": "strict-origin",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        },
        body: await readFile("apps/community-wizard/dist/" + file),
      });
    });
    const initiateWindow = async (label: string) => {
      const opening = page.waitForEvent("popup");
      await page.getByRole("button", { name: label, exact: true }).click();
      const popup = await opening;
      if (!popup.isClosed()) await popup.waitForEvent("close");
    };
    await context.route("https://account.megaeth.com/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/fixture-penpal.mjs") {
        await route.fulfill({ contentType: "text/javascript", body: penpal });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script type="module">
        import {connect,WindowMessenger} from "/fixture-penpal.mjs";
        const account={status:"connected",network:"testnet",address:${JSON.stringify(f.prepareInput.controller)}};
        const connection=connect({messenger:new WindowMessenger({remoteWindow:parent,allowedOrigins:[${JSON.stringify(signingOrigin)}]}),methods:{
          status:()=>window.wizardFixtureAccount(),connect:async()=>window.wizardFixtureAccount(),
          signData:async({data})=>window.wizardFixtureSign(data)
        }});
        const remote=await connection.promise; await remote.ready();
        </script>`,
      });
    });

    await page.goto(f.origin + "/?setup=linux-web2");
    await expect(
      page.getByRole("heading", { name: "Set up your HTTPS community" }),
    ).toBeVisible();
    // DNS verification comes first; storage appears once control is proven,
    // before enrollment preparation.
    await expect(page.getByLabel("Filebase IPFS RPC API token")).toHaveCount(0);

    // DNS verification is the enrollment precondition: the operator proves
    // control of the community hostname first, and preparation consumes that
    // proof server-side rather than any typed-in origin.
    const verifyDns = async () => {
      const dnsSection = page.getByTestId("dns-section");
      await dnsSection.getByLabel("Community name", { exact: true }).fill(f.communityName);
      await dnsSection.getByLabel("Community web address", { exact: true }).fill(f.communityHostname);
      await page.getByRole("button", { name: "Show DNS records", exact: true }).click();
      const txtName = await page.getByLabel("TXT record name").inputValue();
      const txtValue = await page.getByLabel("TXT value").inputValue();
      f.dnsAnswers.txt.set(txtName, [txtValue]);
      await page.getByRole("button", { name: "Check the TXT record", exact: true }).click();
      await expect(page.getByTestId("dns-verified")).toBeVisible();
    };
    await verifyDns();
    await initiateWindow("Connect MOSS");
    await page.getByLabel("I reviewed the controller, owner and server publisher").check();
    await expect(page.getByLabel("Pilot invitation")).toHaveCount(0);
    await page.getByLabel("I accept this pilot notice", { exact: false }).check();
    await page.getByRole("button", { name: "Prepare enrollment", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Authorize the exact community installation" }),
    ).toBeVisible();

    // The storage step is now visible. The token field is masked and empty.
    await expect(
      page.getByRole("heading", { name: "Connect media storage" }),
    ).toBeVisible();
    const field = page.getByLabel("Filebase IPFS RPC API token");
    await expect(field).toHaveAttribute("type", "password");
    f.filebase.accepted.set("token-alpha", 3);

    // Drop the first save reply after the server has committed: the browser
    // sees a network failure, never the outcome.
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
    await field.fill("token-alpha");
    await page.getByRole("button", { name: "Check and save token", exact: true }).click();

    // The interrupted step appears; the token field is gone, not retained.
    await expect(
      page.getByRole("heading", { name: "Save confirmation interrupted" }),
    ).toBeVisible();
    await expect(page.getByLabel("Filebase IPFS RPC API token")).toHaveCount(0);

    // A plain browser refresh keeps the interrupted state: the non-secret
    // request id survived in session storage, the token did not.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Save confirmation interrupted" }),
    ).toBeVisible();

    // The operator checks the original save. The token was already committed;
    // the same generation appears without any new probe or re-entry.
    const probesBefore = f.filebase.calls.length;
    await page.getByRole("button", { name: "Check saved token", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Token saved", exact: true }),
    ).toBeVisible();
    expect(f.filebase.calls.length).toBe(probesBefore);
    expect(
      f.filebase.calls.filter((c) => c.path.includes("/pin/ls")).length,
    ).toBe(1);
    const state = await f.state();
    expect(state.mediaStorage?.state).toBe("saved");
    expect(state.mediaStorage?.generation).toBe(1);
    expect(state.mediaStorage?.pinCount).toBe(3);

    // The token itself never appears in the page or in any further input.
    const html = await page.content();
    expect(html.includes("token-alpha")).toBe(false);

    // A lost replacement reply offers recovery immediately — before any
    // refresh — with the token input hidden, because the pending request
    // outranks replacement mode.
    await page.getByText("Replace or revoke this token", { exact: true }).click();
    await page.getByRole("button", { name: "Replace token", exact: true }).click();
    await page.getByLabel("Filebase IPFS RPC API token").fill("token-beta");
    f.filebase.accepted.set("token-beta", 5);
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
    await page.getByRole("button", { name: "Check and save replacement", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Check saved token", exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Filebase IPFS RPC API token")).toHaveCount(0);
    const replaceProbes = f.filebase.calls.filter((c) => c.path.includes("/pin/ls")).length;
    // Reconciliation recovers the committed replacement generation and clears
    // replacement mode: the saved step renders with no further probe.
    await page.getByRole("button", { name: "Check saved token", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Token saved", exact: true }),
    ).toBeVisible();
    expect((await f.state()).mediaStorage?.generation).toBe(2);
    expect(
      f.filebase.calls.filter((c) => c.path.includes("/pin/ls")).length,
    ).toBe(replaceProbes);

    // A declined replacement says so honestly and writes nothing.
    await page.getByText("Replace or revoke this token", { exact: true }).click();
    await page.getByRole("button", { name: "Replace token", exact: true }).click();
    await page.getByLabel("Filebase IPFS RPC API token").fill("token-refused");
    await page.getByRole("button", { name: "Check and save replacement", exact: true }).click();
    await expect(page.getByRole("alert").first()).toContainText("Filebase declined this token");
    expect((await f.state()).mediaStorage?.generation).toBe(2);
  } finally {
    process.chdir(previous);
    await f.close();
  }
});
