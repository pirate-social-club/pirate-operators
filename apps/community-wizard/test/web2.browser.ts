import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { hostedWizardFixture } from "../../../test/fixtures/web2-hosted-wizard.ts";

test("actual hosted Web2 enrollment installs before registration and resumes in the browser without an invitation", async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const previous = process.cwd();
  // The real native chain fixture consumes repository-owned compiled artifacts.
  process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
  const signingOrigin="https://signing.fixture.example";
  const f = await hostedWizardFixture({ publishing: true, signingOrigin, preVerifyDns: false, scriptedInstallation: true, failFirstApply: true });
  try {
    await context.addCookies([
      { name: "wizard_fixture", value: "paired", url: f.origin },
    ]);
    // Controlled normal SDK iframe transport. No passkey/account emulator.
    const penpal = await readFile(new URL(import.meta.resolve("penpal")), "utf8");
    let cancel = true, changeAfterSign = false, accountChanged = false;
    await context.exposeBinding("wizardFixtureAccount",()=>({status:"connected",network:"testnet",address:accountChanged?f.nominatedOwner:f.prepareInput.controller}));
    const signedTypes: string[] = [];
    await context.exposeBinding("wizardFixtureSign", async (_,typed: unknown) => {
      const data = typed as { primaryType: string };
      signedTypes.push(data.primaryType);
      if (cancel) { cancel = false; return { status: "cancelled" }; }
      const signature=await f.sign(typed);
      if(changeAfterSign){changeAfterSign=false;accountChanged=true;}
      return { status: "success", signature };
    });
    await context.route(signingOrigin+"/**",async route=>{
      const path=new URL(route.request().url()).pathname;
      const file=path==="/operator-signing"?"moss-signing.html":path.slice(1);
      if(!/^(moss-signing\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(file))return route.fulfill({status:404});
      await route.fulfill({contentType:file.endsWith(".html")?"text/html":file.endsWith(".css")?"text/css":"text/javascript",headers:{
        "referrer-policy":"strict-origin","x-content-type-options":"nosniff","cache-control":"no-store","x-frame-options":"DENY","cross-origin-opener-policy":"unsafe-none",
        "content-security-policy":"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.megaeth.com; frame-src https://*.megaeth.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "permissions-policy":'publickey-credentials-get=(self "https://account.megaeth.com"), publickey-credentials-create=(self "https://account.megaeth.com")',
      },body:await readFile("apps/community-wizard/dist/"+file)});
    });
    const initiateWindow=async(label:string)=>{
      const opening=page.waitForEvent("popup");
      await page.getByRole("button",{name:label,exact:true}).click();
      const popup=await opening;
      // The initiating Wizard action starts native MOSS directly. Both success
      // and native cancellation return through the same owned-window close.
      if(!popup.isClosed())await popup.waitForEvent("close");
    };
    await context.route("https://account.megaeth.com/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/fixture-penpal.mjs") {
        await route.fulfill({ contentType: "text/javascript", body: penpal });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><script type="module">
        import {connect,WindowMessenger} from "/fixture-penpal.mjs";
        const account={status:"connected",network:"testnet",address:${JSON.stringify(f.prepareInput.controller)}};
        const connection=connect({messenger:new WindowMessenger({remoteWindow:parent,allowedOrigins:[${JSON.stringify(signingOrigin)}]}),methods:{
          status:()=>window.wizardFixtureAccount(),connect:async()=>window.wizardFixtureAccount(),
          signData:async({data})=>window.wizardFixtureSign(data)
        }});
        const remote=await connection.promise; await remote.ready();
        </script>` });
    });
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
    await expect(page.getByLabel("Owner wallet", {exact:true})).toHaveValue(f.prepareInput.controller);
    await page.getByLabel("Owner wallet", {exact:true}).fill(f.nominatedOwner);
    await page.getByLabel("I reviewed the controller, owner and server publisher").check();
    await page
      .getByLabel("I accept this pilot notice", { exact: false })
      .check();
    await page
      .getByRole("button", { name: "Prepare enrollment", exact: true })
      .click();
    await initiateWindow("Authorize the exact community installation");
    await expect(page.getByRole("alert")).toContainText("cancelled");
    expect((await f.state()).controllerAuthorized).toBe(false);
    changeAfterSign=true;
    await initiateWindow("Authorize the exact community installation");
    await expect(page.getByRole("alert")).toContainText("account_changed");
    expect((await f.state()).controllerAuthorized).toBe(false);
    accountChanged=false;
    await initiateWindow("Authorize the exact community installation");
    await page.getByRole("button", { name: "Review Linux installation" }).click();
    await expect(page.getByText("using the authorized controller and publisher", { exact: false })).toBeVisible();
    await page.getByLabel("I reviewed this installation on the selected host.").check();
    const broadcastsBeforeRegistration = f.broadcasts();
    await initiateWindow("Install reviewed community");
    expect(signedTypes.filter((type) => type === "InstallationPlan")).toHaveLength(1);
    expect(f.broadcasts()).toBe(broadcastsBeforeRegistration);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Install reviewed community" }),
    ).toBeVisible();
    await page.getByLabel("I reviewed this installation on the selected host.").check();
    f.dropRedeemReply();
    await page.getByRole("button", { name: "Install reviewed community" }).click();
    expect(signedTypes.filter((type) => type === "InstallationPlan")).toHaveLength(1);
    await expect.poll(() => f.broadcasts()).toBe(broadcastsBeforeRegistration + 1);
    await expect.poll(async () => (await f.state()).busy).toBe(false);
    await f.mine();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Set up your HTTPS community" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Reconcile original enrollment" })
      .first()
      .click();
    await expect(
      page.getByRole("button", {
        name: "Authorize initial gas allocation",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {name:"Review owner publishing"}),
    ).toBeVisible();
    await page.getByLabel("Nominated owner wallet", {exact:true}).fill(f.nominatedOwner);
    await page.getByLabel("I reviewed the controller, owner and server publisher for publishing").check();
    await page.getByRole("button", {name:"Review owner publishing"}).click();
    await expect(page.getByText(f.nominatedOwner, {exact:false}).first()).toBeVisible();
    await page.getByLabel("I reviewed the owner policy, window, destination and every service limit").check();
    await initiateWindow("Authorize owner publishing");
    await expect(page.getByRole("button",{name:"Attach reviewed publishing grant",exact:true})).toBeEnabled();
    const acceptedBefore=JSON.parse(await readFile(f.signingJournal,"utf8")).accepted;
    expect(acceptedBefore).not.toBeNull();
    f.loseAttachmentReply("before");
    await page.getByRole("button", {name:"Attach reviewed publishing grant"}).click();
    await expect(page.getByRole("alert")).toHaveText("The managed service has not confirmed this exact grant admission. Reconcile the retained attachment before retrying.");
    await page.reload();
    await page.getByRole("button",{name:"Reconcile original publishing attachment",exact:true}).click();
    await page.getByRole("button",{name:"Attach reviewed publishing grant",exact:true}).click();
    await expect(page.getByText("Publishing grant attached",{exact:true})).toBeVisible();
    expect(JSON.parse(await readFile(f.signingJournal,"utf8")).accepted).toEqual(acceptedBefore);
    expect(f.attachmentEffects()).toBe(1);
    expect(signedTypes).toEqual(["HostedEnrollment","HostedEnrollment","HostedEnrollment","InstallationPlan","OwnerPublishingAuthorization"]);
    const before = f.broadcasts();
    await page.reload();
    await expect(
      page.getByText("Setup state: running", { exact: true }),
    ).toBeVisible();
    expect(f.broadcasts()).toBe(before);
    const gate = f.holdNextStatus();
    let forwarded: Promise<unknown> = Promise.resolve();
    await page.route(
      "**/api/web2/reconcile",
      async (route) => {
        forwarded = route.fetch();
        void forwarded.catch(() => {});
        await gate.entered;
        await route.abort("failed");
      },
      { times: 1 },
    );
    await page
      .getByRole("button", { name: "Reconcile original enrollment" })
      .click();
    await gate.entered;
    // The server is actually awaiting its hosted response after the browser
    // loses its reply. Reads remain usable; mutations stay locked.
    await expect(
      page.getByRole("button", { name: "Refresh retained setup" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Reconcile original enrollment" }),
    ).toBeDisabled();
    gate.release();
    await forwarded;
    await page.getByRole("button", { name: "Refresh retained setup" }).click();
    await expect(
      page.getByRole("button", { name: "Reconcile original enrollment" }),
    ).toBeEnabled();
    expect(f.broadcasts()).toBe(before);
    await expect(
      page.getByText("Last installation observation: running", { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    expect(
      requests.some((r) => r.path === "/api/web2/topup" && r.method === "POST"),
    ).toBe(false);
    expect(
      requests.some(
        (r) =>
          r.path.startsWith("/api/linux/namespace") ||
          r.path === "/api/secrets",
      ),
    ).toBe(false);
    await page.screenshot({
      path: info.outputPath("web2-automatic-registration.png"),
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
    const artifact = await f.artifact("browser", await f.state());
    await info.attach("execution-evidence.json", {
      path: resolve(artifact),
      contentType: "application/json",
    });
  } finally {
    await f.close();
    process.chdir(previous);
  }
});
