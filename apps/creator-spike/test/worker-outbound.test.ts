import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { signCreatorRequest } from "../../../packages/community/creator-service.ts";
import { creatorPublisherFixture } from "../../../test/creator-connection-keys.ts";
import { walletOrigin } from "../src/shared.ts";

test("actual native Worker reaches its curated RPC in workerd and never follows a redirect", async () => {
  let redirected = false,
    calls = 0;
  const mf = new Miniflare({
    modules: [
      {
        type: "ESModule",
        path: resolve("dist/worker/index.js"),
        contents: await readFile("dist/worker/index.js", "utf8"),
      },
      {
        type: "CompiledWasm",
        path: resolve("dist/worker/ika.wasm"),
        contents: await readFile("dist/worker/ika.wasm"),
      },
    ],
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: async (request: {
      url: string;
      json(): Promise<{ id: number; method: string }>;
    }) => {
      assert.equal(request.url, "https://carrot.megaeth.com/rpc");
      calls++;
      if (redirected)
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/" },
        });
      const body = await request.json();
      assert.equal(body.method, "eth_chainId");
      return Response.json({ jsonrpc: "2.0", id: body.id, result: "0x7a69" });
    },
  });
  try {
    const now = Math.floor(Date.now() / 1000),
      body = {
        connectionId: crypto.randomUUID(),
        accountRef: `0x${"a".repeat(64)}`,
        state: "s".repeat(43),
        verifierHash: "v".repeat(43),
      },
      wire = await signCreatorRequest(
        creatorPublisherFixture,
        {
          action: "creator_launch",
          communityId:
            "0xd3f69af98a60cbebb54e77b4306115cfcd8f33d122da9d02e782972a6debea0f",
          communityOrigin:
            "https://pirate-first-song-20261105.piratesocialclub.workers.dev",
          serviceOrigin: walletOrigin,
          configurationRevision: 1,
          nonce: `0x${"c".repeat(64)}`,
          issuedAt: now,
          expiresAt: now + 300,
        },
        body,
      ),
      send = () =>
        mf.dispatchFetch(walletOrigin + "/api/communities/launch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(wire),
        });
    const wrongChain = await send();
    assert.deepEqual(await wrongChain.json(), {
      error: "wrong_application_chain",
    });
    assert.equal(calls, 1);
    redirected = true;
    const denied = await send();
    assert.equal(denied.status, 503);
    assert.equal(calls, 2); // Neither credentials nor signed input reach another origin.
  } finally {
    await mf.dispose();
  }
});
