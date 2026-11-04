import test from "node:test";
import assert from "node:assert/strict";
import { infisicalStore } from "../server/secrets.ts";
import type { Settings } from "../server/model.ts";

test("official SDK adapter uses exact scope, disables imports and retries partial secret saves", async (t) => {
  const originalFetch = globalThis.fetch;
  const names = [
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_SITE_URL",
  ];
  const originalEnv = names.map((name) => process.env[name]);
  t.after(() => {
    globalThis.fetch = originalFetch;
    names.forEach((name, i) => {
      if (originalEnv[i] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[i];
    });
  });
  process.env.INFISICAL_CLIENT_ID = "fixture-machine";
  process.env.INFISICAL_CLIENT_SECRET = "fixture-secret";
  process.env.INFISICAL_SITE_URL = "https://infisical.invalid";
  const settings: Settings = {
    name: "Fixture",
    slug: "fixture",
    accountId: "a".repeat(32),
    subdomain: "example",
    projectId: "00000000-0000-0000-0000-000000000001",
    environment: "dev",
    secretPath: "/communities/fixture",
    acrHost: "identify-eu-west-1.acrcloud.com",
    cloudconvert: false,
    tld: "",
    moderationMode: "independent",
  };
  const saved: Record<string, string> = {};
  const writes: string[] = [];
  let fail = true;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://infisical.invalid");
    if (url.pathname === "/api/v1/auth/universal-auth/login")
      return Response.json({
        accessToken: "fixture-access-token",
        expiresIn: 3600,
        tokenType: "Bearer",
      });
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer fixture-access-token",
    );
    if (init?.method === "GET") {
      assert.equal(url.searchParams.get("workspaceId"), settings.projectId);
      assert.equal(url.searchParams.get("secretPath"), settings.secretPath);
      assert.equal(url.searchParams.get("environment"), "dev");
      assert.equal(url.searchParams.get("expandSecretReferences"), "false");
      if (url.pathname === "/api/v3/secrets/raw") {
        assert.equal(url.searchParams.get("include_imports"), "false");
        assert.equal(url.searchParams.get("viewSecretValue"), "false");
        assert.equal(url.searchParams.get("recursive"), "false");
        return Response.json({
          secrets: Object.keys(saved).map((secretKey) => ({ secretKey })),
        });
      }
      assert.equal(url.searchParams.get("includeImports"), "false");
      const name = url.pathname.split("/").at(-1)!;
      return Response.json({
        secret: { secretKey: name, secretValue: saved[name] },
      });
    }
    const name = url.pathname.split("/").at(-1)!;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.workspaceId, settings.projectId);
    assert.equal(payload.secretPath, settings.secretPath);
    if (name === "ACRCLOUD_ACCESS_KEY" && fail)
      return Response.json({ message: "fixture denied" }, { status: 403 });
    writes.push(`${init?.method}:${name}`);
    saved[name] = payload.secretValue;
    return Response.json({
      secret: { secretKey: name, secretValue: payload.secretValue },
    });
  };
  const values = {
    OPENAI_API_KEY: "fixture-openai",
    ACRCLOUD_ACCESS_KEY: "fixture-acr",
    ACRCLOUD_ACCESS_SECRET: "fixture-acr-secret",
  };
  await assert.rejects(() => infisicalStore.save(settings, values));
  assert.equal(saved.OPENAI_API_KEY, "fixture-openai");
  fail = false;
  assert.deepEqual(
    (await infisicalStore.save(settings, values)).sort(),
    Object.keys(values).sort(),
  );
  assert.ok(writes.includes("PATCH:OPENAI_API_KEY"));
  assert.deepEqual(await infisicalStore.read(settings), values);
});
