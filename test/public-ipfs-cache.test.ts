import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { preparePin } from "../packages/community/ipfs.ts";

const bytes = Uint8Array.from({ length: 262145 }, (_, i) => i % 251);
const intent = await preparePin(bytes, "audio/mpeg");
const key = `public-ipfs/v1/${intent.uri.slice(7)}/${intent.sha256}`;
const compiled = await build({
  stdin: {
    contents: `import {fetchPublicIpfs} from './packages/community/ipfs.ts';
      import {publicIpfsCache} from './services/public-ipfs-cache.ts';
      const intent=${JSON.stringify(intent)};
      export default {async fetch(request,env){
        const q=new URL(request.url).searchParams, base=publicIpfsCache(env.MEDIA);
        const cache=q.get('mode')==='uncached'?undefined:{
          read:q.get('mode')==='read-failure'?async()=>{throw Error('R2 unavailable')}:base.read,
          write:q.get('mode')==='write-failure'?async()=>{throw Error('R2 unavailable')}:base.write
        };
        try {const value=await fetchPublicIpfs(q.get('uri')??intent.uri,q.get('digest')??intent.sha256,
          Number(q.get('maximum')??intent.byteLength),undefined,cache);
          return Response.json({gateway:value.gateway,size:value.bytes.length});
        } catch(error){return Response.json({code:error.code},{status:503})}
      }};`,
    resolveDir: process.cwd(),
    sourcefile: "public-ipfs-cache-runtime-fixture.ts",
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2024",
  external: ["node:*"],
  logLevel: "silent",
});
async function fixture() {
  let requests = 0,
    available = true;
  const mf = new Miniflare({
    modules: true,
    script: compiled.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    r2Buckets: ["MEDIA"],
    outboundService: async () => {
      requests++;
      return available
        ? new Response(bytes)
        : new Response("offline", { status: 503 });
    },
  });
  return {
    mf,
    bucket: await mf.getR2Bucket("MEDIA"),
    requests: () => requests,
    available: (value: boolean) => {
      available = value;
    },
    read: (query = "") =>
      mf.dispatchFetch("https://cache-fixture.example/?" + query),
  };
}

test("real R2 cached public bytes survive gateway outage; eviction and smaller limits fail closed", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.read()).status, 200);
    assert.equal(f.requests(), 1);
    const stored = await f.bucket.get(key);
    assert.equal(stored?.size, bytes.length);
    assert.deepEqual(new Uint8Array(await stored!.arrayBuffer()), bytes);
    f.available(false);
    const warm = await f.read();
    assert.equal(warm.status, 200);
    assert.deepEqual(await warm.json(), {
      gateway: "r2:verified-public-content",
      size: bytes.length,
    });
    assert.equal(f.requests(), 1);
    assert.equal((await f.read("maximum=" + (bytes.length - 1))).status, 503);
    assert.equal(f.requests(), 3);
    await f.bucket.delete(key);
    assert.equal((await f.read()).status, 503);
    assert.equal(f.requests(), 5);
    f.available(true);
    assert.equal((await f.read()).status, 200);
  } finally {
    await f.mf.dispose();
  }
});

test("corrupt R2 bytes, wrong digests and mismatched root CIDs never become public content", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.read()).status, 200);
    await f.bucket.put(key, new Uint8Array([1, 2, 3]));
    f.available(false);
    assert.equal((await f.read()).status, 503);
    f.available(true);
    assert.equal((await f.read()).status, 200);
    assert.deepEqual(
      new Uint8Array(await (await f.bucket.get(key))!.arrayBuffer()),
      bytes,
    );
    assert.equal((await f.read("digest=0x" + "ff".repeat(32))).status, 503);
    const other = await preparePin(
      new Uint8Array([1, 2, 3]),
      "application/json",
    );
    assert.equal(
      (await f.read("uri=" + encodeURIComponent(other.uri))).status,
      503,
    );
    assert.equal((await f.bucket.list()).objects.length, 1);
  } finally {
    await f.mf.dispose();
  }
});

test("R2 failures do not reject authenticated gateway bytes and uncached calls still prove remote availability", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.read("mode=write-failure")).status, 200);
    assert.equal(await f.bucket.get(key), null);
    assert.equal((await f.read("mode=read-failure")).status, 200);
    assert.equal(f.requests(), 2);
    f.available(false);
    assert.equal((await f.read()).status, 200);
    assert.equal((await f.read("mode=uncached")).status, 503);
    assert.equal(f.requests(), 4);
  } finally {
    await f.mf.dispose();
  }
});

test("concurrent verified reads safely converge on the same R2 object without new coordination", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all([f.read(), f.read(), f.read()]);
    assert.ok(results.every((r) => r.status === 200));
    assert.equal((await f.bucket.list()).objects.length, 1);
    f.available(false);
    assert.equal((await f.read()).status, 200);
    assert.deepEqual(
      new Uint8Array(await (await f.bucket.get(key))!.arrayBuffer()),
      bytes,
    );
  } finally {
    await f.mf.dispose();
  }
});
