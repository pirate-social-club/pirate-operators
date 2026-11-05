import { defaultContentProfile } from "../packages/moderation/content-profile.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { signServiceRequest } from "../packages/moderation/pairing.ts";
import { creatorPublisherFixture } from "./creator-connection-keys.ts";
import { firstSong } from "../services/first-song-profile.ts";

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
      SERVICE_CHECKS: "recognition",
      CONTENT_PROFILE_JSON: JSON.stringify(defaultContentProfile),
      OPENAI_API_KEY: "fixture-openai-key",
      MODERATION_SIGNER_PRIVATE_KEY: hex(1),
    },
  });
  try {
    const health = await mf.dispatchFetch(origin + "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      service: "pirate-admission-service/2",
      status: "available",
      profileHash: hex(1),
    });
    const denied = await mf.dispatchFetch(origin + "/v2/admissions", {
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

test("actual managed Worker authorizes a scoped request then reaches RPC without redirect support assumptions", async () => {
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
    profile = firstSong.directoryProfile,
    pairing = {
      communityId: profile.communityId,
      registry: profile.registry,
      directory: profile.directory,
      controller: "0x274f223809f00cbdd51d05de3abc8fd3368fde16",
      communityOrigin: firstSong.origin,
      serviceOrigin: origin,
      enabled: true,
      budgetPeriod: "fixture-run",
      requestCap: 10,
    };
  let redirect = false,
    calls = 0;
  const mf = new Miniflare({
    modules: true,
    script: output.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    d1Databases: ["DB"],
    r2Buckets: ["MEDIA"],
    queueProducers: { JOBS: "fixture-jobs" },
    bindings: {
      SERVICE_ORIGIN: origin,
      SERVICE_PROFILE_HASH: `0x${"1".repeat(64)}`,
      PAIRINGS_JSON: JSON.stringify([pairing]),
      DIRECTORY_PROFILES_JSON: JSON.stringify([profile]),
      SERVICE_BUDGET_PERIOD: "fixture-run",
      SERVICE_REQUEST_CAP: "10",
      ACRCLOUD_HOST: "identify-eu-west-1.acrcloud.com",
      ACRCLOUD_ACCESS_KEY: "fixture-key",
      ACRCLOUD_ACCESS_SECRET: "fixture-secret",
      SERVICE_CHECKS: "recognition",
      CONTENT_PROFILE_JSON: JSON.stringify(defaultContentProfile),
      OPENAI_API_KEY: "fixture-key",
      MODERATION_SIGNER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    },
    outboundService: async (request: {
      url: string;
      json(): Promise<{ id: number; method: string }>;
    }) => {
      assert.equal(request.url, "https://carrot.megaeth.com/rpc");
      calls++;
      if (redirect)
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/" },
        });
      const body = await request.json();
      assert.equal(body.method, "eth_chainId");
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x7a69" });
    },
  });
  try {
    const now = Math.floor(Date.now() / 1000),
      wire = await signServiceRequest(
        creatorPublisherFixture,
        {
          action: "status",
          communityId: profile.communityId,
          communityOrigin: firstSong.origin,
          serviceOrigin: origin,
          configurationRevision: 1,
          nonce: `0x${"a".repeat(64)}`,
          issuedAt: now,
          expiresAt: now + 300,
        },
        {},
      ),
      send = () =>
        mf.dispatchFetch(origin + "/v2/admissions/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(wire),
        });
    const wrongChain = await send();
    assert.deepEqual(await wrongChain.json(), {
      error: "wrong_application_chain",
    });
    assert.equal(calls, 1);
    redirect = true;
    assert.equal((await send()).status, 503);
    assert.equal(calls, 2);
  } finally {
    await mf.dispose();
  }
});
