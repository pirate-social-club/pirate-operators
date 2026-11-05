import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { infisicalAuth } from "../server/infisical-auth.ts";
import { createInfisicalStore } from "../server/secrets.ts";
import { createSetup } from "../server/setup.ts";
import { createWizardServer } from "../server/http.ts";
import type { Settings } from "../server/model.ts";

const settings: Settings = {
  name: "Fixture",
  slug: "fixture",
  accountId: "a".repeat(32),
  subdomain: "example",
  projectId: "00000000-0000-0000-0000-000000000001",
  environment: "dev",
  secretPath: "/communities/fixture",

  cloudconvert: false,
  tld: "c22",
  moderationMode: "independent",
};
const values = {
  OPENAI_API_KEY: "fixture-openai",
};

test("CLI onboarding creates scoped folders, saves/readbacks, restores and redeploys without exposing auth", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wizard-onboarding-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const site = "https://infisical.invalid";
  const token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  let loggedIn = false;
  const auth = infisicalAuth({ INFISICAL_SITE_URL: site }, async (args) => {
    if (!loggedIn) throw new Error("fixture-session-secret");
    return args[0] === "login"
      ? JSON.stringify({
          sessions: [
            {
              principalType: "user",
              status: "authenticated",
              domain: site,
              profile: "fixture-profile",
              verification: { state: "verified" },
            },
          ],
        })
      : token;
  });
  const folders = new Map<string, Set<string>>([["/", new Set()]]);
  const created: string[] = [];
  const saved: Record<string, string> = {};
  let denyFolder = true;
  let denySecrets = false;
  let wrongReadback = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== site) return originalFetch(input, init);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${token}`,
    );
    const payload =
      init?.method === "GET"
        ? Object.fromEntries(url.searchParams)
        : JSON.parse(String(init?.body));
    assert.equal(payload.workspaceId, settings.projectId);
    assert.equal(payload.environment, settings.environment);
    if (url.pathname === "/api/v1/folders") {
      assert.ok(["/", "/communities"].includes(payload.path));
      if (init?.method === "GET") {
        assert.equal(payload.recursive, "false");
        return Response.json({
          folders: [...(folders.get(payload.path) ?? [])].map((name) => ({
            name,
          })),
        });
      }
      if (payload.name === "fixture" && denyFolder)
        return Response.json(
          { message: `fixture-provider-error ${token}` },
          { status: 403 },
        );
      const path = `${payload.path === "/" ? "" : payload.path}/${payload.name}`;
      created.push(path);
      folders.get(payload.path)!.add(payload.name);
      folders.set(path, new Set());
      if (payload.name === "fixture")
        return Response.json(
          { message: "fixture creation response uncertain" },
          { status: 409 },
        );
      return Response.json({ folder: { name: payload.name } });
    }
    assert.equal(payload.secretPath, settings.secretPath);
    if (denySecrets) return Response.json({ message: token }, { status: 403 });
    if (init?.method === "GET") {
      assert.equal(payload.expandSecretReferences, "false");
      if (url.pathname === "/api/v3/secrets/raw") {
        assert.equal(payload.include_imports, "false");
        assert.equal(payload.recursive, "false");
        assert.equal(payload.viewSecretValue, "false");
        return Response.json({
          secrets: Object.keys(saved).map((secretKey) => ({ secretKey })),
        });
      }
      assert.equal(payload.includeImports, "false");
      const name = url.pathname.split("/").at(-1)!;
      return Response.json({
        secret: {
          secretKey: name,
          secretValue: wrongReadback ? "fixture-stale" : saved[name],
        },
      });
    }
    const name = url.pathname.split("/").at(-1)!;
    assert.ok(Object.keys(values).includes(name));
    saved[name] = payload.secretValue;
    return Response.json({
      secret: { secretKey: name, secretValue: payload.secretValue },
    });
  };
  const store = createInfisicalStore(auth);
  const deployments: Record<string, string>[] = [];
  const provisioner = {
    async digest() {
      return "fixture-source";
    },
    async health() {},
    async deploy(_s: Settings, _p: unknown, secrets: Record<string, string>) {
      deployments.push(secrets);
    },
  };
  const setup = await createSetup(directory, store, provisioner);
  const server = createWizardServer(setup, directory, {
    infisical: true,
    cloudflare: true,
    stateProtection: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const initial = await (await fetch(`${origin}/api/state`)).json();
  const post = (path: string, body: unknown, csrf = initial.csrf) =>
    fetch(`${origin}/api/${path}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Wizard-Token": csrf,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post("infisical/connect", {}, "")).status, 403);
  assert.equal((await post("settings", settings)).status, 200);
  await assert.rejects(() => setup.saveSecrets(values), /Connect Infisical/);
  assert.equal((await post("infisical/connect", {})).status, 409);
  loggedIn = true;
  const failed = await post("infisical/connect", {});
  assert.equal(failed.status, 502);
  assert.ok(!(await failed.text()).includes(token));
  assert.equal(setup.snapshot().infisical?.connected, false);
  denyFolder = false;
  assert.equal((await post("infisical/connect", {})).status, 200);
  assert.equal((await post("infisical/connect", {})).status, 200);
  assert.deepEqual(created, ["/communities", "/communities/fixture"]);
  wrongReadback = true;
  assert.equal((await post("secrets", values)).status, 409);
  assert.deepEqual(setup.snapshot().secrets, []);
  wrongReadback = false;
  await setup.connectSecrets();
  await setup.saveSecrets(values);
  await setup.review();
  await setup.deploy({ planId: setup.snapshot().plan!.id });
  await setup.settled();
  assert.deepEqual(deployments, [values]);
  const persisted = await readFile(join(directory, "setup.json"), "utf8");
  const exposed = JSON.stringify(
    await (await fetch(`${origin}/api/state`)).json(),
  );
  for (const secret of [token, ...Object.values(values), "fixture-profile"])
    assert.ok(!persisted.includes(secret) && !exposed.includes(secret));
  assert.equal(JSON.parse(persisted).secretStoreSite, site);
  const restored = await createSetup(directory, store, provisioner);
  assert.equal(restored.snapshot().infisical?.connected, false);
  await assert.rejects(
    () => restored.deploy({ planId: restored.snapshot().plan!.id }),
    /Connect Infisical/,
  );
  await restored.connectSecrets();
  saved.OPENAI_API_KEY = "fixture-rotated-openai";
  await restored.review();
  await restored.deploy({ planId: restored.snapshot().plan!.id });
  await restored.settled();
  assert.equal(deployments[1].OPENAI_API_KEY, saved.OPENAI_API_KEY);
  const moved = await createSetup(
    directory,
    createInfisicalStore(
      infisicalAuth(
        { INFISICAL_SITE_URL: "https://other.invalid" },
        async () => {
          throw new Error("must not request token");
        },
      ),
    ),
    provisioner,
  );
  await assert.rejects(
    () => moved.connectSecrets(),
    /bound to another Infisical/,
  );
  denySecrets = true;
  await assert.rejects(() => restored.connectSecrets());
  assert.equal(restored.snapshot().infisical?.connected, false);
});

test("managed mode never obtains a CLI session or prepares provider storage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wizard-managed-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const store = createInfisicalStore(
    infisicalAuth({}, async () => {
      calls++;
      throw new Error("CLI must not run");
    }),
  );
  const setup = await createSetup(directory, store, {
    async digest() {
      return "fixture-source";
    },
    async health() {},
    async deploy() {},
  });
  await setup.configure({ ...settings, moderationMode: "pirate" });
  await assert.rejects(() => setup.connectSecrets(), /independent-mode/);
  await setup.review();
  await setup.deploy({ planId: setup.snapshot().plan!.id });
  await setup.settled();
  assert.equal(calls, 0);
  assert.equal(setup.snapshot().deployment, "provisioned");
});
