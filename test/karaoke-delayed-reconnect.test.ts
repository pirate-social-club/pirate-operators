// The delayed reply is controlled, so runner speed cannot make it arrive early.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { startChain, stopChain, type Chain } from "./payments-fixture.ts";
import {
  audioCommunity,
  sungAudioWords,
  AUDIO_MANIFEST,
  AUDIO_LINES,
  finishAudioAttempt,
  storedAudioWords,
} from "./karaoke-audio-fixture.ts";

let evm: Chain;
before(async () => {
  evm = await startChain(19046);
});
after(async () => {
  await stopChain(evm);
});

test("delivered old audio is transcribed after authenticated learner reconnect before new audio", async () => {
  const c = await audioCommunity(evm, "held-transcript-rejoin", [
    {
      words: sungAudioWords(AUDIO_MANIFEST, AUDIO_LINES),
      holdCommits: true,
    },
  ]);
  try {
    const a = await c.attempt();
    await c.payAll(a);
    await c.sing(a.socket, a, 0, 4500);
    const delivered = await c.waitForProviderChunks(45);
    assert.equal(delivered.streams[0].chunks, 45);
    assert.equal(
      delivered.streams[0].heldCommits,
      1,
      await c.deliveryDiagnostics(a),
    );
    assert.equal(delivered.streams[0].emitted.length, 0);
    assert.deepEqual(await storedAudioWords(c, a), []);
    const rejoined = await c.reconnect(a);
    assert.equal(rejoined.ready.resumed, true);
    assert.equal(rejoined.ready.audioSequence, 45);
    assert.equal((await c.simulator()).streams[0].emitted.length, 0);
    // The provider is released only after the new authenticated ready packet.
    assert.equal((await c.releaseProviderCommits()).released, 1);
    const expected = AUDIO_MANIFEST.lines
      .flatMap((line) => line.words)
      .filter((word) => word.endMs <= 4500)
      .map((word) => word.text);
    let heard = await storedAudioWords(c, a);
    for (let i = 0; i < 30 && heard.length < expected.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      heard = await storedAudioWords(c, a);
    }
    assert.deepEqual(
      heard.map((word) => word.text),
      expected,
      await c.deliveryDiagnostics(a),
    );
    assert.equal(
      (await c.simulator()).streams[0].chunks,
      45,
      "No new audio was used to obtain old words",
    );
    await c.sing(rejoined, a, 4500, 22500);
    const result = await finishAudioAttempt(c, a, rejoined);
    assert.deepEqual(
      result.lines.map((line) => line.status),
      ["assessed", "assessed", "assessed", "assessed"],
      await c.deliveryDiagnostics(a),
    );
    assert.deepEqual(
      (await storedAudioWords(c, a)).map((word) => word.text),
      AUDIO_MANIFEST.lines.flatMap((line) =>
        line.words.map((word) => word.text),
      ),
    );
    assert.equal((await c.simulator()).minted, 1);
  } finally {
    await c.dispose();
  }
});
