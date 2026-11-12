// UNRUN. Exercises the actual cache used by SongPlayer; no browser/server.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPlaybackAccessCache,
  type PlaybackAccessReader,
} from "../src/shell/player/access-cache.ts";
import type { SongPlaybackGrant } from "../src/shell/playback-access.ts";
const a = { playback_url: "https://fixture.invalid/a.wav" };
const b = { playback_url: "https://fixture.invalid/b.wav" };
function deferredReader() {
  let resolve!: (grant: SongPlaybackGrant) => void;
  const pending = new Promise<SongPlaybackGrant>((done) => {
    resolve = done;
  });
  const reader: PlaybackAccessReader = () => pending;
  return { reader, resolve };
}

test("same post: late unmounted reader A cannot seed remounted reader B or its listener", async () => {
  const cache = createPlaybackAccessCache(),
    pending = deferredReader();
  const readerB: PlaybackAccessReader = async () => {
    throw new Error("B refuses access");
  };
  const old: SongPlaybackGrant[] = [],
    successor: SongPlaybackGrant[] = [];
  const unsubscribeA = cache.subscribe(pending.reader, "post", (grant) =>
    old.push(grant),
  );
  const requestA = pending
    .reader("post")
    .then((grant) => cache.publish(pending.reader, "post", grant));
  unsubscribeA();
  const unsubscribeB = cache.subscribe(readerB, "post", (grant) =>
    successor.push(grant),
  );
  await assert.rejects(readerB("post"));
  pending.resolve(a);
  await requestA;
  assert.deepEqual(old, []);
  assert.deepEqual(successor, []);
  assert.equal(cache.read(readerB, "post", 0), undefined);
  assert.equal(cache.read(pending.reader, "post", 0), a);
  unsubscribeB();
});

test("same post: live reader B resolves before late A; B's cache/listener remains B", async () => {
  const cache = createPlaybackAccessCache(),
    pending = deferredReader();
  const readerB: PlaybackAccessReader = async () => b;
  const received: SongPlaybackGrant[] = [];
  const requestA = pending
    .reader("post")
    .then((grant) => cache.publish(pending.reader, "post", grant));
  const unsubscribeB = cache.subscribe(readerB, "post", (grant) =>
    received.push(grant),
  );
  cache.publish(readerB, "post", await readerB("post"));
  pending.resolve(a);
  await requestA;
  assert.deepEqual(received, [b]);
  assert.equal(cache.read(readerB, "post", 0), b);
  assert.equal(cache.read(pending.reader, "post", 0), a);
  unsubscribeB();
});

test("already cached A is unavailable to a distinct reader, including one refusing access", async () => {
  const cache = createPlaybackAccessCache();
  const readerA: PlaybackAccessReader = async () => a;
  const readerB: PlaybackAccessReader = async () => {
    throw new Error("B refuses access");
  };
  cache.publish(readerA, "post", a);
  assert.equal(cache.read(readerB, "post", 0), undefined);
  await assert.rejects(readerB("post"));
  assert.equal(cache.read(readerB, "post", 0), undefined);
});

test("same reader remount receives its own late result; post and expiry boundaries remain", async () => {
  const cache = createPlaybackAccessCache(),
    pending = deferredReader();
  const received: SongPlaybackGrant[] = [];
  const request = pending
    .reader("A")
    .then((grant) => cache.publish(pending.reader, "A", grant));
  const unsubscribe = cache.subscribe(pending.reader, "A", (grant) =>
    received.push(grant),
  );
  const grant = { ...a, renew_after: 100, expires_at: 110 };
  pending.resolve(grant);
  await request;
  assert.deepEqual(received, [grant]);
  assert.equal(cache.read(pending.reader, "A", 99), grant);
  assert.equal(cache.read(pending.reader, "B", 99), undefined);
  assert.equal(cache.read(pending.reader, "A", 100), undefined);
  unsubscribe();
  assert.equal(cache.read(pending.reader, "A", 99), grant);
});
