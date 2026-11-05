import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("the actual managed Worker bundle starts in workerd and rejects unsigned work without leaking bindings", async () => {
  const output = await build({
    entryPoints: ["services/managed-moderation.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2024",
    external: ["node:*"],
    minify: true,
    logLevel: "silent",
  });
  const origin = "https://moderation.example",
    hex = (n: number) => `0x${String(n).repeat(64)}`;
  const mf = new Miniflare({
    modules: true,
    script: output.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    r2Buckets: ["MEDIA"],
    queueProducers: { JOBS: "fixture-jobs" },
    bindings: {
      SERVICE_ORIGIN: origin,
      SERVICE_PROFILE_HASH: hex(1),
      PAIRINGS_JSON: "[]",
      DIRECTORY_PROFILES_JSON: "[]",
      SERVICE_BUDGET_PERIOD: "fixture-run",
      SERVICE_REQUEST_CAP: "10",
      ACRCLOUD_HOST: "identify-eu-west-1.acrcloud.com",
      ACRCLOUD_ACCESS_KEY: "fixture-acr-key",
      ACRCLOUD_ACCESS_SECRET: "fixture-acr-secret",
      OPENAI_API_KEY: "fixture-openai-key",
      MODERATION_SIGNER_PRIVATE_KEY: hex(1),
    },
  });
  try {
    const health = await mf.dispatchFetch(origin + "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      service: "pirate-managed-moderation/1",
      status: "available",
      profileHash: hex(1),
    });
    const denied = await mf.dispatchFetch(origin + "/v1/admissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(denied.status, 400);
    assert.deepEqual(await denied.json(), { error: "invalid_fields" });
    assert.equal(
      (await mf.dispatchFetch("https://unpaired.example/health")).status,
      403,
    );
    const database = await mf.getD1Database("DB");
    assert.equal(
      (await database
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='moderation_provider_calls'",
        )
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await mf.dispose();
  }
});
