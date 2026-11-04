import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { readFile } from "node:fs/promises";
import { configureBudget } from "../packages/community/budgets.ts";
import { hashText } from "../packages/community/common.ts";
import {
  journaledProviderCall,
  type ProviderCall,
} from "../packages/moderation/provider-journal.ts";
import { providerJson } from "../packages/moderation/provider-http.ts";

async function fixture() {
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await mf.getD1Database("DB");
    const sql = await readFile(
      new URL(
        "../apps/managed-moderation/migrations/0001_managed.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.batch(
      sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
    await db
      .prepare(
        `INSERT INTO managed_admissions(admission_id,community_id,submission_id,job_id,request_hash,request_json,authority_json,budget_period,state,lease_token,lease_until,created_at,updated_at)
      VALUES('admission','community','submission','job','hash','{}','{}','run','running','lease-one',181000,0,0)`,
      )
      .run();
    const budgets = [
      { scope: "service", period: "run", asset: "requests" },
      { scope: "community:one", period: "run", asset: "requests" },
    ];
    for (const key of budgets) await configureBudget(db, key, "3");
    let sends = 0,
      time = 1000;
    const call: ProviderCall = {
      async authorize() {}, // Explicit simulated current-authority fixture.
      kind: "acr_primary",
      request: { audioHash: hashText("fixture-source") },
      budgets,
      async send(received) {
        sends++;
        const body = JSON.stringify({
          providerReceipt: "fixture-receipt",
          outcome: "no_match",
        });
        await received({
          status: 200,
          contentType: "application/json",
          requestId: "fixture-id",
          body,
          bodySha256: hashText(body),
        });
      },
      interpret: providerJson,
    };
    return {
      db,
      call,
      sends: () => sends,
      now: () => time,
      tick: () => {
        time += 180001;
      },
      dispose: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
const lease = { admissionId: "admission", token: "lease-one" };

test("concurrent moderation deliveries send once and settle both request quotas once", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        journaledProviderCall(f.db, lease, f.call, f.now),
      ),
    );
    assert.ok(results.some((result) => result.status === "fulfilled"));
    assert.equal(f.sends(), 1);
    assert.equal(
      (await journaledProviderCall(f.db, lease, f.call, f.now)).providerReceipt,
      "fixture-receipt",
    );
    assert.equal(f.sends(), 1);
    const rows = await f.db
      .prepare("SELECT reserved,spent FROM spending_budgets")
      .all<{ reserved: string; spent: string }>();
    assert.ok(
      rows.results.every((row) => row.reserved === "0" && row.spent === "1"),
    );
    await assert.rejects(
      journaledProviderCall(
        f.db,
        lease,
        {
          ...f.call,
          budgets: f.call.budgets.map((key) => ({
            ...key,
            period: "another-run",
          })),
        },
        f.now,
      ),
      /provider_call_intent_changed/,
    );
  } finally {
    await f.dispose();
  }
});

test("an unknown non-idempotent moderation send retains its quota and cannot be bought again", async () => {
  const f = await fixture();
  let sends = 0;
  try {
    const call = {
      ...f.call,
      async send() {
        sends++;
        throw new Error("fixture response lost after upstream charged");
      },
    };
    for (let i = 0; i < 3; i++)
      await assert.rejects(
        journaledProviderCall(f.db, lease, call, f.now),
        /provider_result_uncertain/,
      );
    assert.equal(sends, 1);
    const rows = await f.db
      .prepare("SELECT reserved,spent FROM spending_budgets")
      .all<{ reserved: string; spent: string }>();
    assert.ok(
      rows.results.every((row) => row.reserved === "1" && row.spent === "0"),
    );
  } finally {
    await f.dispose();
  }
});

test("a retained response survives interruption before interpretation without another provider call", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      journaledProviderCall(
        f.db,
        lease,
        {
          ...f.call,
          interpret() {
            throw new Error("fixture termination before parsing");
          },
        },
        f.now,
      ),
      /fixture termination before parsing/,
    );
    assert.equal(
      (await journaledProviderCall(f.db, lease, f.call, f.now)).outcome,
      "no_match",
    );
    assert.equal(f.sends(), 1);
    assert.equal(
      (await f.db
        .prepare("SELECT state FROM moderation_provider_calls")
        .first<{ state: string }>())!.state,
      "validated",
    );
  } finally {
    await f.dispose();
  }
});

test("a still-live delayed moderation request keeps its single send across a new worker lease", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  try {
    const send = f.call.send;
    const delayed = {
      ...f.call,
      async send(received: Parameters<typeof send>[0]) {
        entered();
        await waiting;
        return send(received);
      },
    };
    const first = journaledProviderCall(f.db, lease, delayed, f.now);
    await started;
    f.tick();
    await f.db
      .prepare(
        "UPDATE managed_admissions SET lease_token='lease-two',lease_until=?",
      )
      .bind(f.now() + 180000)
      .run();
    await assert.rejects(
      journaledProviderCall(
        f.db,
        { ...lease, token: "lease-two" },
        f.call,
        f.now,
      ),
      /provider_result_uncertain/,
    );
    release();
    await first;
    assert.equal(
      (
        await journaledProviderCall(
          f.db,
          { ...lease, token: "lease-two" },
          f.call,
          f.now,
        )
      ).outcome,
      "no_match",
    );
    assert.equal(f.sends(), 1);
  } finally {
    release();
    await f.dispose();
  }
});
