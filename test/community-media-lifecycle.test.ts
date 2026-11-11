import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { communityRuntime } from "./community-runtime.ts";
import { CommunityMedia } from "../services/community-media.ts";
import { communityMediaApi } from "../services/community-media-api.ts";
import {
  MediaRepository,
  MEDIA_COMMIT_GUARD,
  mediaCommitValues,
} from "../packages/community-media/repository.ts";
import {
  sha256,
  SAMPLE_RATE,
  validateIntent,
} from "../packages/community-media/validation.ts";
import { FFmpegMediaProcessor } from "../packages/community-media/ffmpeg.ts";
import {
  BoundMediaProcessor,
  communityMediaRender,
} from "../packages/community-media/processor-transport.ts";
import type {
  MediaIntent,
  MediaProcessor,
  PublishedMediaSong,
} from "../packages/community-media/contracts.ts";

import { actor, reviewer, fixture, exec } from "./community-media-fixture.ts";

test("capacity reservations are atomic and erasure releases the allowance", async (t) => {
  const f = await fixture(t);
  f.ports.quota.perAccount = 1;
  const results = await Promise.allSettled([
    f.reserve(),
    f.reserve({ requestId: "request_0002" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const success = results.find((r) => r.status === "fulfilled");
  assert.ok(success?.status === "fulfilled");
  await f.service.withdraw(success.value.id, actor);
  assert.equal(
    (await f.reserve({ requestId: "request_0003" })).state,
    "uploading",
  );
  f.ports.quota.bytesPerCommunity = 1;
  await assert.rejects(
    f.service.reserve(
      { accountId: "learner-b" },
      { ...f.intent, requestId: "request_0004" },
    ),
    /media_capacity_full/,
  );
});

test("revoke and expiry close review; media never changes private audience", async (t) => {
  const f = await fixture(t),
    privateMedia = await f.ready();
  await f.service.revoke(privateMedia.id, reviewer);
  assert.equal((await f.repository.get(privateMedia.id)).state, "revoked");
  await assert.rejects(
    f.service.readyForReview(privateMedia.id, privateMedia, reviewer),
    /media_unavailable/,
  );
  f.allowPublic();
  const publicMedia = await f.ready({
    requestId: "request_0002",
    purpose: "public-feed",
    publicConsent: true,
  });
  f.revokePublic();
  assert.equal((await f.service.feed()).items.length, 0);
  assert.equal(
    (await f.http(`/api/media/${publicMedia.id}/playback`, null))?.status,
    410,
  );
  const foreign = new MediaRepository(f.db, "another-community");
  await assert.rejects(foreign.get(publicMedia.id), /media_not_found/);
});

test("private Dance duration policy is server-owned and frozen without widening public clips", async (t) => {
  const f = await fixture(t);
  f.ports.privateReviewPolicy = {
    version: "dance-reference/1",
    minSamples: 6 * SAMPLE_RATE,
    maxSamples: 30 * SAMPLE_RATE,
  };
  const item = await f.reserve({ durationSamples: 30 * SAMPLE_RATE });
  assert.equal(
    (await f.repository.get(item.id)).mediaPolicyVersion,
    "dance-reference/1",
  );
  f.allowPublic();
  await assert.rejects(
    f.reserve({
      requestId: "request_0002",
      durationSamples: 30 * SAMPLE_RATE,
      purpose: "public-feed",
      publicConsent: true,
    }),
    /invalid_media_integer/,
  );
});

test("erasure failures stay private and reserve capacity until recovery succeeds", async (t) => {
  const f = await fixture(t),
    record = await f.ready();
  f.ports.quota.perAccount = 1;
  const bucket = f.ports.bucket;
  f.ports.bucket = new Proxy(bucket, {
    get(target, property) {
      if (property === "delete")
        return async () => {
          throw Error("local erasure fault");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await f.service.withdraw(record.id, actor);
  assert.equal((await f.repository.get(record.id)).erasePending, true);
  assert.equal(
    (await f.http(`/api/media/${record.id}/playback`, actor))?.status,
    410,
  );
  await assert.rejects(
    f.reserve({ requestId: "request_0002" }),
    /media_capacity_full/,
  );
  f.ports.bucket = bucket;
  await f.service.recover();
  assert.equal((await f.repository.get(record.id)).erasePending, false);
  assert.equal(
    (await f.media.list({ prefix: f.service.prefix(record.id) })).objects
      .length,
    0,
  );
  assert.equal(
    (await f.reserve({ requestId: "request_0002" })).state,
    "uploading",
  );
});

test("a failed media wake leaves durable retry intent and does not block later erasure", async (t) => {
  const f = await fixture(t);
  const first = await f.ready({ requestId: "wake_failure_1" });
  const second = await f.ready({ requestId: "wake_failure_2" });
  const [earlier, later] = [first, second].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  await f.repository.save(earlier, { state: "queued" });
  await f.repository.save(later, { expiresAt: f.now() });
  let fail = true;
  const queued: string[] = [];
  f.ports.enqueue = async (id) => {
    queued.push(id);
    if (fail) throw Error("fixture_queue_unavailable");
  };
  assert.equal(await f.service.recover(), null);
  assert.deepEqual(queued, [earlier.id]);
  assert.equal((await f.repository.get(earlier.id)).state, "queued");
  const retired = await f.repository.get(later.id);
  assert.equal(retired.state, "expired");
  assert.equal(retired.erasePending, false);
  assert.equal(
    (await f.media.list({ prefix: f.service.prefix(later.id) })).objects.length,
    0,
  );
  fail = false;
  await f.service.recover();
  assert.deepEqual(queued, [earlier.id, earlier.id]);
});
