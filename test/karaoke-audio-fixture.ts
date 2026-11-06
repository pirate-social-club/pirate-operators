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
} from "../harness/karaoke-elevenlabs-simulator.ts";
import { encodeKaraokeBinaryFrame } from "../packages/karaoke/binary-codec.ts";
import type { Signed, Song, Ticket } from "../packages/protocol/index.ts";
import type { KaraokeResultBody } from "../packages/protocol/payments.ts";
import { chainTime, type Chain } from "./payments-fixture.ts";

let songs = 0;
export async function audioCommunity(
  evm: Chain,
  label: string,
  streams: SimulatedStream[],
  /** Null runs the operator without a provider credential. */
  elevenLabsApiKey: string | null = "simulated-elevenlabs-key",
) {
  const start = (await chainTime(evm)) + 1;
  const runtime = await karaokeAudioWorkers({
    rpcUrl: evm.rpcUrl,
    paymentToken: evm.paymentToken,
    paymentsContract: evm.paymentsContract,
    recordsContract: evm.recordsContract,
    now: start,
    cutoff: start + 100000,
    elevenLabsApiKey: elevenLabsApiKey ?? undefined,
    streams,
  });
  let now = start;
  const at = async (t: number) => {
    now = t;
    if (t > (await chainTime(evm))) {
      await evm.rpc("evm_setNextBlockTimestamp", [t]);
      await evm.rpc("evm_mine", []);
    }
    for (const role of roles) {
      const r = await post(runtime.mf, role, "/__clock", { now: t });
      assert.equal(r.status, 200, JSON.stringify(r.value));
    }
  };
  const attempt = async (index = 5) => {
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
    runtime,
    at,
    now: () => now,
    attempt,
    payAll,
    sing,
    result,
    state,
    simulator,
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
