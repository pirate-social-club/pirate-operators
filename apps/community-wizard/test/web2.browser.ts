import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { hostedWizardFixture } from "../../../test/fixtures/web2-hosted-wizard.ts";

test("actual hosted Web2 enrollment and gas authorization resume in the browser without reporting a missing installer as running", async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const previous = process.cwd();
  // The real native chain fixture consumes repository-owned compiled artifacts.
  process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
  const f = await hostedWizardFixture();
  try {
    await context.addCookies([
      { name: "wizard_fixture", value: "paired", url: f.origin },
    ]);
    await page.exposeFunction(
      "wizardFixtureSign",
      (actor: string, typed: unknown) => {
        // A real JSON-RPC wallet requires this domain declaration. The viem
        // account signer below would otherwise silently supply it itself.
        expect(
          (typed as { types: { EIP712Domain: unknown } }).types.EIP712Domain,
        ).toEqual([
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ]);
        return f.sign(typed, actor as `0x${string}`);
      },
    );
    await page.addInitScript(
      ({ accounts, chain }) => {
        Object.defineProperty(window, "ethereum", {
          value: {
            async request(input: { method: string; params?: string[] }) {
              if (input.method === "eth_chainId") return chain;
              if (input.method === "eth_requestAccounts") return accounts;
              if (input.method === "eth_signTypedData_v4")
                return (
                  window as unknown as {
                    wizardFixtureSign(
                      actor: string,
                      typed: unknown,
                    ): Promise<string>;
                  }
                ).wizardFixtureSign(
                  input.params![0]!,
                  JSON.parse(input.params![1]!),
                );
              throw Error("Unexpected fixture wallet transport method");
            },
          },
        });
      },
      {
        accounts: [f.prepareInput.controller, f.prepareInput.publisher],
        chain: "0x" + (6343).toString(16),
      },
    );
    const requests: Array<{ path: string; method: string }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/"))
        requests.push({ path: url.pathname, method: request.method() });
    });
    await page.goto(f.origin + "/?setup=linux-web2");
    await expect(
      page.getByRole("heading", { name: "Set up your HTTPS community" }),
    ).toBeVisible();
    await page
      .getByLabel("Community name", { exact: true })
      .fill(f.prepareInput.name);
    await page.getByLabel("HTTPS community origin").fill(f.prepareInput.origin);
    await page
      .getByLabel("Controller address", { exact: true })
      .fill(f.prepareInput.controller);
    await page
      .getByLabel("Publisher address", { exact: true })
      .fill(f.prepareInput.publisher);
    await page.getByLabel("Pilot invitation").fill(f.inviteToken);
    await page
      .getByLabel("I accept this pilot notice", { exact: false })
      .check();
    await page
      .getByRole("button", { name: "Prepare enrollment", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Authorize community registration",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", { name: "Reconcile original enrollment" }),
    ).toBeEnabled();
    await f.mine();
    await page
      .getByRole("button", { name: "Reconcile original enrollment" })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Authorize initial gas allocation",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Authorize initial gas allocation",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Retry original gas allocation",
        exact: true,
      }),
    ).toBeEnabled();
    await f.mine();
    await page
      .getByRole("button", { name: "Reconcile original enrollment" })
      .click();
    await expect(
      page.getByText("Setup state: funded", { exact: true }),
    ).toBeVisible();
    const before = f.broadcasts();
    await page.reload();
    await expect(
      page.getByText("Setup state: funded", { exact: true }),
    ).toBeVisible();
    expect(f.broadcasts()).toBe(before);
    await expect(
      page.getByText("The real Linux Web2 installer is unavailable.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Install reviewed community" }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    expect(
      requests.some((r) => r.path === "/api/web2/topup" && r.method === "POST"),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.path.startsWith("/api/linux/namespace") ||
          r.path === "/api/secrets",
      ),
    ).toBe(false);
    await page.screenshot({
      path: info.outputPath("web2-funded-installer-unavailable.png"),
      fullPage: true,
    });
    await info.attach("public-enrollment.json", {
      body: JSON.stringify(await f.state()),
      contentType: "application/json",
    });
    await info.attach("requests.json", {
      body: JSON.stringify(requests),
      contentType: "application/json",
    });
    await f.artifact("browser", await f.state());
  } finally {
    await f.close();
    process.chdir(previous);
  }
});
