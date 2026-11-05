import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { preparePin } from "../packages/community/ipfs.ts";
import { fundedPin } from "../packages/release/pin-operations.ts";

async function fixture() {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  const db = await runtime.getD1Database("DB");
  for (const path of [
    "apps/managed-moderation/migrations/0001_managed.sql",
    "packages/release/pin-schema.sql",
  ]) {
    const sql = await readFile(path, "utf8");
    await db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
  return { db, dispose: () => runtime.dispose() };
}
const id = `0x${"1".repeat(64)}`,
  grant = {
    sha256: `0x${"2".repeat(64)}`,
    period: "fixture-v1",
    maximumAdds: 1,
  };
test("a lost pin-add response reconciles by the fixed root without another purchase and respects the finite grant", async () => {
  const f = await fixture();
  try {
    const bytes = new TextEncoder().encode("explicit public pin fixture"),
      intent = await preparePin(bytes, "application/json"),
      cid = intent.uri.slice(7);
    let adds = 0,
      retained = false,
      available = true;
    const send = async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/v0/add") {
        adds++;
        retained = true;
        throw new Error("fixture lost response after add");
      }
      if (url.pathname === "/api/v0/pin/ls")
        return Response.json({
          Keys: retained ? { [cid]: { Type: "recursive" } } : {},
        });
      return available
        ? new Response(bytes)
        : new Response("unavailable", { status: 503 });
    };
    assert.deepEqual(
      await fundedPin(f.db, id, grant, intent, bytes, "fixture-token", send),
      { state: "uncertain" },
    );
    assert.equal(adds, 1);
    const result = await fundedPin(
      f.db,
      id,
      grant,
      intent,
      bytes,
      "fixture-token",
      send,
    );
    assert.equal(result.state, "confirmed");
    assert.equal(adds, 1);
    assert.deepEqual(
      await fundedPin(f.db, id, grant, intent, bytes, "fixture-token", send),
      result,
    );
    const budget = await f.db
      .prepare("SELECT reserved,spent FROM spending_budgets")
      .first();
    assert.deepEqual(budget, { reserved: "0", spent: "1" });
    await assert.rejects(
      fundedPin(
        f.db,
        `0x${"3".repeat(64)}`,
        grant,
        intent,
        bytes,
        "fixture-token",
        send,
      ),
      /funding_cap_exhausted/,
    );
    available = false;
    assert.deepEqual(
      await fundedPin(f.db, id, grant, intent, bytes, "fixture-token", send),
      { state: "uncertain" },
    );
    assert.equal(adds, 1);
  } finally {
    await f.dispose();
  }
});
test("an absent result after a started add stays reserved and never authorizes a second add", async () => {
  const f = await fixture();
  try {
    const bytes = new TextEncoder().encode("explicit absent pin fixture"),
      intent = await preparePin(bytes, "application/json");
    let adds = 0;
    const send = async (request: Request) => {
      if (new URL(request.url).pathname === "/api/v0/add") {
        adds++;
        throw new Error("fixture unknown send");
      }
      return Response.json({ Keys: {} });
    };
    for (let i = 0; i < 3; i++)
      assert.deepEqual(
        await fundedPin(f.db, id, grant, intent, bytes, "fixture-token", send),
        { state: "uncertain" },
      );
    assert.equal(adds, 1);
    assert.deepEqual(
      await f.db.prepare("SELECT reserved,spent FROM spending_budgets").first(),
      { reserved: "1", spent: "0" },
    );
  } finally {
    await f.dispose();
  }
});

test("read-only pin status never creates an intent, reserves quota or sends an add", async () => {
  const f = await fixture();
  try {
    const bytes = new TextEncoder().encode("explicit read-only pin fixture"),
      intent = await preparePin(bytes, "application/json");
    let sends = 0;
    const result = await fundedPin(
      f.db,
      id,
      grant,
      intent,
      bytes,
      "fixture-token",
      async () => {
        sends++;
        throw new Error("unexpected status send");
      },
      "reconcile",
    );
    assert.deepEqual(result, { state: "absent" });
    assert.equal(sends, 0);
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM spending_budgets")
        .first())!.n,
      0,
    );
    assert.equal(
      (await f.db.prepare("SELECT COUNT(*) AS n FROM funded_pins").first())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});
