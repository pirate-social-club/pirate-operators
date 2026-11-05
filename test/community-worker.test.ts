import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { firstSong } from "../services/first-song-profile.ts";

test("compiled community Worker reaches its native health adapter in workerd and refuses a redirect", async () => {
  const bundle = await build({
    entryPoints: ["services/community-application.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2024",
    external: ["node:*"],
    minify: true,
    logLevel: "silent",
  });
  const creatorProfile = `0x${"b".repeat(64)}`;
  let redirect = false,
    requests = 0;
  const runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    d1Databases: ["DB"],
    bindings: {
      PLAN_ID: firstSong.planId,
      APPLICATION_PROFILE_HASH: `0x${"a".repeat(64)}`,
      CREATOR_PROFILE_HASH: creatorProfile,
    },
    outboundService: async (request: { url: string }) => {
      assert.equal(
        request.url,
        "https://pirate-wallet-test.piratesocialclub.workers.dev/api/health",
      );
      requests++;
      return redirect
        ? new Response(null, {
            status: 302,
            headers: { location: "https://attacker.invalid/" },
          })
        : Response.json({ profileHash: creatorProfile, testnet: true });
    },
  });
  try {
    const db = await runtime.getD1Database("DB");
    for (const name of [
      "0001_setup.sql",
      "0002_first_song.sql",
      "0003_publication_journal.sql",
      "0004_creator_connection.sql",
    ]) {
      const sql = await readFile(
        `apps/community-wizard/infra/migrations/${name}`,
        "utf8",
      );
      await db.batch(
        sql
          .replace(/--[^\n]*/g, "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
    }
    const available = await runtime.dispatchFetch(firstSong.origin + "/health");
    assert.equal(available.status, 200);
    assert.equal(
      ((await available.json()) as { creatorConnection: string })
        .creatorConnection,
      "available",
    );
    assert.equal(requests, 1);
    redirect = true;
    const unavailable = await runtime.dispatchFetch(
      firstSong.origin + "/health",
    );
    assert.equal(
      ((await unavailable.json()) as { creatorConnection: string })
        .creatorConnection,
      "unavailable",
    );
    assert.equal(requests, 2); // No follow to an untrusted destination.
  } finally {
    await runtime.dispose();
  }
});
