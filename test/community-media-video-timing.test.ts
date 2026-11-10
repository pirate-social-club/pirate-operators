import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { actor, exec, fixture } from "./community-media-fixture.ts";
import { FFmpegMediaProcessor } from "../packages/community-media/ffmpeg.ts";
import { verifyVideoTiming } from "../packages/community-media/video-timing.ts";
import { sha256 } from "../packages/community-media/validation.ts";

test("one-second visual stream with six-second audio is refused for source and output timing", async (t) => {
  const f = await fixture(t),
    dir = await mkdtemp(join(process.env.TMPDIR!, "media-timing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = join(dir, "short-picture.mp4"),
    canonical = join(dir, "song.wav");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=6",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    original,
  ]);
  await exec("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:sample_rate=48000:duration=7",
    canonical,
  ]);
  const source = new Uint8Array(await readFile(original)),
    audio = new Uint8Array(await readFile(canonical));
  f.song.audioSha256 = await sha256(audio);
  const processor = new FFmpegMediaProcessor({
    tempRoot: dir,
    loadSong: async () => audio,
  });
  const probe = await processor.probe(original);
  assert.ok(
    Number(probe.format.duration) >= 6,
    "old container predicate would accept this source",
  );
  await assert.rejects(
    verifyVideoTiming(original, 6, "source"),
    /media_video_too_short/,
  );
  await assert.rejects(
    verifyVideoTiming(original, 6, "rendition"),
    /media_rendition_video_invalid/,
  );
  f.ports.processor = processor;
  const reservation = await f.reserve({
    requestId: "short_video_0001",
    recordingSha256: await sha256(source),
    bytes: source.length,
  });
  await f.service.upload(reservation.id, actor, source);
  await f.service.process(reservation.id);
  const failed = await f.repository.get(reservation.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "media_video_too_short");
  assert.equal(failed.renditionKey, undefined);
  assert.equal(
    (await f.media.list({ prefix: f.service.prefix(failed.id) })).objects
      .length,
    1,
  );
});
