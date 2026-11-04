import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalHref, createDataSource, matchRoute, PublicRecords, readSession, recordKey, resolveMode, sameView, viewFor } from "../src/client/navigation.ts";

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
const key = recordKey.post("first-song");

test("records only move forward; a removal is never replaced by older content", () => {
  const records = new PublicRecords();
  const announced: string[] = [];
  records.subscribe(changed => announced.push(changed));
  assert.equal(records.accept(key, post(1), false), true);
  assert.equal(records.accept(key, removed(2), true), true);
  assert.equal(records.accept(key, post(1), true), false);
  assert.equal(records.accept(key, removed(2), true), false);
  assert.equal(records.post("first-song")?.kind, "removed");
  assert.equal(records.accept(key, post(3), false), true);
  assert.deepEqual(announced, [key, key, key]);
});

test("an authoritative 404 is remembered until an authoritative record arrives", () => {
  const records = new PublicRecords();
  records.accept(key, post(1), false);
  records.markMissing(key);
  assert.equal(records.post("first-song"), undefined);
  assert.equal(records.accept(key, post(5), false), false, "snapshot cannot undo an authoritative 404");
  assert.equal(records.isMissing(key), true);
  assert.equal(records.accept(key, post(1), true), true, "the authority can bring a record back");
  assert.equal(records.isMissing(key), false);
});

test("mirror reads only the snapshot", async () => {
  const seen: string[] = [];
  const source = createDataSource("mirror", async url => { seen.push(url); return url.includes("community") ? respond(200, { revision: 1, name: "x", posts: [] }) : respond(200, post(1)); });
  await source.refreshCommunity(open());
  await source.refreshPost("first-song", open());
  assert.deepEqual(seen, ["/public/data/community.json", "/public/data/posts/first-song.json"]);
});

test("a removal seen from the API survives a later outage and an older snapshot", async () => {
  let apiUp = true;
  const source = createDataSource("canonical", async url =>
    url.startsWith("/api/") ? (apiUp ? respond(200, removed(2)) : respond(503)) : respond(200, post(1)));
  assert.equal(await source.refreshPost("first-song", open()), "found");
  assert.equal(source.records.post("first-song")?.kind, "removed");
  apiUp = false;
  const announced: string[] = [];
  source.records.subscribe(changed => announced.push(changed));
  assert.equal(await source.refreshPost("first-song", open()), "found");
  assert.equal(source.records.post("first-song")?.kind, "removed");
  assert.deepEqual(announced, []);
});

test("an authoritative 404 survives a later outage", async () => {
  let api = 404;
  const source = createDataSource("canonical", async url => url.startsWith("/api/") ? respond(api) : respond(200, post(1)));
  assert.equal(await source.refreshPost("first-song", open()), "missing");
  api = 503;
  assert.equal(await source.refreshPost("first-song", open()), "missing");
  assert.equal(source.records.post("first-song"), undefined);
});

test("a stalled API does not hold back the snapshot and is bounded", async () => {
  const source = createDataSource("canonical", async (url, init) =>
    url.startsWith("/api/") ? never(init?.signal) : respond(200, post(1)), 50);
  const started = Date.now();
  let snapshotAt: number | undefined;
  source.records.subscribe(() => { snapshotAt ??= Date.now() - started; });
  const status = await source.refreshPost("first-song", open());
  assert.equal(status, "found");
  assert.equal(source.records.post("first-song")?.revision, 1);
  assert.ok(snapshotAt !== undefined && snapshotAt < 50, "the snapshot is stored before the API times out");
  assert.ok(Date.now() - started < 2000, "bounded by the read timeout");
});

test("reads work without AbortSignal.any", async () => {
  const any = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  delete (AbortSignal as { any?: unknown }).any;
  try {
    const source = createDataSource("canonical", async (url, init) =>
      url.startsWith("/api/") ? never(init?.signal) : respond(200, post(1)), 20);
    assert.equal(await source.refreshPost("first-song", open()), "found");
  } finally {
    if (any !== undefined) Object.defineProperty(AbortSignal, "any", any);
  }
});

test("an aborted refresh stores nothing", async () => {
  const controller = new AbortController();
  const source = createDataSource("canonical", async (_url, init) => never(init?.signal));
  source.records.subscribe(() => assert.fail("no store change after abort"));
  const pending = source.refreshPost("first-song", controller.signal);
  controller.abort();
  assert.equal(await pending, "unavailable");
});

test("snapshot misses and bad payloads are not authoritative", async () => {
  const unseen = createDataSource("canonical", async url => url.startsWith("/api/") ? respond(503) : respond(404));
  assert.equal(await unseen.refreshPost("first-song", open()), "unavailable");
  const malformed = createDataSource("canonical", async () => respond(200, { kind: "post", slug: "other", revision: 9 }));
  assert.equal(await malformed.refreshPost("first-song", open()), "unavailable");
});

test("views follow the store and unchanged views compare equal", () => {
  const records = new PublicRecords();
  const route = { kind: "post", slug: "first-song" } as const;
  assert.equal(viewFor(route, records, false), undefined);
  records.accept(key, post(1), true);
  const first = viewFor(route, records, false)!;
  assert.equal(first.kind, "post");
  assert.equal(sameView(first, viewFor(route, records, false)!), true);
  assert.equal(sameView(first, viewFor(route, records, true)!), false);
  records.accept(key, removed(2), true);
  assert.deepEqual(viewFor(route, records, false), { kind: "removed" });
  records.markMissing(key);
  assert.deepEqual(viewFor(route, records, false), { kind: "not-found" });
  assert.equal(viewFor({ kind: "community" }, records, false), undefined);
  assert.deepEqual(viewFor({ kind: "about" }, records, false), { kind: "about", community: null });
});

test("session states", async () => {
  assert.equal(await readSession(async () => respond(401)), "signed-out");
  assert.equal(await readSession(async () => respond(200)), "signed-in");
  assert.equal(await readSession(async () => respond(503)), "unavailable");
  assert.equal(await readSession(async () => { throw new Error("offline"); }), "unavailable");
  const slow = readSession((_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))), 20);
  assert.equal(await slow, "unavailable");
});
