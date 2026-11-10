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

test("processing failure retries are bounded; duplicate consumers and lost queue sends are safe", async (t) => {
  const f = await fixture(t),
    item = await f.reserve();
  f.ports.enqueue = async () => {
    throw Error("lost queue");
  };
  await f.service.upload(item.id, actor, f.source);
  assert.equal((await f.repository.get(item.id)).state, "queued");
  f.ports.processor = undefined;
  for (let n = 0; n < 3; n++) {
    await Promise.all([f.service.process(item.id), f.service.process(item.id)]);
    const record = await f.repository.get(item.id);
    assert.equal(record.state, "failed");
    assert.equal(record.attempts, n + 1);
    if (n < 2) await f.service.retry(item.id, actor);
  }
  await assert.rejects(
    f.service.retry(item.id, actor),
    /media_retry_unavailable/,
  );
});

test("withdrawal during processing cannot resurrect bytes or readiness", async (t) => {
  const f = await fixture(t),
    item = await f.reserve();
  await f.service.upload(item.id, actor, f.source);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = f.ports.processor!;
  f.ports.processor = {
    async render(...args) {
      entered();
      await stopped;
      return previous.render(...args);
    },
  };
  const running = f.service.process(item.id);
  await started;
  await f.service.withdraw(item.id, actor);
  release();
  await running;
  assert.equal((await f.repository.get(item.id)).state, "withdrawn");
  assert.equal(
    (await f.media.list({ prefix: f.service.prefix(item.id) })).objects.length,
    0,
  );
});

test("actual local FFmpeg renders song-backed phone MP4 through D1/R2 and HTTP", async (t) => {
  const f = await fixture(t),
    dir = await mkdtemp(join(process.env.TMPDIR!, "media-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, "source.mp4"),
    songPath = join(dir, "song.wav");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:r=30:d=3",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    sourcePath,
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    songPath,
  ]);
  const source = new Uint8Array(await readFile(sourcePath)),
    audio = new Uint8Array(await readFile(songPath));
  f.song.audioSha256 = await sha256(audio);
  const processor = new FFmpegMediaProcessor({
    tempRoot: dir,
    loadSong: async () => audio,
  });
  f.ports.processor = new BoundMediaProcessor({
    fetch: async (input, init) => {
      const request = new Request(input, {
        ...init,
        body: await new Response(init?.body).arrayBuffer(),
      });
      return communityMediaRender(request, processor, {
        authorize: async () => true,
        current: async (_community, id) => f.repository.get(id),
        song: async () => f.song,
        now: f.now,
      });
    },
  });
  const item = await f.reserve({
    requestId: "ffmpeg_0001",
    recordingSha256: await sha256(source),
    bytes: source.length,
  });
  await f.service.upload(item.id, actor, source);
  await f.service.process(item.id);
  const record = await f.repository.get(item.id);
  assert.equal(record.state, "ready", record.error);
  assert.equal(record.rendition?.videoCodec, "h264");
  assert.equal(record.rendition?.audioCodec, "aac");
  const response = await f.http(`/api/media/${item.id}/playback`, actor);
  const delivered = new Uint8Array(await response!.arrayBuffer());
  assert.equal(await sha256(delivered), record.rendition?.sha256);
  assert.ok(
    Buffer.from(delivered).indexOf("moov") <
      Buffer.from(delivered).indexOf("mdat"),
  );
  f.song.audioSha256 = "d".repeat(64);
  assert.equal(
    (await f.http(`/api/media/${item.id}/playback`, actor))?.status,
    409,
  );
});

test("lease recovery fences stale work; erasure scans tombstones for late outputs", async (t) => {
  const f = await fixture(t),
    item = await f.reserve();
  await f.service.upload(item.id, actor, f.source);
  const before = await f.repository.get(item.id);
  const leased = await f.repository.save(before, {
    state: "processing",
    claim: "lost_worker",
    leaseUntil: f.now() + 1,
    attempts: 1,
  });
  f.setNow(f.now() + 1);
  await f.service.recover();
  assert.equal((await f.repository.get(item.id)).state, "queued");
  await assert.rejects(
    f.repository.save(leased, { state: "ready" }),
    /media_state_changed/,
  );
  await f.service.process(item.id);
  assert.equal((await f.repository.get(item.id)).state, "ready");
  await f.service.withdraw(item.id, actor);
  await f.media.put(
    `${f.service.prefix(item.id)}late-output`,
    "interrupted worker fixture",
  );
  await f.service.recover();
  assert.equal(
    (await f.media.list({ prefix: f.service.prefix(item.id) })).objects.length,
    0,
  );
});

test("private render transport refuses unauthenticated calls before reading the body", async () => {
  const response = await communityMediaRender(
    new Request("https://community-media.internal/render", {
      method: "POST",
      body: "untrusted",
    }),
    {
      render: async () => {
        throw Error("must not render");
      },
    },
    {
      authorize: async () => false,
      current: async () => {
        throw Error("must not read");
      },
      song: async () => {
        throw Error("must not read");
      },
      now: () => Date.now(),
    },
  );
  assert.equal(response.status, 403);
});
