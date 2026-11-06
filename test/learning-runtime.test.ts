import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accounts, keys } from "../harness/runtime.ts";

const source = `
import runtime, { ServiceState } from './services/runtime.ts';
export { SpeechBudget } from './services/speech-budget.ts';
export class TestState extends ServiceState {
  async fetch(request) {
    const path = new URL(request.url).pathname;
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
      try { return Response.json(await env.SPEECH_BUDGET.getByName('shared-provider').claim()); }
      catch { return new Response('limit', { status: 429 }); }
    }
    return runtime.fetch(request, env);
  }
};`;
async function worker(persist: string, speechLimit = "2") {
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
      OPERATOR_PROFILE: "pirate-karaoke-testnet-v2",
      ROLE: "operator",
      COMMUNITY_ID: "runtime-test",
      PAYMENT_CHAIN_ID: "6343",
      SERVICE_MODE: "internal",
      RESULTS_V2_CONTRACT: accounts[0].address,
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
test("deployed profile hides fixture controls, schedules work and removes expired private evidence", async () => {
  const mf = await worker(
    mkdtempSync(join(tmpdir(), "pirate-learning-alarm-")),
  );
  try {
    assert.equal((await mf.dispatchFetch("http://worker/__state")).status, 404);
    assert.equal((await mf.dispatchFetch("http://worker/__clock")).status, 404);
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
