import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accounts, keys } from "../harness/runtime.ts";
import { learningBindingFixture } from "./learning-binding-fixture.ts";
import { acceptEnrollment } from "../services/learning-enrollment.ts";
import { admittedLearningProfile } from "../services/learning-profile.ts";
import type { Env } from "../services/runtime.ts";

const source = `
import runtime, { ServiceState } from './services/runtime.ts';
export { SpeechBudget } from './services/speech-budget.ts';
export class TestState extends ServiceState {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/test/journal') {
      if (request.method === 'POST') {
        const rows = await request.json();
        this.store.transaction(() => { for (const { key, value } of rows) this.store.set(key, value); });
      }
      return Response.json(this.store.entries(''));
    }
    if (path === '/test/retention') {
      this.store.set('history:expired', { expiresAt: this.store.now() - 1 });
      this.store.set('words:expired', ['private transcript']);
      this.store.set('audioRelay:expired', { words: ['private transcript'] });
      this.store.set('result:expired', { publicOutcome: true });
      await this.ctx.storage.deleteAlarm(); await this.alarm();
      return Response.json({ history: this.store.get('history:expired') ?? null,
        words: this.store.get('words:expired') ?? null, relay: this.store.get('audioRelay:expired') ?? null,
        result: this.store.get('result:expired') });
    }
    if (path === '/test/alarm') return Response.json({ alarm: await this.ctx.storage.getAlarm(), now: this.store.now() });
    if (path === '/test/later-alarm') {
      await this.ctx.storage.setAlarm(Date.now() + 3600000);
      return Response.json({ scheduled: true });
    }
    return super.fetch(request);
  }
}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/test/speech') {
      try { return Response.json(await env.SPEECH_BUDGET.getByName('elevenlabs-service').claim()); }
      catch { return new Response('limit', { status: 429 }); }
    }
    return runtime.fetch(request, env);
  }
};`;
async function worker(
  persist: string,
  speechLimit = "2",
  version: 2 | 3 | 4 = 2,
) {
  const bundle = await build({
    stdin: { contents: source, resolveDir: process.cwd() },
    write: false,
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
  });
  return new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjectsPersist: persist,
    durableObjects: {
      STATE: { className: "TestState", useSQLite: true },
      SPEECH_BUDGET: { className: "SpeechBudget", useSQLite: true },
    },
    bindings: {
      OPERATOR_PROFILE:
        version === 2
          ? "pirate-karaoke-testnet-v2"
          : version === 3
            ? "pirate-learning-testnet-v3"
            : "pirate-community-learning-v4",
      ...(version === 3 ? { RESULTS_V3_CONTRACT: accounts[1].address } : {}),
      ...(version === 4
        ? {
            RESULTS_V4_CONTRACT: accounts[1].address,
            ACTIVATION_TOTAL_CAP_WEI: "700",
            ACTIVATION_ACCOUNT_CAP_WEI: "202",
            ACTIVATION_MAX_ACCOUNTS: "3",
          }
        : { RESULTS_V2_CONTRACT: accounts[0].address }),
      ROLE: "operator",
      COMMUNITY_ID: "runtime-test",
      PAYMENT_CHAIN_ID: "6343",
      SERVICE_MODE: "internal",
      PRIVATE_KEY: keys[2],
      OPERATOR_ADDRESS: accounts[2].address,
      SPONSOR_CAP_WEI: "1000",
      SPONSOR_GAS_PRICE_WEI: "1",
      SPONSOR_GAS_LIMIT: "100",
      SPONSOR_DATA_FEE_WEI: "1",
      SPEECH_DAILY_LIMIT: speechLimit,
      HISTORY_RETENTION_DAYS: "30",
    },
  });
}
test("shared speech admission is atomic and survives a runtime restart", async () => {
  const persist = mkdtempSync(join(tmpdir(), "pirate-learning-budget-"));
  let mf = await worker(persist);
  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        mf.dispatchFetch("http://worker/test/speech"),
      ),
    );
    assert.equal(responses.filter((x) => x.status === 200).length, 2);
    assert.equal(responses.filter((x) => x.status === 429).length, 3);
    await mf.dispose();
    mf = await worker(persist);
    assert.equal(
      (await mf.dispatchFetch("http://worker/test/speech")).status,
      429,
    );
  } finally {
    await mf.dispose();
  }
});
for (const version of [2, 3] as const)
  test(`deployed V${version} profile hides fixture controls, schedules work and removes expired private evidence`, async () => {
    const mf = await worker(
      mkdtempSync(join(tmpdir(), "pirate-learning-alarm-")),
      "2",
      version,
    );
    try {
      assert.equal(
        (await mf.dispatchFetch("http://worker/__state")).status,
        404,
      );
      assert.equal(
        (await mf.dispatchFetch("http://worker/__clock")).status,
        404,
      );
      assert.equal((await mf.dispatchFetch("http://worker/quote")).status, 200);
      const timing = (await (
        await mf.dispatchFetch("http://worker/test/alarm")
      ).json()) as { now: number; alarm: number };
      assert.ok(Math.abs(timing.now - Math.floor(Date.now() / 1000)) < 2);
      assert.ok(timing.alarm > Date.now());
      await mf.dispatchFetch("http://worker/test/later-alarm");
      await mf.dispatchFetch("http://worker/quote");
      const rescheduled = (await (
        await mf.dispatchFetch("http://worker/test/alarm")
      ).json()) as { alarm: number };
      assert.ok(
        rescheduled.alarm <= Date.now() + 5000,
        "new work must preempt the previous publication's hourly audit",
      );
      const expired = await (
        await mf.dispatchFetch("http://worker/test/retention")
      ).json();
      assert.deepEqual(expired, {
        history: null,
        words: null,
        relay: null,
        result: { publicOutcome: true },
      });
    } finally {
      await mf.dispose();
    }
  });

