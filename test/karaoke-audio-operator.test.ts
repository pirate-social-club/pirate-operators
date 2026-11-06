// The actual operator Karaoke socket with live audio: binary frames in, the
// operator's own ElevenLabs realtime connection out, routed to a simulated
// provider. Recognized words reach the scorer only through that provider path.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_GRACE_S,
  RECONNECT_WINDOW_S,
  songEndMs,
  type KaraokeManifest,
} from "../packages/protocol/payments.ts";
import type { KaraokeRecognizedWord } from "../packages/scoring/scoring.ts";
import type { SimulatedWord } from "../harness/karaoke-elevenlabs-simulator.ts";
import { fixtureLyrics, fixtureManifest } from "../harness/karaoke-fixture.ts";
import { encodeKaraokeBinaryFrame } from "../packages/karaoke/binary-codec.ts";
import { startChain, stopChain, type Chain } from "./payments-fixture.ts";
import { audioCommunity } from "./karaoke-audio-fixture.ts";

let evm: Chain;
before(async () => {
  evm = await startChain(19045);
});
after(async () => {
  await stopChain(evm);
});

type C = Awaited<ReturnType<typeof audioCommunity>>;
type A = Awaited<ReturnType<C["attempt"]>>;

/** The fixture's reference words for the chosen lines, shifted onto a stream clock. */
const sung = (
  manifest: KaraokeManifest,
  lineIds: string[],
  streamOffsetMs = 0,
  text?: string,
): SimulatedWord[] =>
  manifest.lines
    .filter((line) => lineIds.includes(line.lineId))
    .flatMap((line) =>
      line.words.map((word) => ({
        text: text ?? word.text,
        start: (word.startMs - streamOffsetMs) / 1000,
        end: (word.endMs - streamOffsetMs) / 1000,
      })),
    );
// The fixture manifest's line and word timing is fixed; the song only sets its hash.
const manifest = fixtureManifest({
  communityId: "fixture-community",
  audio: "0x00",
  title: "timing",
  lyrics: fixtureLyrics,
  artwork: "original-cover-fixture-v1",
  original: true,
});
const ALL = ["line-01", "line-02", "line-03", "line-04"];

