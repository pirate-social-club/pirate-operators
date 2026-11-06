// One community, learner and song per test on the shared anvil chain, like
// test/payments-fixture.ts, but with the audio-enabled operator and a
// simulated ElevenLabs behind its outbound network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { accounts, roles } from "../harness/runtime.ts";
import { fixtureLyrics, fixtureManifest } from "../harness/karaoke-fixture.ts";
import {
  openAttempt,
  post,
  requestPurchase,
  type Attempt,
} from "../harness/karaoke-client.ts";
import { karaokeAudioWorkers } from "../harness/karaoke-audio-workers.ts";
import type {
  SimulatedStream,
  SimulatedStreamLog,
  SimulatedWord,
} from "../harness/karaoke-elevenlabs-simulator.ts";
import { encodeKaraokeBinaryFrame } from "../packages/karaoke/binary-codec.ts";
import type { KaraokeRelaySnapshot } from "../packages/karaoke/audio-relay.ts";
import type { Signed, Song, Ticket } from "../packages/protocol/index.ts";
import {
  PAYMENT_GRACE_S,
  songEndMs,
  type KaraokeResultBody,
  type KaraokeManifest,
} from "../packages/protocol/payments.ts";
import type { KaraokeRecognizedWord } from "../packages/scoring/scoring.ts";
import { chainTime, type Chain } from "./payments-fixture.ts";

