import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "viem";
import { digest, type Ticket } from "../packages/protocol/index.ts";
import { fixtureManifest } from "../harness/karaoke-fixture.ts";
import { KaraokeAudioRelay } from "../packages/karaoke/audio-relay.ts";
import { localKaraokeAdapter } from "../services/karaoke-local-recognition.ts";
import { beginPrivateKaraokeDrain, completePrivateKaraokeDrain, settle } from "../services/karaoke.ts";
import type { Env, Store } from "../services/runtime.ts";
import type { Attempt } from "../services/karaoke-result.ts";
import { speechRepairFixture } from "./karaoke-admission-repair1-fixture.ts";

test("two original delayed native-adapter commits precede private closure and keep the EOS cutoff", { timeout: 4000 }, async t => {
  const f = speechRepairFixture();
  t.after(f.close);
  const model = sha256("0x1234");
  const ticket = {
    ticketId: digest("finite take"), privateProfileHash: digest("private"),
    participant: "0x" + "ab".repeat(20), maxDurationMs: 42000,
    expiresAt: f.store.now() + 120,
  } as Ticket;
  const manifest = fixtureManifest({ communityId: f.policy.communityId, title: "Foundation" } as Parameters<typeof fixtureManifest>[0]);
  ticket.manifestSha256 = digest(manifest);
  const id = ticket.ticketId;
  const startedAt = f.store.now();
  const store = f.store as unknown as Store;
  const env = { SERVICE_MODE: "internal" } as Env;
  store.set("ticket:" + id, { body: ticket });
  store.set("manifest:" + ticket.manifestSha256, manifest);
  store.set("attempt:" + id, {
    ticketId: id, attemptId: digest(id), generation: 1, startedAt,
    connected: true, disconnectedAt: null, lastAudioAt: null, failedLineIds: [],
    ended: null, closing: null, finalized: false,
  } satisfies Attempt);

  const pending: (() => void)[] = [];
  const port = { fetch(_url: string, init: { body: Uint8Array }) {
    const pcm = init.body;
    return new Promise<Response>(resolve => pending.push(() => resolve(Response.json({
      schema: "pirate.local-karaoke-recognition/1", modelSha256: model,
      pcmSha256: sha256(pcm), sampleCount: pcm.byteLength / 2, timing: "whisper-token-timestamps",
      words: [{ text: "again", startMs: 20, endMs: 60, confidence: 0.8 }],
    }))));
  }} as unknown as Fetcher;
  const relay = new KaraokeAudioRelay({
    sessionId: id, attemptId: digest(id), lines: manifest.lines,
    createAdapter: () => localKaraokeAdapter(port, model),
    commitAckTimeoutMs: 15000,
    persist: snapshot => store.set("audioRelay:" + id, snapshot),
  });
  t.after(() => relay.close());
  const frame = (sequence: number, songStartMs: number, songEndMs: number) => ({
    protocolVersion: 1 as const, type: "audio_chunk" as const, sessionId: id,
    attemptId: digest(id), sequence, chunkId: sequence, sampleRate: 16000 as const,
    songStartMs, songEndMs, pcm16: new ArrayBuffer((songEndMs - songStartMs) * 32),
  });
  async function launched(count: number) {
    for (let i = 0; i < 150 && pending.length !== count; i++) await delay(2);
    assert.equal(pending.length, count);
  }
  await relay.audio(frame(1, 0, 2000));
  await launched(1);
  await relay.audio(frame(2, 2000, 4500));
  f.advance(5);
  const originalCutoff = f.store.now();
  assert.ok(beginPrivateKaraokeDrain(store, env, id, 1));
  const flushing = relay.finish();
  f.advance(9);
  assert.equal(settle(store, env, id)?.closing, null);
  pending[0]!();
  await launched(2);
  f.advance(9);
  assert.equal(settle(store, env, id)?.closing, null, "old ten-second closure would discard final originals");
  pending[1]!();
  await flushing;
  const committed = relay.drain();
  assert.equal(committed.words.length, 2);
  assert.equal(completePrivateKaraokeDrain(store, env, id, 1), true);
  const attempt = settle(store, env, id);
  assert.equal(attempt?.ended?.performanceEndedAt, originalCutoff);
  assert.deepEqual(attempt?.closing, { block: null });
  t.diagnostic(JSON.stringify({ originalCutoff, syntheticClockDelayS: 18, independentCommits: 2,
    acceptedWordSpans: committed.words.map(w => [w.startMs, w.endMs]) }));
});
