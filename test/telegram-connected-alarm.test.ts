import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

// Queued for the coordinator's serialized Worker gate. This file has not been run.
test(
  "native DO alarm transactions preserve the earliest wake across concurrency and runtime restart",
  { timeout: 30000 },
  async () => {
    const compiled = await build({
      stdin: {
        resolveDir: process.cwd(),
        sourcefile: "telegram-alarm-fixture.ts",
        contents: `
      import {DurableObject} from 'cloudflare:workers';
      import {telegramAlarmScheduler} from './services/telegram-alarm.ts';
      export class State extends DurableObject {
        async alarm() {
          const fired = await this.ctx.storage.get('fired') ?? 0;
          await this.ctx.storage.put('fired', fired + 1);
        }
        async fetch(request) {
          if(request.method==='POST') {
            const deadlines=await request.json();
            const schedule=telegramAlarmScheduler(this.ctx.storage);
            await Promise.all(deadlines.map(at=>schedule(at)));
            this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS wake_receipt(id INTEGER PRIMARY KEY,value TEXT)');
            this.ctx.storage.sql.exec("INSERT OR REPLACE INTO wake_receipt VALUES(1,'armed')");
          }
          return Response.json({alarm:await this.ctx.storage.getAlarm(),fired:await this.ctx.storage.get('fired') ?? 0,
            receipt:this.ctx.storage.sql.exec('SELECT value FROM wake_receipt WHERE id=1').toArray()[0]?.value});
        }
      }
      export default {fetch(request,env){return env.STATE.getByName('fixture').fetch(request)}};
    `,
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2024",
      external: ["cloudflare:workers"],
      logLevel: "silent",
    });
    const directory = await mkdtemp(
      join(process.cwd(), ".local/telegram-alarm-"),
    );
    const make = () =>
      new Miniflare({
        modules: true,
        script: compiled.outputFiles[0].text,
        compatibilityDate: "2026-08-06",
        durableObjects: { STATE: { className: "State", useSQLite: true } },
        durableObjectsPersist: directory,
      });
    let runtime = make();
    const call = async (deadlines?: number[]) => {
      const response = await runtime.dispatchFetch(
        "https://fixture.example/alarm",
        deadlines ? { method: "POST", body: JSON.stringify(deadlines) } : {},
      );
      const body = await response.text();
      assert.equal(response.status, 200, body);
      return JSON.parse(body) as {
        alarm: number | null;
        receipt: string;
        fired: number;
      };
    };
    try {
      const earliest = Date.now() + 300000;
      const initial = await call([
        earliest + 60000,
        earliest,
        earliest + 120000,
      ]);
      assert.equal(initial.alarm, earliest);
      assert.equal((await call([earliest + 180000])).alarm, earliest);
      await runtime.dispose();
      runtime = make();
      assert.deepEqual(await call(), initial);
      assert.equal((await call([earliest - 60000])).alarm, earliest - 60000);
      await call([Date.now() + 50]);
      const deadline = Date.now() + 5000;
      let delivered = await call();
      while (delivered.fired === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        delivered = await call();
      }
      assert.ok(delivered.fired > 0, "native alarm event was not delivered");
      assert.equal(delivered.alarm, null);
    } finally {
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
