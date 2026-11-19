import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { canonical, hashJson } from "../packages/community/common.ts";
import { startWeb2NativeActivityHost } from "../deploy/linux/web2-native-activity-host.ts";
import { acquireWeb2ServiceControl } from "../deploy/linux/web2-service-lease.ts";

const quote = "/publication/v1/posts-quote";
const dispatch = "/publication/v1/posts-dispatch";
const managed = "/publication/v1/managed-request";
const reservation = "/publication/v1/posts-catalog-reservation";
const response = "/publication/v1/posts-catalog-respond";
const jobId = "publication:b267c543-c822-436e-aeaf-8d5ec9569242";
const digest = digit => "0x" + digit.repeat(64);
const original = digest("b"), heldJobLease = digest("c");
const expiry = 1_800_000_000;
const forward = "Bearer " + "a".repeat(43);
function compact({ purpose = "ready", step = purpose === "ready" ? "publication" : "catalog_reserve",
  releaseSha256 = original, leaseSha256 = heldJobLease } = {}) {
  return canonical({ version: "pirate.native-posts-catalog-reservation-request/1", purpose,
    reference: { installationId: digest("a"), releaseSha256, jobId, step,
      operationId: hashJson({ job: jobId, step }), requestHash: digest("d") },
    ...(purpose === "status" ? {} : { initiatingLeaseSha256: leaseSha256 }),
  });
}
function signed(action, { signer = action === "ready" ? "moderation" : "recognition", expiresAt = expiry,
  configurationSha256 = original } = {}) {
  const body = { jobId };
  return canonical({ payload: { schema: "pirate.canonical-community-request/1", action, bodySha256: hashJson(body),
    signer, expiresAt, configurationSha256 }, body, signature: digest("e") });
}

async function fixture(t, handle) {
  const root = await mkdtemp("/var/tmp/w6-posts-nested-");
  const socket = join(root, "activity-transport", "host.sock");
  let host, control;
  t.after(async () => {
    await host?.close();
    await control?.closeControl();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "activity-transport"), { mode: 0o700 });
  await mkdir(join(root, "control"), { mode: 0o700 });
  control = await acquireWeb2ServiceControl(join(root, "control"), "disposable-posts-nested");
  const { lease } = control;
  const observations = [];
  function call(path, raw = "{}", authorization = forward) {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: socket, method: "POST", path, agent: false, timeout: 5000, headers: {
        authorization, "content-type": "application/json", "content-length": Buffer.byteLength(raw),
      } }, incoming => {
        const chunks = [];
        incoming.on("data", chunk => chunks.push(chunk));
        incoming.on("end", () => resolve({
          status: incoming.statusCode, headers: incoming.headers, raw: Buffer.concat(chunks).toString("utf-8"),
        }));
        incoming.on("error", reject);
      });
      req.once("timeout", () => req.destroy(new Error("fixture Unix request timed out")));
      req.once("error", reject);
      req.end(raw);
    });
  }
  let delegate = {
    lease, socket,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      observations.push({ path, raw: await req.text() });
      return handle.effect(path, call);
    },
    async fetchNested(req, lane) {
      await lease.assertHeld();
      const url = new URL(req.url);
      assert.equal(url.origin, "https://publication.internal");
      const raw = await req.text();
      const value = JSON.parse(raw);
      const authorized = req.headers.get("authorization") === forward &&
        (url.pathname === reservation
          ? value.reference.releaseSha256 === original && value.initiatingLeaseSha256 === heldJobLease
          : value.payload.configurationSha256 === original && value.payload.expiresAt > (handle.now?.() ?? expiry - 1) &&
            value.payload.signer === (value.payload.action === "ready" ? "moderation" : "recognition"));
      if (!authorized) return new Response(null, { status: 403 });
      observations.push({ path: url.pathname, lane, raw });
      return handle.read(url.pathname, lane, value, call);
    },
    async close() {},
  };
  host = await startWeb2NativeActivityHost({
    stateRoot: root, lease, deferredProtectedPosts: () => delegate,
    ingress: { origin: "https://fixture.invalid", upstream: "https://127.0.0.1:8443" },
  });
  return { call, host, observations, replaceDelegate: update => { delegate = update(delegate); } };
}

test("protected Posts quote and dispatch accept the compact ready and canonical read callbacks on one Unix listener", async t => {
  const compactReady = compact(), canonicalRead = signed("read");
  const f = await fixture(t, {
    async effect(path, call) {
      assert([quote, dispatch].includes(path));
      assert.equal((await call(reservation, compact({ purpose: "reserve" }))).status, 429);
      assert.equal((await call(response, signed("authorize"))).status, 429);
      const result = await call(reservation, compactReady);
      assert.equal(result.status, 200);
      assert.equal(result.headers["x-pirate-canonical-receipt"], "fixture-receipt");
      return new Response(result.raw);
    },
    async read(path, lane, _value, call) {
      if (path === reservation) {
        assert.equal(lane, "ready");
        assert.equal((await call(reservation, compactReady)).status, 429);
        const leaf = await call(response, canonicalRead);
        return new Response(leaf.raw, { status: leaf.status,
          headers: { "x-pirate-canonical-receipt": leaf.headers["x-pirate-canonical-receipt"] } });
      }
      assert.equal(lane, "canonical");
      assert.equal((await call(response, canonicalRead)).status, 429);
      return new Response("exact catalog evidence", { headers: { "x-pirate-canonical-receipt": "fixture-receipt" } });
    },
  });
  for (const path of [quote, dispatch]) assert.equal((await f.call(path)).raw, "exact catalog evidence");
  assert.deepEqual(f.observations, [quote, dispatch].flatMap(path => [
    { path, raw: "{}" }, { path: reservation, lane: "ready", raw: compactReady },
    { path: response, lane: "canonical", raw: canonicalRead },
  ]));
});

