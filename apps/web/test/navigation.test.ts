import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalHref, createDataSource, matchRoute, PublicRecords, readSession, resolveMode } from "../src/client/navigation.ts";

const config = { canonicalOrigin: "https://community.example" };

test("only the canonical origin is canonical; every other origin is a mirror", () => {
  assert.equal(resolveMode("https://community.example", config), "canonical");
  assert.equal(resolveMode("http://bafybeiexample.ipfs.localhost:8080", config), "mirror");
  assert.equal(resolveMode("https://community.example.evil", config), "mirror");
  assert.equal(canonicalHref(config, "/posts/a/"), "https://community.example/posts/a/");
});

test("canonical links keep the canonical origin for network-path and backslash forms", () => {
  for (const path of ["//outside.invalid/path", "///outside.invalid/path", "/\\outside.invalid/path", "\\\\outside.invalid\\path", "/%2F%2Foutside.invalid", "outside.invalid"]) {
    const href = new URL(canonicalHref(config, path));
    assert.equal(href.origin, "https://community.example", path);
    assert.ok(!href.pathname.startsWith("//"), path);
  }
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
const post = (revision: number) => ({ kind: "post", slug: "first-song", revision, title: `r${revision}`, body: `body ${revision}` });
const removed = (revision: number) => ({ kind: "removed", slug: "first-song", revision });
const never = (signal?: AbortSignal | null) => new Promise<Response>((_, reject) =>
  signal?.addEventListener("abort", () => reject(signal.reason)));
const open = () => new AbortController().signal;

test("records only move forward; a removal is never replaced by older content", () => {
  const records = new PublicRecords();
  assert.equal(records.acceptPost(post(1) as never), true);
  assert.equal(records.acceptPost(removed(2) as never), true);
  assert.equal(records.acceptPost(post(1) as never), false);
  assert.equal(records.acceptPost(removed(2) as never), false);
  assert.equal(records.post("first-song")?.kind, "removed");
  assert.equal(records.acceptPost(post(3) as never), true);
});

test("mirror reads only the snapshot", async () => {
  const seen: string[] = [];
  const source = createDataSource("mirror", async url => { seen.push(url); return url.includes("community") ? respond(200, { revision: 1, name: "x", posts: [] }) : respond(200, post(1)); });
  await source.refreshCommunity(open(), () => undefined);
  await source.refreshPost("first-song", open(), () => undefined);
  assert.deepEqual(seen, ["/public/data/community.json", "/public/data/posts/first-song.json"]);
});

test("a removal seen from the API survives a later outage and an older snapshot", async () => {
  let apiUp = true;
  const source = createDataSource("canonical", async url =>
    url.startsWith("/api/") ? (apiUp ? respond(200, removed(2)) : respond(503)) : respond(200, post(1)));
  assert.equal(await source.refreshPost("first-song", open(), () => undefined), "found");
  assert.equal(source.records.post("first-song")?.kind, "removed");
  apiUp = false;
  const advanced: unknown[] = [];
  assert.equal(await source.refreshPost("first-song", open(), record => advanced.push(record)), "found");
  assert.equal(source.records.post("first-song")?.kind, "removed");
  assert.deepEqual(advanced, []);
});

test("a stalled API does not hold back the snapshot and is bounded", async () => {
  const source = createDataSource("canonical", async (url, init) =>
    url.startsWith("/api/") ? never(init?.signal) : respond(200, post(1)), 50);
  const advanced: string[] = [];
  const started = Date.now();
  const status = await source.refreshPost("first-song", open(), record => advanced.push(`${record.kind}:${record.revision}`));
  assert.equal(status, "found");
  assert.deepEqual(advanced, ["post:1"]);
  assert.ok(Date.now() - started < 2000, "bounded by the read timeout");
});

test("an aborted refresh reports nothing", async () => {
  const controller = new AbortController();
  const source = createDataSource("canonical", async (_url, init) => never(init?.signal));
  const pending = source.refreshPost("first-song", controller.signal, () => assert.fail("no advance after abort"));
  controller.abort();
  assert.equal(await pending, "unavailable");
});

test("the API's 404 is authoritative; snapshot misses and bad payloads are not", async () => {
  const gone = createDataSource("canonical", async url => url.startsWith("/api/") ? respond(404) : respond(200, post(1)));
  assert.equal(await gone.refreshPost("first-song", open(), () => undefined), "missing");
  const unseen = createDataSource("canonical", async url => url.startsWith("/api/") ? respond(503) : respond(404));
  assert.equal(await unseen.refreshPost("first-song", open(), () => undefined), "unavailable");
  const malformed = createDataSource("canonical", async () => respond(200, { kind: "post", slug: "other", revision: 9 }));
  assert.equal(await malformed.refreshPost("first-song", open(), () => undefined), "unavailable");
});


test("session states", async () => {
  assert.equal(await readSession(async () => respond(401)), "signed-out");
  assert.equal(await readSession(async () => respond(200)), "signed-in");
  assert.equal(await readSession(async () => respond(503)), "unavailable");
  assert.equal(await readSession(async () => { throw new Error("offline"); }), "unavailable");
  const slow = readSession((_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))), 20);
  assert.equal(await slow, "unavailable");
});
