import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "viem";
import { localKaraokeAdapter } from "../services/karaoke-local-recognition.ts";
import type { KaraokeStreamingSttAdapter } from "../packages/karaoke/stt-adapter.ts";

test("the worker accepts only fixed bridge outcomes and keeps identity mismatch terminal", { timeout: 4000 }, async t => {
  const model = sha256("0x1234");
  const cases = [
    { status: 503, header: "token_timing", expected: ["commit", "token_timing", 100] },
    { status: 503, header: "untrusted input", expected: ["commit", "child_unavailable", 100] },
    { status: 503, header: "model_changed", expected: ["commit", "child_unavailable", 100] },
    { status: 409, header: "model_changed", expected: ["terminal", "local_recognition_binding_changed"] },
  ] as const;
  for (const entry of cases) {
    const port = { async fetch() {
      return new Response(null, {
        status: entry.status, headers: { "x-pirate-karaoke-native-failure": entry.header },
      });
    } } as unknown as Fetcher;
    const adapter = localKaraokeAdapter(port, model);
    t.after(() => adapter.close());
    const { promise, resolve } = Promise.withResolvers<unknown[]>();
    const callbacks: Parameters<KaraokeStreamingSttAdapter["start"]>[0] = {
      sessionId: "session", attemptId: "attempt", initialSequence: 0,
      async onMessage() { resolve(["unexpected word event"]); },
      async onLocalCommitUnmeasured(failure) { resolve(["commit", failure.outcome, failure.pcmMs]); },
      onTerminalError(code) { resolve(["terminal", code]); },
    };
    await adapter.start(callbacks);
    await adapter.sendPcm16({
      protocolVersion: 1, type: "audio_chunk", sessionId: "session", attemptId: "attempt",
      sequence: 1, chunkId: 1, sampleRate: 16000, songStartMs: 0, songEndMs: 100,
      pcm16: new ArrayBuffer(3200),
    });
    assert.ok(await adapter.commit());
    assert.deepEqual(await promise, entry.expected);
    await adapter.close();
  }
});