async function finish(c: C, a: A, socket = a.socket) {
  await c.at(
    a.start.body.startedAt + Math.ceil(songEndMs(a.manifest) / 1000) - 1,
  );
  socket.send({ type: "finish" });
  // Finishing waits for the provider's last commit, so poll until the take ends.
  const ticketId = a.ticket.body.ticketId;
  for (let i = 0; i < 100; i++) {
    const [row] = await c.state(`attempt:${ticketId}`);
    if ((row?.value as { ended?: unknown } | undefined)?.ended) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await c.at(c.now() + PAYMENT_GRACE_S);
  const result = await c.result(ticketId);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return result.value.body;
}
const storedWords = async (c: C, a: A) =>
  ((await c.state(`words:${a.ticket.body.ticketId}`))[0]?.value ??
    []) as KaraokeRecognizedWord[];

test("provider-recognized words reach the scorer at their song times", async () => {
  const c = await audioCommunity(evm, "audio", [
    { words: sung(manifest, ALL) },
  ]);
  try {
    const a = await c.attempt();
    await c.payAll(a);
    await c.sing(a.socket, a, 0, 22500);
    const result = await finish(c, a);
    assert.deepEqual(
      result.lines.map((l) => l.status),
      ["assessed", "assessed", "assessed", "assessed"],
    );
    const words = await storedWords(c, a);
    const expected = a.manifest.lines.flatMap((line) => line.words);
    assert.deepEqual(
      words.map((w) => w.text),
      expected.map((w) => w.text),
    );
    words.forEach((word, i) => {
      assert.ok(
        Math.abs(word.startMs - expected[i].startMs) <= 1,
        JSON.stringify([word, expected[i]]),
      );
      assert.ok(
        Math.abs(word.endMs - expected[i].endMs) <= 1,
        JSON.stringify([word, expected[i]]),
      );
    });
    const log = await c.simulator();
    assert.equal(log.minted, 1);
    assert.equal(log.streams.length, 1);
    assert.deepEqual(
      { ...log.streams[0].params, token: undefined },
      {
        model_id: "scribe_v2_realtime",
        audio_format: "pcm_16000",
        include_timestamps: "true",
        commit_strategy: "manual",
        enable_logging: "true",
        token: undefined,
      },
    );
    assert.equal(log.streams[0].chunks, 225);
    assert.ok(log.streams[0].commits >= 4, String(log.streams[0].commits));
  } finally {
    await c.dispose();
  }
});

test("learners cannot supply recognized words or failure marks", async () => {
  const c = await audioCommunity(evm, "refuse", [{ words: [] }]);
  try {
    const a = await c.attempt();
    a.socket.send({
      type: "words",
      words: [{ text: "sing", startMs: 200, endMs: 600 }],
    });
    assert.deepEqual(await a.socket.next(), {
      type: "error",
      code: "operator_transcription_only",
    });
    a.socket.send({ type: "provider_failed", lineIds: ["line-01"] });
    assert.deepEqual(await a.socket.next(), {
      type: "error",
      code: "operator_transcription_only",
    });
    assert.deepEqual(await storedWords(c, a), []);
  } finally {
    await c.dispose();
  }
});

test("a dropped provider stream reconnects and replays audio; its unacknowledged commit is unmeasured", async () => {
  const c = await audioCommunity(evm, "drop", [
    {
      words: sung(manifest, ["line-01"]),
      answerCommits: 1,
      dropAfterChunks: 50,
    },
    // The second stream starts where the replayed audio does, near song 5 s.
    { words: sung(manifest, ["line-03", "line-04"], 5000) },
  ]);
  try {
    const a = await c.attempt();
    await c.payAll(a);
    await c.sing(a.socket, a, 0, 22500);
    const result = await finish(c, a);
    assert.deepEqual(
      result.lines.map((l) => l.status),
      ["assessed", "unmeasured", "assessed", "assessed"],
    );
    const log = await c.simulator();
    assert.equal(log.minted, 2);
    assert.equal(log.streams.length, 2);
    assert.ok(log.streams[1].chunks > 150, String(log.streams[1].chunks));
  } finally {
    await c.dispose();
  }
});

test("a terminal provider error leaves unmeasured lines unmeasured, never wrong", async () => {
  const c = await audioCommunity(evm, "terminal", [
    {
      words: sung(manifest, ["line-01"]),
      terminalAfterChunks: 30,
      terminalCode: "quota_exceeded",
    },
  ]);
  try {
    const a = await c.attempt();
    await c.payAll(a);
    await c.sing(a.socket, a, 0, 22500);
    const result = await finish(c, a);
    assert.deepEqual(
      result.lines.map((l) => l.status),
      ["assessed", "unmeasured", "unmeasured", "unmeasured"],
    );
    assert.equal((await c.simulator()).minted, 1);
  } finally {
    await c.dispose();
  }
});

test("an operator without a speech credential measures nothing and calls no provider", async () => {
  const c = await audioCommunity(
    evm,
    "unconfigured",
    [{ words: sung(manifest, ALL) }],
    null,
  );
  try {
    const a = await c.attempt();
    await c.payAll(a);
    await c.sing(a.socket, a, 0, 22500);
    const result = await finish(c, a);
    assert.deepEqual(
      result.lines.map((l) => l.status),
      ["unmeasured", "unmeasured", "unmeasured", "unmeasured"],
    );
    assert.equal((await c.simulator()).minted, 0);
  } finally {
    await c.dispose();
  }
});

test("a seek drops words after the seek point and re-measures the replayed lines", async () => {
  // First pass: line 1 right, lines 2-3 wrong. The seek back to 2.5 s comes at
  // stream 7 s; the second pass sings lines 2-4 right.
  const secondPass = 7000 - 2500;
  const c = await audioCommunity(evm, "seek", [
    {
      words: [
        ...sung(manifest, ["line-01"]),
        ...sung(manifest, ["line-02", "line-03"], 0, "mumble"),
        ...sung(manifest, ["line-02", "line-03", "line-04"], -secondPass),
      ],
    },
  ]);
  try {
    const a = await c.attempt();
    await c.payAll(a);
    await c.sing(a.socket, a, 0, 7000);
    a.socket.send({ type: "audio_seek", songMs: 2500 });
    await c.sing(a.socket, a, 2500, 22500);
    const result = await finish(c, a);
    assert.deepEqual(
      result.lines.map((l) => l.status),
      ["assessed", "assessed", "assessed", "assessed"],
    );
    const words = await storedWords(c, a);
    assert.ok(
      !words.some((w) => w.text === "mumble"),
      JSON.stringify(words.map((w) => w.text)),
    );
    assert.deepEqual(
      words.map((w) => w.text),
      manifest.lines.flatMap((l) => l.words.map((w) => w.text)),
    );
    // The relay drops the same words, so its retained limit counts only these.
    const [snapshot] = await c.state(`audioRelay:${a.ticket.body.ticketId}`);
    assert.deepEqual(
      (snapshot?.value as { words: KaraokeRecognizedWord[] }).words.map(
        (w) => w.text,
      ),
      words.map((w) => w.text),
    );
  } finally {
    await c.dispose();
  }
});

test("a learner reconnect continues the same provider stream; regressed audio is refused", async () => {
  const c = await audioCommunity(evm, "rejoin", [
    { words: sung(manifest, ALL) },
  ]);
  try {
    const a = await c.attempt();
    await c.payAll(a);
    await c.sing(a.socket, a, 0, 4500);
    const rejoined = await c.reconnect(a);
    assert.equal(rejoined.ready.resumed, true);
    await c.sing(rejoined, a, 4500, 22500);
    rejoined.ws.send(
      encodeKaraokeBinaryFrame({
        protocolVersion: 1,
        sessionId: a.ticket.body.ticketId,
        attemptId: a.start.body.attemptId,
        sequence: 1,
        type: "audio_chunk",
        chunkId: 1,
        pcm16: new ArrayBuffer(3200),
        sampleRate: 16000,
        songStartMs: 0,
        songEndMs: 100,
      }),
    );
    assert.deepEqual(await rejoined.next(), {
      type: "error",
      code: "sequence_out_of_order",
    });
    const result = await finish(c, a, rejoined);
    assert.deepEqual(
      result.lines.map((l) => l.status),
      ["assessed", "assessed", "assessed", "assessed"],
    );
    assert.equal((await c.simulator()).minted, 1);
  } finally {
    await c.dispose();
  }
});

test("commits the provider never acknowledges time out as unmeasured lines", async () => {
  const c = await audioCommunity(evm, "silent-provider", [
    { words: sung(manifest, ALL), ignoreCommits: true },
  ]);
  try {
    const a = await c.attempt();
    await c.payAll(a);
    await c.sing(a.socket, a, 0, 22500);
    const result = await finish(c, a);
    assert.deepEqual(
      result.lines.map((l) => l.status),
      ["unmeasured", "unmeasured", "unmeasured", "unmeasured"],
    );
    assert.deepEqual(await storedWords(c, a), []);
  } finally {
    await c.dispose();
  }
});

test("words count when the song-end timer ends the take before the learner finishes", async () => {
  // In real time the operator's timer ends the take at the song's end, often
  // during the instrumental's outro, before the learner's finish arrives.
  const c = await audioCommunity(evm, "timer-first", [
    { words: sung(manifest, ALL) },
  ]);
  try {
    const a = await c.attempt();
    await c.payAll(a);
    // Audio stops after the last word but before the last line's end, so that
    // line is committed only by the learner's finish, after the timer.
    await c.sing(a.socket, a, 0, 21800);
    const ticketId = a.ticket.body.ticketId,
      ended = async () =>
        (
          (await c.state(`attempt:${ticketId}`))[0]?.value as {
            ended?: { status: string } | null;
          }
        ).ended;
    // Earlier lines reached the scorer while the take was still being sung.
    assert.ok((await storedWords(c, a)).length > 0);
    await c.at(
      a.start.body.startedAt + Math.ceil(songEndMs(a.manifest) / 1000) + 1,
    );
    assert.equal((await ended())?.status, "completed");
    a.socket.send({ type: "finish" });
    const expected = a.manifest.lines.flatMap((line) => line.words);
    for (let i = 0; i < 100; i++) {
      if ((await storedWords(c, a)).length === expected.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await c.at(c.now() + PAYMENT_GRACE_S);
    const result = await c.result(ticketId);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.deepEqual(
      result.value.body.lines.map((l) => l.status),
      ["assessed", "assessed", "assessed", "assessed"],
    );
    assert.deepEqual(
      (await storedWords(c, a)).map((w) => w.text),
      expected.map((w) => w.text),
    );
  } finally {
    await c.dispose();
  }
});

test("a seek after the provider gave up leaves its lines unmeasured, never silent", async () => {
  // Without a credential the relay gives up on every line at the first frame.
  const c = await audioCommunity(
    evm,
    "gave-up-seek",
    [{ words: sung(manifest, ALL) }],
    null,
  );
  try {
    const a = await c.attempt();
    await c.payAll(a);
    await c.sing(a.socket, a, 0, 3000);
    a.socket.send({ type: "audio_seek", songMs: 0 });
    await c.sing(a.socket, a, 0, 22500);
    const result = await finish(c, a);
    assert.deepEqual(
      result.lines.map((l) => l.status),
      ["unmeasured", "unmeasured", "unmeasured", "unmeasured"],
    );
  } finally {
    await c.dispose();
  }
});

test("a transcript that returns after the learner's socket closed still counts", async () => {
  // The provider answers each commit 1.5 s late; the learner leaves at once.
  const c = await audioCommunity(evm, "late-transcript", [
    { words: sung(manifest, ALL), commitDelayMs: 1500 },
  ]);
  try {
    const a = await c.attempt();
    await c.payAll(a);
    const leftAt = c.now();
    await c.sing(a.socket, a, 0, 4500);
    a.socket.close();
    const heard = a.manifest.lines
      .filter((l) => l.lineId === "line-01" || l.lineId === "line-02")
      .flatMap((l) => l.words.map((w) => w.text));
    for (let i = 0; i < 60; i++) {
      if ((await storedWords(c, a)).length >= heard.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(
      (await storedWords(c, a)).map((w) => w.text),
      heard,
    );
    // The learner never returns: the take ends after the reconnect window.
    await c.at(leftAt + RECONNECT_WINDOW_S + 1);
    await c.at(c.now() + PAYMENT_GRACE_S);
    const result = await c.result(a.ticket.body.ticketId);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.equal(result.value.body.status, "abandoned");
    assert.deepEqual(
      result.value.body.lines.map((l) => l.status),
      ["assessed", "assessed", "unattempted", "unattempted"],
    );
  } finally {
    await c.dispose();
  }
});
