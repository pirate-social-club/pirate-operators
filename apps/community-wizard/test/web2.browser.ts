import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { hostedWizardFixture } from "../../../test/fixtures/web2-hosted-wizard.ts";

test("actual hosted Web2 enrollment and gas authorization resume in the browser without reporting a missing installer as running", async ({
  page,
  context,
}, info) => {
  test.setTimeout(120000);
  const previous = process.cwd();
  // The real native chain fixture consumes repository-owned compiled artifacts.
  process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
  const signingOrigin="https://signing.fixture.example";
  const f = await hostedWizardFixture({ publishing: true, signingOrigin });
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
    const approveWindow=async(label:string)=>{
      const opening=page.waitForEvent("popup");
      await page.getByRole("button",{name:label,exact:true}).click();
      const popup=await opening;
      await popup.getByRole("button",{name:label==="Connect MOSS"?"Connect MOSS":"Review and sign",exact:true}).click();
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
    await page
      .getByLabel("Community name", { exact: true })
      .fill(f.prepareInput.name);
    await page.getByLabel("HTTPS community origin").fill(f.prepareInput.origin);
    await approveWindow("Connect MOSS");
    await expect(page.getByLabel("Owner wallet", {exact:true})).toHaveValue(f.prepareInput.controller);
    await page.getByLabel("Owner wallet", {exact:true}).fill(f.nominatedOwner);
    await page.getByLabel("I reviewed the controller, owner and server publisher").check();
    await page.getByLabel("Pilot invitation").fill(f.inviteToken);
    await page
      .getByLabel("I accept this pilot notice", { exact: false })
      .check();
    await page
      .getByRole("button", { name: "Prepare enrollment", exact: true })
      .click();
    await approveWindow("Authorize community registration");
    await expect(page.getByRole("alert")).toContainText("cancelled");
    expect((await f.state()).controllerAuthorized).toBe(false);
    changeAfterSign=true;
    await approveWindow("Authorize community registration");
    await expect(page.getByRole("alert")).toContainText("account_changed");
    expect((await f.state()).controllerAuthorized).toBe(false);
    accountChanged=false;
    await approveWindow("Authorize community registration");
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
    await page.getByRole("button", {name:"Review owner publishing"}).click();
    await expect(page.getByText(f.nominatedOwner, {exact:false}).first()).toBeVisible();
    await page.getByLabel("I reviewed the owner policy, window, destination and every service limit").check();
    await approveWindow("Authorize owner publishing");
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
    expect(signedTypes).toEqual(["HostedEnrollment","HostedEnrollment","HostedEnrollment","OwnerPublishingAuthorization"]);
    const before = f.broadcasts();
    await page.reload();
    await expect(
      page.getByText("Setup state: funded", { exact: true }),
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
      page.getByRole("button", {
        name: "Retry original gas allocation",
        exact: true,
      }),
    ).toBeDisabled();
    gate.release();
    await forwarded;
    await page.getByRole("button", { name: "Refresh retained setup" }).click();
    await expect(
      page.getByRole("button", {
        name: "Retry original gas allocation",
        exact: true,
      }),
    ).toBeEnabled();
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