test("managed pin accepts moderation ready and its second callback on the same canonical path during drain", async t => {
  const readyEntered = Promise.withResolvers();
  const allowReady = Promise.withResolvers();
  const leafEntered = Promise.withResolvers();
  const finishLeaf = Promise.withResolvers();
  t.after(() => { allowReady.resolve(); finishLeaf.resolve(); });
  const f = await fixture(t, {
    async effect(path, call) {
      assert.equal(path, managed);
      readyEntered.resolve();
      await allowReady.promise;
      const parent = await call(response, signed("ready"));
      return new Response(parent.raw, { status: parent.status });
    },
    async read(path, lane, _value, call) {
      assert.equal(path, response);
      if (lane === "ready") {
        const child = await call(response, signed("read"));
        return new Response(child.raw, { status: child.status });
      }
      leafEntered.resolve();
      await finishLeaf.promise;
      return new Response("retained catalog evidence");
    },
  });
  const pin = f.call(managed);
  await readyEntered.promise;
  let drained = false;
  const drain = f.host.drainProtectedPosts().then(() => { drained = true; });
  allowReady.resolve();
  await leafEntered.promise;
  try {
    assert.equal(drained, false);
    assert.equal((await f.call(quote)).status, 429);
    assert.equal((await f.call(response, signed("read"))).status, 429);
  } finally {
    finishLeaf.resolve();
  }
  const result = await pin;
  assert.equal(result.status, 200);
  assert.equal(result.raw, "retained catalog evidence");
  await drain;
  assert.equal(await f.call(response, signed("ready")).then(r => r.status), 429);
  assert.equal(await f.call(response, signed("read")).then(r => r.status), 429);
});

test("wrong original, stale lease, wrong roles and exact expiry never return nested data", async t => {
  const refuse = [
    [reservation, compact({ releaseSha256: digest("f") }), forward, 403],
    [reservation, compact({ leaseSha256: digest("f") }), forward, 403],
    [reservation, compact(), "Bearer " + "b".repeat(43), 403],
    [reservation, compact({ step: "pin_audio" }), forward, 400],
    [reservation, compact() + "\n", forward, 400],
    [reservation, " ".repeat(4097), forward, 413],
    [response, signed("ready", { signer: "recognition" }), forward, 403],
    [response, signed("read", { expiresAt: expiry - 1 }), forward, 403],
    [response, signed("source", { configurationSha256: digest("f") }), forward, 403],
    [response, signed("publication"), forward, 400],
  ];
  const f = await fixture(t, {
    async effect(_path, call) {
      for (const [path, raw, bearer, status] of refuse) {
        const rejected = await call(path, raw, bearer);
        assert.equal(rejected.status, status);
        assert.equal(rejected.raw, "");
      }
      return new Response(null, { status: 204 });
    },
    read() { assert.fail("rejected request reached the read responder"); },
  });
  assert.equal((await f.call(dispatch)).status, 204);
  assert.deepEqual(f.observations, [{ path: dispatch, raw: "{}" }]);
});

test("the read lane requires a nested delegate on the same held listener lease", async t => {
  const f = await fixture(t, {
    async effect(_path, call) {
      return new Response(null, { status: (await call(response, signed("read"))).status });
    },
    read() { assert.fail("unavailable delegate reached a responder"); },
  });
  f.replaceDelegate(route => ({ ...route, fetchNested: undefined }));
  assert.equal((await f.call(quote)).status, 503);
  f.replaceDelegate(route => ({ ...route, lease: { ...route.lease },
    fetchNested() { assert.fail("changed lease reached nested delegate"); } }));
  assert.equal((await f.call(response, signed("read"))).status, 503);
  assert.deepEqual(f.observations, [{ path: quote, raw: "{}" }]);
});

test("legacy serial routes and non-nested reserve, status and authorize retain the ordinary delegate", async t => {
  const f = await fixture(t, {
    effect(path) {
      assert([quote, reservation, response].includes(path));
      return new Response(null, { status: 204 });
    },
    read() { assert.fail("ordinary route reached the nested delegate"); },
  });
  const calls = [[quote, "{}"], [reservation, compact({ purpose: "reserve" })],
    [reservation, compact({ purpose: "status" })], [response, signed("authorize")]];
  for (const [path, raw] of calls) assert.equal((await f.call(path, raw)).status, 204);
  assert.deepEqual(f.observations, calls.map(([path, raw]) => ({ path, raw })));
});
