import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalHref, createDataSource, matchRoute, readSession, resolveMode } from "../src/client/navigation.ts";

const config = { canonicalOrigin: "https://community.example" };

test("only the canonical origin is canonical; every other origin is a mirror", () => {
  assert.equal(resolveMode("https://community.example", config), "canonical");
  assert.equal(resolveMode("http://bafybeiexample.ipfs.localhost:8080", config), "mirror");
  assert.equal(resolveMode("https://community.example.evil", config), "mirror");
  assert.equal(canonicalHref(config, "/posts/a/"), "https://community.example/posts/a/");
});

test("routes", () => {
  assert.deepEqual(matchRoute("/"), { kind: "community" });
  assert.deepEqual(matchRoute("/posts/first-song/"), { kind: "post", slug: "first-song" });
  assert.deepEqual(matchRoute("/posts/first-song"), { kind: "post", slug: "first-song" });
  assert.deepEqual(matchRoute("/about"), { kind: "about" });
  assert.deepEqual(matchRoute("/posts/Bad_Slug/"), { kind: "not-found" });
  assert.deepEqual(matchRoute("/app/shell.html"), { kind: "not-found" });
});

const respond = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

test("mirror reads only the snapshot", async () => {
  const seen: string[] = [];
  const source = createDataSource("mirror", async url => { seen.push(url); return respond(200, { name: "x" }); });
  await source.community();
  await source.post("first-song");
  assert.deepEqual(seen, ["/public/data/community.json", "/public/data/posts/first-song.json"]);
});

test("canonical reads the API, falls back to the snapshot on failure, and keeps a 404", async () => {
  const seen: string[] = [];
  const failing = createDataSource("canonical", async url => {
    seen.push(url);
    return url.startsWith("/api/") ? respond(503) : respond(200, { kind: "post", revision: 1 });
  });
  assert.deepEqual(await failing.post("first-song"), { kind: "post", revision: 1 });
  assert.deepEqual(seen, ["/api/public/posts/first-song", "/public/data/posts/first-song.json"]);
  const missing = createDataSource("canonical", async () => respond(404));
  assert.equal(await missing.post("nope"), null);
});

test("session states", async () => {
  assert.equal(await readSession(async () => respond(401)), "signed-out");
  assert.equal(await readSession(async () => respond(200)), "signed-in");
  assert.equal(await readSession(async () => respond(503)), "unavailable");
  assert.equal(await readSession(async () => { throw new Error("offline"); }), "unavailable");
  const slow = readSession((_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))), 20);
  assert.equal(await slow, "unavailable");
});
