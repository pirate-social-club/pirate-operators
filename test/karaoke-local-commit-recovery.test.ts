import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "viem";
import { KaraokeAudioRelay, type KaraokeRelaySnapshot } from "../packages/karaoke/audio-relay.ts";
import { localKaraokeAdapter } from "../services/karaoke-local-recognition.ts";

test("a failed local commit is unmeasured and a subsequent original window is scored", { timeout: 4000 }, async t => {
  const model = sha256("0x1234");
  const lines = [{ lineId: "first", startMs: 0, endMs: 1000 }, { lineId: "second", startMs: 1000, endMs: 2000 }];
  let result: KaraokeRelaySnapshot | undefined;
  let calls = 0;
  const port = { async fetch(_url: string, init: { body: Uint8Array }) {
    calls++;
    if (calls === 1) return new Response(null, { status: 504 });
    return Response.json({
      schema: "pirate.local-karaoke-recognition/1", modelSha256: model,
      pcmSha256: sha256(init.body), sampleCount: init.body.byteLength / 2,
      timing: "whisper-token-timestamps",
      words: [{ text: "again", startMs: 120, endMs: 600, confidence: 0.9 }],
    });
  } } as unknown as Fetcher;
  const relay = new KaraokeAudioRelay({
    sessionId: "ticket", attemptId: "attempt", lines,
    createAdapter: () => localKaraokeAdapter(port, model),
    persist: snapshot => { result = snapshot; },
  });
  t.after(() => relay.close());
  const frame = (sequence: number, songStartMs: number) => ({
    protocolVersion: 1 as const, type: "audio_chunk" as const, sessionId: "ticket",
    attemptId: "attempt", sequence, chunkId: sequence, sampleRate: 16000 as const,
    songStartMs, songEndMs: songStartMs + 1000, pcm16: new ArrayBuffer(32000),
  });
  async function reached(ms: number) {
    for (let i = 0; i < 100 && (result?.resolvedThroughMs ?? 0) < ms; i++) await delay(5);
    assert.equal(result?.resolvedThroughMs, ms);
  }
  await relay.audio(frame(1, 0));
  await reached(1000);
  assert.equal(result?.terminal, null);
  assert.deepEqual(result?.failedLineIds, ["first"]);
  assert.deepEqual(result?.words, []);
  await relay.audio(frame(2, 1000));
  await reached(2000);
  assert.equal(calls, 2);
  const observed = relay.drain();
  assert.deepEqual(observed.failedLineIds, ["first"]);
  assert.deepEqual(observed.words.map(w => [w.text, w.startMs, w.endMs]), [["again", 1120, 1600]]);
  t.diagnostic(JSON.stringify({ calls, failure: result?.lastLocalFailure, observed }));
});
