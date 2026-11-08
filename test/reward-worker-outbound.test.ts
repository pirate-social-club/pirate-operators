import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// The deployed application runs these reward transports inside workerd, which
// rejects redirect "error" before any request leaves. Each transport must reach
// its fixed endpoint in the actual runtime and refuse, never follow, a redirect.
const entry = `
import { rewardChain } from "./packages/rewards/chain.ts";
import { hostedProvider } from "./packages/rewards/very-transport.ts";
import { megapotPurchase } from "./packages/rewards/megapot.ts";
const profile = ${JSON.stringify({ rpcUrl: "https://carrot.megaeth.com/rpc" })};
const run = {
  chain: () => rewardChain().confirmedPosition(profile),
  very: () => hostedProvider().verify({ fixture: true }),
  megapot: () => megapotPurchase({ purchaseHash: "0x" + "1".repeat(64) }, profile),
};
export default {
  async fetch(request) {
    try {
      return Response.json({ ok: await run[new URL(request.url).pathname.slice(1)]() ?? null });
    } catch (error) {
      return Response.json({ error: String(error?.code ?? error?.message ?? error) });
    }
  },
};`;

test("reward chain, Very and Megapot transports reach their fixed endpoints in workerd and never follow a redirect", async () => {
  const bundle = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2024",
    external: ["node:*"],
    logLevel: "silent",
  });
  let redirect = false;
  const calls: string[] = [];
  const runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    outboundService: async (request: {
      url: string;
      text(): Promise<string>;
    }) => {
      calls.push(request.url);
      assert.notEqual(new URL(request.url).hostname, "attacker.invalid");
      if (redirect)
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/" },
        });
      if (request.url === "https://verify.very.org/api/v1/verify")
        return Response.json({ status: "valid" });
      const body = JSON.parse(await request.text()) as {
        id: number;
        method: string;
      };
      assert.equal(body.method, "eth_chainId");
      // A reachable endpoint on the wrong chain proves the request was sent.
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x1" });
    },
  });
  const call = async (name: string) =>
    (await (
      await runtime.dispatchFetch("https://rewards.example/" + name)
    ).json()) as { ok?: unknown; error?: string };
  try {
    assert.deepEqual(await call("chain"), { error: "wrong_reward_chain" });
    assert.deepEqual(await call("very"), { ok: null });
    assert.deepEqual(await call("megapot"), { error: "wrong_megapot_chain" });
    assert.deepEqual(calls, [
      "https://carrot.megaeth.com/rpc",
      "https://verify.very.org/api/v1/verify",
      "https://sepolia.base.org/",
    ]);
    redirect = true;
    for (const name of ["chain", "very", "megapot"]) {
      const refused = await call(name);
      assert.equal(refused.ok, undefined, name);
      assert.ok(refused.error, name);
      assert.doesNotMatch(refused.error!, /redirect value|wrong_/, name);
    }
    // One request each and no follow to the redirect destination.
    assert.equal(calls.length, 6);
  } finally {
    await runtime.dispose();
  }
});
