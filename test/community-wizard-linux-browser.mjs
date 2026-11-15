// UNRUN rendered-UI protocol regressions. Real Solid build + actual local HTTP
// and filesystem controller; controlled backend/naming/session only. These are
// not SSH, Linux process custody, encrypted recovery or second-host acceptance.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { createWizardServer } from "../apps/community-wizard/server/http.ts";
import { LinuxInputError } from "../packages/community-setup/shared-linux-profile.ts";
import {
  linuxFixture,
  fixtureProfile,
  fixtureCiphertext,
  fixtureKey,
} from "./community-wizard-linux-fixture.ts";
const require = createRequire(
  new URL("../apps/community-wizard/package.json", import.meta.url),
);
const { test, expect } = require("@playwright/test");
let f, server, origin;
test.beforeEach(async ({ context }) => {
  f = await linuxFixture({ timeoutMs: 2000 });
  server = createWizardServer(
    undefined,
    resolve("apps/community-wizard/dist"),
    { infisical: false, cloudflare: false },
    {
      linux: f.setup,
      authorizeLinux: async (req) => {
        if (req.headers.cookie !== "fixture_operator=paired")
          throw new LinuxInputError(
            "operator_pairing_required",
            "Pair this operator through the real bootstrap.",
          );
      },
    },
  );
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  origin = "http://127.0.0.1:" + server.address().port;
  await context.addCookies([
    { name: "fixture_operator", value: "paired", url: origin, httpOnly: true },
  ]);
});
test.afterEach(async () => {
  f.setup.cancel();
  await f.setup.settled();
  await new Promise((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  await f.dispose();
});
async function createSettings(page) {
  await page.goto(origin);
  await page
    .getByLabel("Community name", { exact: true })
    .fill("Fixture community");
  await page
    .getByLabel("Application HTTPS address", { exact: true })
    .fill(f.draft.origin);
  await page
    .getByLabel("Controlled TLD to import", { exact: true })
    .fill("fixture");
  await page
    .getByRole("button", { name: "Save setup settings", exact: true })
    .click();
  await expect(
    page.getByText("Unsaved changes.", { exact: false }),
  ).toHaveCount(0);
}
async function authorityAndPlan(page) {
  await page
    .getByRole("button", { name: "Discover current namespace binding", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Namespace: verified" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review whole application plan", exact: true })
    .click();
  await expect(
    page.getByText("Host fingerprint", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("I reviewed this exact host fingerprint", { exact: false })
    .check();
}
test("create derives an identifier, explains feature prerequisites and invokes one captured full-app operation", async ({
  page,
}) => {
  await page.goto(origin);
  await expect(page.getByLabel("Karaoke", { exact: true })).toBeDisabled();
  await expect(
    page.getByText("enable Learning first", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByLabel("Private Dance review", { exact: true }),
  ).toBeDisabled();
  await createSettings(page);
  await page
    .getByText("Advanced · community identifier", { exact: true })
    .click();
  await expect(
    page.getByLabel("Community identifier", { exact: true }),
  ).toHaveValue("fixture-community");
  await page
    .getByRole("button", { name: "Inspect host and continue", exact: true })
    .click();
  await authorityAndPlan(page);
  await page
    .getByRole("button", {
      name: "Deploy app and selected services",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Deployment · succeeded", exact: true }),
  ).toBeVisible();
  assert.equal(f.facts.nativeIntents.length, 1);
  const original = structuredClone(f.setup.snapshot().operation);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Deployment · succeeded", exact: true }),
  ).toBeVisible();
  assert.equal(f.setup.snapshot().operation.id, original.id);
  assert.equal(f.facts.nativeIntents.length, 1);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("unsaved target edits block inspect and review until the selected SSH host is saved", async ({
  page,
}) => {
  const seen = [],
    inspect = f.backend.inspectTarget;
  f.backend.inspectTarget = async (input) => {
    seen.push(structuredClone(input.target));
    return inspect(input);
  };
  await createSettings(page);
  await page
    .getByLabel("Linux host", { exact: true })
    .selectOption("ssh-linux");
  await page
    .getByLabel("SSH host", { exact: true })
    .fill("corrected-host.example");
  await page.getByLabel("SSH user", { exact: true }).fill("operator");
  await expect(
    page.getByRole("button", {
      name: "Inspect host and continue",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /Review & deploy/ }),
  ).toBeDisabled();
  expect(seen).toHaveLength(0);
  await page
    .getByRole("button", { name: "Save setup settings", exact: true })
    .click();
  await expect(page.getByText("Saved host:", { exact: false })).toContainText(
    "corrected-host.example",
  );
  await page
    .getByRole("button", { name: "Inspect host and continue", exact: true })
    .click();
  await expect(
    page.getByText("Host fingerprint:", { exact: false }),
  ).toBeVisible();
  expect(seen).toEqual([
    {
      kind: "ssh-linux",
      host: "corrected-host.example",
      user: "operator",
      port: 22,
      connectionRef: "ssh:owned",
    },
  ]);
  assert.equal(f.facts.nativeIntents.length, 0);
});
test("a reconciled failure permits correction and a reviewed descendant upgrade retaining the original resources", async ({
  page,
}) => {
  const observe = f.backend.observeResult;
  f.backend.observeResult = async ({ operation }) => ({
    revision: ++f.facts.revision,
    custody: "cleared",
    state: "failed",
    receiptRef: "receipt:failed",
    effects: "retained",
    identity: operation.plan.profile.identity,
    correction: "Fixture failure",
  });
  await createSettings(page);
  await page
    .getByRole("button", { name: "Inspect host and continue", exact: true })
    .click();
  await authorityAndPlan(page);
  await page
    .getByRole("button", {
      name: "Deploy app and selected services",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Deployment · failed", exact: true }),
  ).toBeVisible();
  const original = structuredClone(f.setup.snapshot().operation);
  await page.getByRole("button", { name: /Community & host/ }).click();
  await page
    .getByLabel("Community name", { exact: true })
    .fill("Corrected community");
  await page
    .getByRole("button", { name: "Save setup settings", exact: true })
    .click();
  await expect(
    page.getByText("Unsaved changes.", { exact: false }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Review & deploy/ }).click();
  await page
    .getByRole("button", { name: "Prepare current plan", exact: true })
    .click();
  await expect(
    page.getByText("Action: upgrade.", { exact: false }),
  ).toBeVisible();
  f.backend.observeResult = observe;
  await page
    .getByLabel("I reviewed this exact host fingerprint", { exact: false })
    .check();
  await page
    .getByRole("button", { name: "Apply reviewed upgrade", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Deployment · succeeded", exact: true }),
  ).toBeVisible();
  assert.deepEqual(f.setup.snapshot().history[0], original);
  assert.deepEqual(f.setup.snapshot().identity, original.plan.profile.identity);
});
test("import starts with a destination and adopts only the discovered installation", async ({
  page,
}) => {
  f.facts.existing = [fixtureProfile(f.draft)];
  await page.goto(origin);
  await page.getByLabel("Setup action", { exact: true }).selectOption("import");
  await expect(page.getByLabel("Community name", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Use this destination host", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inspect host and continue", exact: true })
    .click();
  await page.getByRole("button", { name: /Import Fixture community/ }).click();
  await authorityAndPlan(page);
  await page
    .getByRole("button", { name: "Adopt this installation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Deployment · succeeded", exact: true }),
  ).toBeVisible();
  assert.equal(f.setup.snapshot().operation.plan.action, "adopt");
  assert.deepEqual(f.setup.snapshot().identity, f.facts.existing[0].identity);
});
test("restore accepts ciphertext and a separate key before inheriting identity and explicit session policy on a second fixture host", async ({
  page,
}) => {
  await page.goto(origin);
  await page
    .getByLabel("Setup action", { exact: true })
    .selectOption("restore");
  await page
    .getByLabel("Linux host", { exact: true })
    .selectOption("ssh-linux");
  await page
    .getByLabel("SSH host", { exact: true })
    .fill("second-host.example");
  await page.getByLabel("SSH user", { exact: true }).fill("operator");
  await page
    .getByRole("button", { name: "Use this destination host", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Inspect host and continue", exact: true })
    .click();
  await expect(page.getByLabel("Community name", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Encrypted backup", { exact: true }).setInputFiles({
    name: "fixture-backup.pirate.enc",
    mimeType: "application/octet-stream",
    buffer: fixtureCiphertext,
  });
  await page
    .getByRole("button", { name: "Upload encrypted backup", exact: true })
    .click();
  await expect(
    page.getByLabel("Separate recovery key", { exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Separate recovery key", { exact: true })
    .fill("wrong-fixture-key");
  await page
    .getByRole("button", {
      name: "Authenticate and inspect backup",
      exact: true,
    })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "could not be authenticated",
  );
  await page
    .getByLabel("Separate recovery key", { exact: true })
    .fill(fixtureKey);
  await page
    .getByRole("button", {
      name: "Authenticate and inspect backup",
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Session recovery policy", { exact: true }),
  ).toHaveValue("revoke-existing");
  await expect(
    page.getByLabel("Separate recovery key", { exact: true }),
  ).toHaveValue("");
  await authorityAndPlan(page);
  await page
    .getByRole("button", { name: "Restore this community", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Deployment · succeeded", exact: true }),
  ).toBeVisible();
  assert.equal(f.setup.snapshot().operation.intent.kind, "restore");
  assert.deepEqual(
    f.setup.snapshot().identity,
    f.facts.restoreProfile.identity,
  );
  assert.equal(
    f.setup.snapshot().operation.plan.sessionPolicy,
    "revoke-existing",
  );
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  assert(!(await f.disk()).includes(fixtureKey));
});

test("server-running-setup wording distinguishes the inspected VPS from the browser computer", async ({
  page,
}) => {
  await page.goto(origin);
  await expect(
    page.getByRole("option", {
      name: "The server running this setup",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    page.getByText("authenticated SSH tunnel", { exact: false }),
  ).toBeVisible();
  await createSettings(page);
  await page
    .getByRole("button", { name: "Inspect host and continue", exact: true })
    .click();
  await expect(page.getByText("Saved host:", { exact: false })).toContainText(
    "Controlled Linux fixture target",
  );
  await expect(
    page.getByText("Host fingerprint:", { exact: false }),
  ).toContainText("fixture-host-fingerprint");
  assert.equal(f.facts.nativeIntents.length, 0);
});


// New current-Root entry cases. Original six cases above are byte-exact.
test("current Root hosting entry reaches the Linux flow and current scoped theme without invoking Cloudflare setup",async({page})=>{
 const paths=[];page.on("request",r=>paths.push(new URL(r.url()).pathname));
 await page.goto(origin+"/?setup=linux");
 await expect(page.getByRole("navigation",{name:"Hosting setup"})).toBeVisible();
 await expect(page.getByRole("link",{name:"Linux / existing VPS"})).toHaveAttribute("aria-current","page");
 await expect(page.getByLabel("Setup action",{exact:true})).toBeVisible();
 for(const value of ["create","import","restore"])await expect(page.locator('select[aria-label="Setup action"] option[value="'+value+'"]')).toHaveCount(1);
 await expect(page.locator(".linux-setup .field select").first()).toBeVisible();
 expect(await page.locator(".wizard-modes").evaluate(e=>getComputedStyle(e).borderBottomWidth)).toBe("1px");
 expect(paths).not.toContain("/api/state");assert.equal(f.facts.nativeIntents.length,0);
});
test("entry authentication errors stay visible instead of selecting the legacy app",async({page,context})=>{
 await context.clearCookies();const paths=[];page.on("request",r=>paths.push(new URL(r.url()).pathname));
 await page.goto(origin);
 await expect(page.getByRole("alert")).toContainText("Pair this operator");
 await expect(page.getByText("A home for your community",{exact:true})).toHaveCount(0);
 expect(paths).not.toContain("/api/state");assert.equal(f.facts.nativeIntents.length,0);
});
test("create can discover the installed signed profile before saving without deployment or invented technical IDs",async({page})=>{
 await page.goto(origin+"/?setup=linux");
 await page.getByRole("button",{name:"Discover installed community profile",exact:true}).click();
 await expect(page.getByLabel("Community name",{exact:true})).toHaveValue("Fixture community");
 await expect(page.getByLabel("Application HTTPS address",{exact:true})).toHaveValue(f.draft.origin);
 await expect(page.getByLabel("Controlled TLD to import",{exact:true})).toHaveValue(f.draft.namespace.tld);
 assert.equal(f.setup.snapshot().draft,null);assert.equal(f.facts.nativeIntents.length,0);
 await page.getByRole("button",{name:"Save setup settings",exact:true}).click();
 assert.equal(f.setup.snapshot().draft.version,2);
 assert.equal(f.setup.snapshot().draft.services.publicationProfile,f.capabilities.publicationSelection);
});
test("a Linux-only runner does not pretend to mount the preserved Cloudflare workflow",async({page})=>{
 const paths=[];page.on("request",r=>paths.push(new URL(r.url()).pathname));
 await page.goto(origin+"/?setup=cloudflare");
 await expect(page.getByText("This authenticated Linux runner does not mount Cloudflare setup.",{exact:false})).toBeVisible();
 await expect(page.getByText("A home for your community",{exact:true})).toHaveCount(0);
 expect(paths).not.toContain("/api/state");
 await page.getByRole("link",{name:"Linux / existing VPS"}).click();
 await expect(page.getByLabel("Setup action",{exact:true})).toBeVisible();
 assert.equal(f.facts.nativeIntents.length,0);
});
