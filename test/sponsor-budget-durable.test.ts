// Actual Store and sponsor functions in workerd/SQLite. No provider or chain.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(
  "real SQLite reservations roll back atomically and survive runtime restart",
  { timeout: 90000 },
  async () => {
    const compiled = await build({
      stdin: {
        contents: `
      import { DurableObject } from 'cloudflare:workers';
      import { Store } from './services/runtime.ts';
      import { reserveActivationSponsorship } from './services/sponsor-budget.ts';
      export class Budget extends DurableObject {
        constructor(ctx, env) { super(ctx, env); this.journal = new Store(ctx.storage); }
        async fetch(request) {
          if (request.method === 'GET') return Response.json(this.journal.entries('sponsor:'));
          const { wallet, id, small } = await request.json();
          try {
            const reservation = reserveActivationSponsorship(this.journal,
              { cap: small ? 100n : 600n, gas: 9n, gasPrice: 10n, dataFee: 10n },
              { total: 400n, perAccount: 200n, accounts: 2 }, wallet, id);
            return Response.json(reservation);
          } catch(error) { return Response.json({ error: error.message }, { status: 409 }); }
        }
      }
      export default { fetch(request, env) {
        return env.BUDGET.get(env.BUDGET.idFromName(new URL(request.url).pathname)).fetch(request);
      }};
    `,
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      external: ["cloudflare:workers", "node:*"],
    });
    const directory = await mkdtemp(join(tmpdir(), "sponsor-durable-"));
    const open = () =>
      new Miniflare({
        modules: true,
        script: compiled.outputFiles[0].text,
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { BUDGET: { className: "Budget", useSQLite: true } },
        durableObjectsPersist: directory,
      });
    let mf = open();
    const payload = (n: number, small = false) => ({
      wallet: `0x${n.toString(16).padStart(40, "0")}`,
      id: `0x${n.toString(16).padStart(64, "0")}`,
      small,
    });
    const send = (n: number, path = "/cohort", small = false) =>
      mf.dispatchFetch("http://fixture" + path, {
        method: "POST",
        body: JSON.stringify(payload(n, small)),
      });
    const rows = async (path = "/cohort") =>
      (await (await mf.dispatchFetch("http://fixture" + path)).json()) as {
        key: string;
        value: unknown;
      }[];
    try {
      assert.equal((await send(1, "/rollback", true)).status, 409);
      assert.deepEqual(await rows("/rollback"), []);
      const attempts = await Promise.all([send(1), send(2), send(3)]);
      assert.equal(attempts.filter((r) => r.status === 200).length, 2);
      const before = await rows();
      assert.equal(
        before.filter((r) => r.key.startsWith("sponsor:reservation:")).length,
        4,
      );
      const admitted = before.find((r) =>
        r.key.startsWith("sponsor:activation:account:"),
      )!;
      const account = Number.parseInt(
        admitted.key.split(":").at(-1)!.slice(2),
        16,
      );
      await mf.dispose();
      mf = open();
      assert.deepEqual(await rows(), before);
      assert.equal((await send(account)).status, 200);
      assert.deepEqual(await rows(), before);
      assert.equal((await send(4)).status, 409);
    } finally {
      await mf.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