test("disabling the owner-operated pilot quota retains the shared usage counter", async () => {
  const persist = mkdtempSync(join(tmpdir(), "pirate-speech-observation-"));
  let mf = await worker(persist);
  try {
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await mf.dispatchFetch("http://worker/test/speech")).status,
        200,
      );
    assert.equal(
      (await mf.dispatchFetch("http://worker/test/speech")).status,
      429,
    );
    await mf.dispose();
    mf = await worker(persist, "0");
    const third = (await (
      await mf.dispatchFetch("http://worker/test/speech")
    ).json()) as { used: number; limit: number };
    assert.deepEqual(
      { used: third.used, limit: third.limit },
      { used: 3, limit: 0 },
    );
    const fourth = (await (
      await mf.dispatchFetch("http://worker/test/speech")
    ).json()) as { used: number };
    assert.equal(fourth.used, 4);
  } finally {
    await mf.dispose();
  }
});

test(
  "V3 runtime restart keeps the V2 signed journal, spending reservations and shared speech usage",
  { timeout: 60000 },
  async () => {
    const f = await learningBindingFixture(19849);
    let mf: Miniflare | undefined;
    try {
      const enrollment = await f.enrollment(2);
      f.store.set("fault:crash-before-broadcast", true);
      await assert.rejects(
        acceptEnrollment(f.env, f.store, enrollment.e, enrollment.signature),
        /simulated_crash/,
      );
      const journal = f.store.entries("");
      assert.ok(
        journal.some(
          ({ key, value }) =>
            key.startsWith("tx:") && (value as { raw?: string }).raw,
        ),
      );
      const persist = mkdtempSync(join(tmpdir(), "pirate-v3-runtime-upgrade-"));
      mf = await worker(persist, "0");
      const seed = await mf.dispatchFetch("http://worker/test/journal", {
        method: "POST",
        body: JSON.stringify(journal),
        headers: { "content-type": "application/json" },
      });
      assert.equal(seed.status, 200);
      const before = await seed.json();
      const first = (await (
        await mf.dispatchFetch("http://worker/test/speech")
      ).json()) as { used: number };
      assert.equal(first.used, 1);
      await mf.dispose();
      mf = await worker(persist, "0", 3);
      assert.deepEqual(
        await (await mf.dispatchFetch("http://worker/test/journal")).json(),
        before,
      );
      const next = (await (
        await mf.dispatchFetch("http://worker/test/speech")
      ).json()) as { used: number; limit: number };
      assert.equal(next.used, 2);
      assert.equal(next.limit, 0);
      const clock = (await (
        await mf.dispatchFetch("http://worker/test/alarm")
      ).json()) as { now: number };
      assert.ok(Math.abs(clock.now - Math.floor(Date.now() / 1000)) < 2);
      for (const path of ["/__state", "/__clock", "/__fault"])
        assert.equal(
          (await mf.dispatchFetch(`http://worker${path}`)).status,
          404,
        );
    } finally {
      await mf?.dispose();
      await f.stop();
    }
  },
);

