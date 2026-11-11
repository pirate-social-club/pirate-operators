import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test(
  "actual SQLite Durable Object atomically retains a linked write and wake across restart",
  { timeout: 30000 },
  async () => {
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        sourcefile: "binding-wake-fixture.ts",
        contents: `import {DurableObject} from 'cloudflare:workers';
      import {Store} from './services/operator-store.ts';
      export class State extends DurableObject {
        constructor(ctx,env){super(ctx,env);this.store=new Store(ctx.storage);}
        async fetch(request){
          const path=new URL(request.url).pathname;
          if(path==='/write')
            await this.store.durableStudyWrite(()=>this.store.transaction(()=>{
              this.store.set('studyBinding:fixture',{offer:{speechChannel:'telegram-linked'}});
            }));
          if(path==='/reject') {
            try {await this.store.durableStudyWrite(()=>{
              this.store.set('rejected',true);throw Error('fixture rollback');
            });} catch {}
          }
          return Response.json({
            binding:this.store.get('studyBinding:fixture')??null,
            rejected:this.store.get('rejected')??null,
            alarm:await this.ctx.storage.getAlarm(),
            woke:this.store.get('woke')??false,
          });
        }
        async alarm(){this.store.set('woke',true);}
      }
      export default {fetch(request,env){return env.STATE.getByName('fixture').fetch(request);}};`,
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2024",
      external: ["cloudflare:workers"],
      logLevel: "silent",
    });
    const dir = await mkdtemp(join(tmpdir(), "study-binding-wake-"));
    const make = () =>
      new Miniflare({
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-08-06",
        durableObjects: { STATE: { className: "State", useSQLite: true } },
        durableObjectsPersist: dir,
      });
    let runtime = make();
    const call = async (path: string) =>
      (await (
        await runtime.dispatchFetch("https://fixture.example" + path)
      ).json()) as {
        binding: unknown;
        rejected: boolean | null;
        alarm: number | null;
        woke: boolean;
      };
    try {
      const initial = await call("/write");
      assert.ok(initial.binding);
      assert.ok(initial.alarm && initial.alarm > Date.now());
      assert.equal((await call("/reject")).rejected, null);
      await runtime.dispose();
      runtime = make();
      const restored = await call("/read");
      assert.deepEqual(restored.binding, initial.binding);
      assert.equal(restored.rejected, null);
      assert.ok(
        restored.alarm !== null || restored.woke,
        "a committed write cannot lose both its alarm and the alarm outcome",
      );
    } finally {
      await runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
