import test from "node:test";
import assert from "node:assert/strict";
import { CID } from "multiformats/cid";
import { canonical } from "../packages/community/common.ts";
import {
  addPin,
  fetchPublicIpfs,
  preparePin,
  reconcilePin,
} from "../packages/community/ipfs.ts";

test("fixed UnixFS roots bind a raw single chunk and a multi-block file independently of JSON property order", async () => {
  const bytes = new TextEncoder().encode("hello world\n"),
    intent = await preparePin(bytes, "application/json");
  assert.equal(
    intent.uri,
    "ipfs://bafkreifjjcie6lypi6ny7amxnfftagclbuxndqonfipmb64f2km2devei4",
  );
  const large = new Uint8Array(262145).map((_, index) => index % 251),
    multi = await preparePin(large, "audio/mpeg");
  assert.equal(CID.parse(multi.uri.slice(7)).code, 0x70);
  assert.equal(CID.parse(intent.uri.slice(7)).code, 0x55);
  assert.notEqual(
    multi.uri,
    (await preparePin(large.slice(0, 262144), "audio/mpeg")).uri,
  );
  const requests: Request[] = [];
  let receipts = 0;
  const result = await addPin(
    JSON.parse(canonical(intent)),
    bytes,
    "fixture-token",
    async (receipt) => {
      receipts++;
      assert.equal(JSON.parse(receipt.body).Hash, intent.uri.slice(7));
    },
    async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/add")) assert.equal(receipts, 1);
      if (url.host === "rpc.filebase.io") {
        assert.equal(
          request.headers.get("authorization"),
          "Bearer fixture-token",
        );
        if (url.pathname.endsWith("/add")) {
          assert.equal(url.searchParams.get("cid-version"), "1");
          assert.equal(url.searchParams.get("wrap-with-directory"), "false");
          return Response.json({ Hash: intent.uri.slice(7) });
        }
        return Response.json({
          Keys: { [intent.uri.slice(7)]: { Type: "recursive" } },
        });
      }
      assert.equal(request.headers.has("authorization"), false);
      return new Response(new Uint8Array(bytes));
    },
  );
  assert.equal(result.retained, true);
  assert.equal(
    requests.filter((r) => new URL(r.url).pathname.endsWith("/add")).length,
    1,
  );
});

test("pin reconciliation uses only reads and needs both recursive retention and independently retrieved matching bytes", async () => {
  const bytes = new Uint8Array(300000).fill(27),
    intent = await preparePin(bytes, "audio/mpeg");
  let adds = 0,
    gateways = 0;
  const send = async (request: Request) => {
    const url = new URL(request.url);
    if (url.host === "rpc.filebase.io") {
      if (url.pathname.endsWith("/add")) adds++;
      return Response.json({
        Keys: { [intent.uri.slice(7)]: { Type: "recursive" } },
      });
    }
    gateways++;
    return new Response(new Uint8Array(bytes));
  };
  assert.equal(
    (await reconcilePin(intent, "fixture-token", send)).gateway,
    "https://gateway.pinata.cloud",
  );
  assert.equal(adds, 0);
  assert.equal(gateways, 1);
  await assert.rejects(
    fetchPublicIpfs(
      intent.uri,
      intent.sha256,
      bytes.length,
      async () => new Response(new Uint8Array([1])),
    ),
    /public_ipfs_unavailable/,
  );
  await assert.rejects(
    reconcilePin(intent, "fixture-token", async () =>
      Response.json({ Keys: {} }),
    ),
  );
  await assert.rejects(
    fetchPublicIpfs(
      intent.uri,
      intent.sha256,
      bytes.length,
      async () => new Response(new Uint8Array(bytes.length + 1)),
    ),
    /public_ipfs_unavailable/,
  );
  await assert.rejects(
    addPin(
      intent,
      bytes,
      "fixture-token",
      async (receipt) => {
        assert.equal(JSON.parse(receipt.body).Hash, "unexpected");
      },
      async () => Response.json({ Hash: "unexpected" }),
    ),
    /pin_root_mismatch/,
  );
});

test("a pin response must be retained before interpretation or follow-up and failure never sends again implicitly", async () => {
  const bytes = new TextEncoder().encode("fixture"),
    intent = await preparePin(bytes, "application/json");
  let sends = 0;
  await assert.rejects(
    addPin(
      intent,
      bytes,
      "fixture-token",
      async () => {
        throw new Error("fixture persistence interruption");
      },
      async () => {
        sends++;
        return Response.json({ Hash: intent.uri.slice(7) });
      },
    ),
    /fixture persistence interruption/,
  );
  assert.equal(sends, 1);
  let retainedStatus = 0;
  await assert.rejects(
    addPin(
      intent,
      bytes,
      "fixture-token",
      async (receipt) => {
        retainedStatus = receipt.status;
      },
      async () => new Response("provider refused", { status: 401 }),
    ),
    /pin_provider_unavailable/,
  );
  assert.equal(retainedStatus, 401);
});