test("V3 admission requires both distinct testnet destinations and cannot silently upgrade a V2 profile", () => {
  const env = {
    OPERATOR_PROFILE: "pirate-learning-testnet-v3",
    ROLE: "operator",
    PAYMENT_CHAIN_ID: "6343",
    SERVICE_MODE: "internal",
    RESULTS_V2_CONTRACT: accounts[0].address,
    RESULTS_V3_CONTRACT: accounts[1].address,
    SPEECH_BUDGET: {},
    SPONSOR_CAP_WEI: "1000",
    SPONSOR_GAS_PRICE_WEI: "1",
    SPONSOR_GAS_LIMIT: "100",
    SPONSOR_DATA_FEE_WEI: "1",
  } as Env;
  assert.equal(admittedLearningProfile(env), true);
  for (const change of [
    { RESULTS_V2_CONTRACT: undefined },
    { RESULTS_V3_CONTRACT: undefined },
    { RESULTS_V3_CONTRACT: env.RESULTS_V2_CONTRACT },
    { RESULTS_V3_CONTRACT: "0x" },
    { PAYMENT_CHAIN_ID: "4326" },
    { PAYMENT_CHAIN_ID: "1" },
    { OPERATOR_PROFILE: "pirate-karaoke-testnet-v2" },
    { SPEECH_BUDGET: undefined },
  ])
    assert.equal(admittedLearningProfile({ ...env, ...change }), false);
});

test("fresh V4-only Worker uses the live clock and protects its durable journal", async () => {
  const mf = await worker(
    mkdtempSync(join(tmpdir(), "pirate-learning-fresh-v4-")),
    "0",
    4,
  );
  try {
    const clock = (await (
      await mf.dispatchFetch("http://worker/test/alarm")
    ).json()) as { now: number };
    assert.ok(Math.abs(clock.now - Math.floor(Date.now() / 1000)) < 2);
    for (const path of ["/__state", "/__clock", "/__fault"])
      assert.equal(
        (await mf.dispatchFetch(`http://worker${path}`)).status,
        404,
      );
  } finally {
    await mf.dispose();
  }
});

test("fresh V4 admission requires explicit first-use caps and refuses historical targets", () => {
  const env = {
    OPERATOR_PROFILE: "pirate-community-learning-v4",
    ROLE: "operator",
    PAYMENT_CHAIN_ID: "6343",
    SERVICE_MODE: "internal",
    RESULTS_V4_CONTRACT: accounts[1].address,
    SPEECH_BUDGET: {},
    SPONSOR_CAP_WEI: "1000",
    SPONSOR_GAS_PRICE_WEI: "1",
    SPONSOR_GAS_LIMIT: "100",
    SPONSOR_DATA_FEE_WEI: "0",
    ACTIVATION_TOTAL_CAP_WEI: "700",
    ACTIVATION_ACCOUNT_CAP_WEI: "200",
    ACTIVATION_MAX_ACCOUNTS: "3",
  } as Env;
  assert.equal(admittedLearningProfile(env), true);
  for (const change of [
    { RECORDS_CONTRACT: accounts[0].address },
    { RECORDS_CONTRACT: "" },
    { RESULTS_V2_CONTRACT: accounts[0].address },
    { RESULTS_V3_CONTRACT: accounts[2].address },
    { RESULTS_V4_CONTRACT: undefined },
    { PAYMENT_CHAIN_ID: "4326" },
    { SPONSOR_DATA_FEE_WEI: undefined },
    { ACTIVATION_ACCOUNT_CAP_WEI: "199" },
    { ACTIVATION_TOTAL_CAP_WEI: "1001" },
    { ACTIVATION_MAX_ACCOUNTS: "0" },
  ])
    assert.equal(admittedLearningProfile({ ...env, ...change }), false);
});
