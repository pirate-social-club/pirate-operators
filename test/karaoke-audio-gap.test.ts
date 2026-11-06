import test from "node:test";
import assert from "node:assert/strict";
import {
  KaraokeAudioRelay,
  type KaraokeRelaySnapshot,
} from "../packages/karaoke/audio-relay.ts";

const frame = (sequence: number, songStartMs: number, songEndMs: number) => ({
  protocolVersion: 1 as const,
  sessionId: "session",
  attemptId: "attempt",
  sequence,
  type: "audio_chunk" as const,
  chunkId: sequence,
  pcm16: new ArrayBuffer(3200),
  sampleRate: 16000 as const,
  songStartMs,
  songEndMs,
});
function fixture(restore?: KaraokeRelaySnapshot) {
  let saved: KaraokeRelaySnapshot | undefined;
  const relay = new KaraokeAudioRelay({
    sessionId: "session",
    attemptId: "attempt",
    lines: [
      { lineId: "first", startMs: 0, endMs: 2000 },
      { lineId: "gap", startMs: 2500, endMs: 4500 },
      { lineId: "last", startMs: 5000, endMs: 7000 },
    ],
    // No recognition in these boundary checks. The integration test exercises
    // real Worker sockets, provider commits, word mapping and final grading.
    createAdapter: () => ({
      streamGeneration: "fixture",
      start: async () => {},
      sendPcm16: async () => {},
      commit: async () => null,
      close: async () => {},
    }),
    restore,
    persist: (snapshot) => {
      saved = snapshot;
    },
  });
  return {
    relay,
    snapshot: () => JSON.parse(JSON.stringify(saved!)) as KaraokeRelaySnapshot,
  };
}

test("a restored audio boundary retains gap evidence after it reaches the scorer", async () => {
  const first = fixture();
  await first.relay.audio(frame(1, 0, 2000));
  const restored = fixture(first.snapshot());
  await first.relay.close();
  try {
    await restored.relay.audio(frame(2, 4500, 4600));
    assert.deepEqual(restored.relay.drain().failedLineIds, ["gap"]);
    restored.relay.seek(0);
    await restored.relay.audio(frame(3, 0, 100));
    assert.deepEqual(restored.snapshot().failedLineIds, ["gap"]);
    assert.deepEqual(restored.relay.drain().failedLineIds, []);
  } finally {
    await restored.relay.close();
  }
});

test("contiguous audio and explicit forward and backward seeks invent no gap failure", async () => {
  const { relay } = fixture();
  try {
    await relay.audio(frame(1, 0, 1000));
    await relay.audio(frame(2, 1000, 2000));
    relay.seek(5000);
    await relay.audio(frame(3, 5000, 5100));
    relay.seek(0);
    await relay.audio(frame(4, 0, 100));
    assert.deepEqual(relay.drain().failedLineIds, []);
  } finally {
    await relay.close();
  }
});

test("a fresh missing prefix is unmeasured while an initial explicit seek is deliberate", async () => {
  const fresh = fixture(),
    seeking = fixture();
  try {
    await fresh.relay.audio(frame(46, 4500, 4600));
    assert.deepEqual(fresh.relay.drain().failedLineIds, ["first", "gap"]);
    seeking.relay.seek(4500);
    await seeking.relay.audio(frame(46, 4500, 4600));
    assert.deepEqual(seeking.relay.drain().failedLineIds, []);
  } finally {
    await fresh.relay.close();
    await seeking.relay.close();
  }
});

test("an older snapshot does not invent prefix loss but detects later missing audio", async () => {
  const original = fixture();
  await original.relay.audio(frame(1, 0, 2000));
  const snapshot = original.snapshot();
  delete snapshot.lastAudioEndMs;
  await original.relay.close();
  const restored = fixture(snapshot);
  try {
    await restored.relay.audio(frame(2, 4500, 4600));
    assert.deepEqual(restored.relay.drain().failedLineIds, []);
    await restored.relay.audio(frame(3, 6300, 6400));
    assert.deepEqual(restored.relay.drain().failedLineIds, ["last"]);
  } finally {
    await restored.relay.close();
  }
});