let songs = 0;
export async function audioCommunity(
  evm: Chain,
  label: string,
  streams: SimulatedStream[],
  /** Null runs the operator without a provider credential. */
  elevenLabsApiKey: string | null = "simulated-elevenlabs-key",
  options: { serviceMode?: "internal" } = {},
) {
  const start = (await chainTime(evm)) + 1;
  const workerOptions = {
    rpcUrl: evm.rpcUrl,
    paymentToken: evm.paymentToken,
    paymentsContract: evm.paymentsContract,
    recordsContract: evm.recordsContract,
    now: start,
    cutoff: start + 100000,
    elevenLabsApiKey: elevenLabsApiKey ?? undefined,
    streams,
    ...options,
  };
  let runtime = await karaokeAudioWorkers(workerOptions);
  let now = start;
  const at = async (t: number) => {
    now = t;
    if (t > (await chainTime(evm))) {
      await evm.rpc("evm_setNextBlockTimestamp", [t]);
      await evm.rpc("evm_mine", []);
    }
    for (const role of roles) {
      const path =
        role === "operator" && options.serviceMode === "internal"
          ? "/__fixture/alarm"
          : "/__clock";
      const r = await post(runtime.mf, role, path, { now: t });
      assert.equal(r.status, 200, JSON.stringify(r.value));
    }
  };
  const attempt = async (
    index = 5,
    beforeConnect?: (ticket: Signed<Ticket>) => Promise<void>,
  ) => {
    const wallet = accounts[index];
    const challenge = await post<{ nonce: string; message: string }>(
      runtime.mf,
      "community",
      "/challenge",
      {
        wallet: wallet.address,
      },
    );
    const signature = await wallet.signMessage({
      message: challenge.value.message,
    });
    const session = (
      await post<{ token: string }>(runtime.mf, "community", "/session", {
        nonce: challenge.value.nonce,
        signature,
      })
    ).value.token;
    const song: Song = {
      communityId: "fixture-community",
      audio: `0x${readFileSync("fixtures/original-tone.mp3").toString("hex")}`,
      title: `${label} ${++songs}`,
      lyrics: fixtureLyrics,
      artwork: "original-cover-fixture-v1",
      original: true,
    };
    const manifest = fixtureManifest(song);
    const posted = await post<{ songHash: Hex }>(
      runtime.mf,
      "community",
      "/songs",
      { song, manifest },
      session,
    );
    assert.equal(posted.status, 200, JSON.stringify(posted.value));
    const issued = await post<Signed<Ticket>>(
      runtime.mf,
      "community",
      "/tickets",
      { songHash: posted.value.songHash, sessionKey: wallet.address },
      session,
    );
    assert.equal(issued.status, 200, JSON.stringify(issued.value));
    await beforeConnect?.(issued.value);
    const socket = (await openAttempt(
      runtime.mf,
      issued.value.body.ticketId,
      wallet,
    )) as Attempt;
    return {
      session,
      manifest,
      ticket: issued.value,
      socket,
      start: socket.ready.attemptStart!,
      wallet,
    };
  };
  type A = Awaited<ReturnType<typeof attempt>>;
  /** Pays every segment inside its window, as the payments tests do. */
  const payAll = async (a: A, socket: Attempt = a.socket) => {
    for (const segment of a.manifest.segments) {
      const opens =
        a.start.body.startedAt +
        Math.max(0, Math.ceil((segment.startMs - 15000) / 1000));
      if (opens > now) await at(opens);
      const signed = await requestPurchase(
        runtime.mf,
        a.session,
        a.ticket.body.ticketId,
        segment.segmentId,
        a.start,
      );
      assert.equal(signed.status, 200, JSON.stringify(signed.value));
      const answer = await socket.pay(signed.value);
      assert.equal(answer.type, "paid", JSON.stringify(answer));
    }
  };
  let sequence = 0;
  /** Sends 100 ms PCM16 frames covering [fromMs, toMs), or drops them to
   * simulate transport loss while retaining the client's sequence counter. */
  const sing = async (
    socket: Attempt,
    a: A,
    fromMs: number,
    toMs: number,
    options: { drop?: boolean } = {},
  ) => {
    for (let ms = fromMs; ms < toMs; ms += 100) {
      sequence += 1;
      if (!options.drop)
        socket.ws.send(
          encodeKaraokeBinaryFrame({
            protocolVersion: 1,
            sessionId: a.ticket.body.ticketId,
            attemptId: a.start.body.attemptId,
            sequence,
            type: "audio_chunk",
            chunkId: sequence,
            pcm16: new ArrayBuffer(3200),
            sampleRate: 16000,
            songStartMs: ms,
            songEndMs: ms + 100,
          }),
        );
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
  };
  const result = (ticketId: string) =>
    post<{ body: KaraokeResultBody; error?: string }>(
      runtime.mf,
      "operator",
      "/result",
      { ticketId },
    );
  const state = async (prefix: string) => {
    const all = await post<{ key: string; value: unknown }[]>(
      runtime.mf,
      "operator",
      "/__state",
      {},
    );
    return all.value.filter((r) => r.key.startsWith(prefix));
  };
  const simulator = async () => {
    const worker = await runtime.mf.getWorker("elevenlabs");
    const response = await worker.fetch(
      "http://simulator.localhost/__simulator/log",
    );
    return (await response.json()) as {
      minted: number;
      streams: SimulatedStreamLog[];
    };
  };
  return {
    get runtime() {
      return runtime;
    },
    at,
    now: () => now,
    attempt,
    payAll,
    sing,
    result,
    state,
    simulator,
    async restart() {
      const persist = runtime.persist;
      await runtime.mf.dispose();
      runtime = await karaokeAudioWorkers(workerOptions, persist);
    },
    async releaseProviderCommits() {
      const worker = await runtime.mf.getWorker("elevenlabs");
      const response = await worker.fetch(
        "http://simulator.localhost/__simulator/release-commits",
        { method: "POST" },
      );
      assert.equal(response.status, 200);
      return (await response.json()) as { released: number };
    },
    async deliveryDiagnostics(a: A) {
      const log = await simulator();
      const relay = (await state(`audioRelay:${a.ticket.body.ticketId}`))[0]
        ?.value as KaraokeRelaySnapshot | undefined;
      return JSON.stringify({
        minted: log.minted,
        streams: log.streams.map((stream) => ({
          chunks: stream.chunks,
          audioMs: stream.audioMs,
          commits: stream.commits,
          emittedWords: stream.emitted.length,
        })),
        relay: relay && {
          lastSequence: relay.lastSequence,
          lastAudioEndMs: relay.lastAudioEndMs,
          words: relay.words.length,
          failedLineIds: relay.failedLineIds,
          terminal: relay.terminal,
        },
      });
    },
    async waitForProviderChunks(count: number) {
      let log = await simulator();
      for (let i = 0; i < 100; i++) {
        if (
          log.streams.reduce((sum, stream) => sum + stream.chunks, 0) >= count
        )
          return log;
        await new Promise((resolve) => setTimeout(resolve, 100));
        log = await simulator();
      }
      throw Error("provider_audio_not_delivered:" + JSON.stringify(log));
    },
    reconnect: (a: A) =>
      openAttempt(
        runtime.mf,
        a.ticket.body.ticketId,
        a.wallet,
      ) as Promise<Attempt>,
    dispose: () => runtime.mf.dispose(),
  };
}

type C = Awaited<ReturnType<typeof audioCommunity>>;
type A = Awaited<ReturnType<C["attempt"]>>;

/** The fixture's reference words for the chosen lines, shifted onto a stream clock. */
export const sungAudioWords = (
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
export const AUDIO_MANIFEST = fixtureManifest({
  communityId: "fixture-community",
  audio: "0x00",
  title: "timing",
  lyrics: fixtureLyrics,
  artwork: "original-cover-fixture-v1",
  original: true,
});
export const AUDIO_LINES = ["line-01", "line-02", "line-03", "line-04"];

export async function finishAudioAttempt(c: C, a: A, socket = a.socket) {
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
export const storedAudioWords = async (c: C, a: A) =>
  ((await c.state(`words:${a.ticket.body.ticketId}`))[0]?.value ??
    []) as KaraokeRecognizedWord[];
