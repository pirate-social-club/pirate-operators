// Focused actual SQLite journal regression. esbuild compiles only the local
// Worker test fixture; this is not a product build or a public provider call.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test(
  "SQLite retirement atomically frees unsent capacity and persists a replay fence across restart",
  { timeout: 60000 },
  async () => {
    const built = await build({
      stdin: {
        loader: "ts",
        resolveDir: process.cwd(),
        contents: `
    import { DurableObject } from 'cloudflare:workers';
    import { Store } from './services/runtime.ts';
    import { reserveActivationSponsorship, retireUnallocatedAuthorization } from './services/sponsor-budget.ts';
    export class Budget extends DurableObject {
      constructor(ctx, env) { super(ctx, env); this.store = new Store(ctx.storage); }
      async fetch(request) {
        if(request.method==='GET') return Response.json(this.store.entries(''));
        const {action,wallet,id,fail}=await request.json();
        const gas={cap:200n,gas:9n,gasPrice:10n,dataFee:10n};
        try {
          this.store.transaction(()=>{
            if(action==='reserve') {
              reserveActivationSponsorship(this.store,gas,{total:200n,perAccount:200n,accounts:1},wallet,id);
              this.store.set('pendingAuthorization:'+id,{wallet,id});
            } else {
              retireUnallocatedAuthorization(this.store,gas,wallet,id);
              this.store.delete('pendingAuthorization:'+id);
              if(fail) throw Error('fixture retirement interruption');
            }
          });
          return Response.json({ok:true});
        } catch(e) {return Response.json({error:e.message},{status:409});}
      }
    }
    export default {fetch(req,env){return env.BUDGET.get(env.BUDGET.idFromName('community')).fetch(req)}};
  `,
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      external: ["cloudflare:workers", "node:*"],
    });
    const directory = await mkdtemp(join(tmpdir(), "retirement-durable-"));
    const open = () =>
      new Miniflare({
        modules: true,
        script: built.outputFiles[0].text,
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { BUDGET: { className: "Budget", useSQLite: true } },
        durableObjectsPersist: directory,
      });
    let mf = open();
    const wallet = `0x${"12".repeat(20)}`,
      old = `0x${"ab".repeat(32)}`,
      fresh = `0x${"cd".repeat(32)}`;
    const send = (action: string, id = old, fail = false) =>
      mf.dispatchFetch("http://fixture", {
        method: "POST",
        body: JSON.stringify({ action, wallet, id, fail }),
      });
    const state = async () =>
      (await (await mf.dispatchFetch("http://fixture")).json()) as {
        key: string;
        value: unknown;
      }[];
    try {
      assert.equal((await send("reserve")).status, 200);
      const before = await state();
      assert.equal((await send("retire", old, true)).status, 409);
      assert.deepEqual(await state(), before);
      assert.equal((await send("retire")).status, 200);
      const retired = await state();
      assert.equal(
        retired.some((r) => r.key.startsWith("pendingAuthorization:")),
        false,
      );
      assert.equal(
        retired.some((r) => r.key.startsWith("sponsor:activation:account:")),
        false,
      );
      await mf.dispose();
      mf = open();
      assert.deepEqual(await state(), retired);
      assert.equal((await send("reserve", old)).status, 409);
      assert.equal((await send("reserve", fresh)).status, 200);
      const ledger = (await state()).find(
        (r) => r.key === "sponsor:activation:ledger",
      )!.value;
      assert.deepEqual(ledger, {
        total: "200",
        perAccount: "200",
        accounts: 1,
        usedAccounts: 1,
        committed: "200",
      });
    } finally {
      await mf.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
