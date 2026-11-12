/** UNRUN. Actual original c7 packet-copy controller and exact encoded fixture.
 * Confirms file-prefix semantics when run; never physical camera acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny";
import { boundDanceRecording } from "../src/dance/source/dance-capture-media.ts";
const window = {
  body_start_ms: 0,
  body_end_ms: 8013,
  cue: {
    kind: "none" as const,
    start_ms: 0 as const,
    end_ms: 0 as const,
    hold_ms: 0 as const,
  },
};
async function fixture(name = "capture-prefix-avc-aac.mp4") {
  return new File(
    [
      new Uint8Array(
        await readFile(new URL(`./dance-fixtures/${name}`, import.meta.url)),
      ),
    ],
    "take.mp4",
    { type: "video/mp4" },
  );
}
async function packets(file: File) {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const video = await input.getPrimaryVideoTrack(),
      audio = await input.getPrimaryAudioTrack();
    assert.ok(video && audio);
    const read = async (track: typeof video | typeof audio) => {
      const rows = [];
      for await (const p of new EncodedPacketSink(track).packets())
        rows.push({
          timestamp: p.timestamp,
          duration: p.duration,
          digest: createHash("sha256").update(p.data).digest("hex"),
        });
      return rows;
    };
    return {
      video: await read(video),
      audio: await read(audio),
      ends: await Promise.all([
        video.computeDuration(),
        audio.computeDuration(),
        input.computeDuration(),
      ]),
    };
  } finally {
    input.dispose();
  }
}
test("non-frame-aligned frozen no-pose endpoint preserves every prefix packet hash and timestamp", async () => {
  const file = await fixture(),
    before = await packets(file);
  const bounded = await boundDanceRecording({
    file,
    window,
    maximumBytes: 1000000,
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  const after = await packets(bounded);
  assert.deepEqual(
    after.ends.map((n) => Math.round(n * 1000)),
    [8013, 8013, 8013],
  );
  for (const kind of ["video", "audio"] as const) {
    const original = before[kind].filter(
      (p) => p.timestamp >= 0 && p.timestamp < 8.013,
    );
    assert.deepEqual(
      after[kind].map((p) => [p.timestamp, p.digest]),
      original.map((p) => [p.timestamp, p.digest]),
    );
    assert.equal(after[kind][0]!.timestamp, 0);
  }
});
test("negative AAC pre-roll, incomplete endpoint and byte overflow refuse rather than invent coverage", async () => {
  const options = {
    window,
    maximumBytes: 1000000,
    signal: new AbortController().signal,
    assertCurrent: () => {},
  };
  await assert.rejects(
    boundDanceRecording({
      ...options,
      file: await fixture("capture-preroll-avc-aac.mp4"),
    }),
    /incomplete/,
  );
  await assert.rejects(
    boundDanceRecording({
      ...options,
      window: { ...window, body_end_ms: 9000 },
      file: await fixture(),
    }),
    /incomplete/,
  );
  await assert.rejects(
    boundDanceRecording({
      ...options,
      maximumBytes: 100,
      file: await fixture(),
    }),
    /size_exceeded/,
  );
});
test("abort or changed authority during media work cannot return a usable file", async () => {
  for (const reason of ["abort", "authority"] as const) {
    const abort = new AbortController();
    let current = true;
    const pending = boundDanceRecording({
      file: await fixture(),
      window,
      maximumBytes: 1000000,
      signal: abort.signal,
      assertCurrent: () => {
        if (!current) throw Error("revoked");
      },
    });
    queueMicrotask(() => {
      if (reason === "abort") abort.abort();
      else current = false;
    });
    await assert.rejects(pending);
  }
});
