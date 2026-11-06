import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeKaraokeBinaryFrame } from "../packages/karaoke/binary-codec.ts";
import {
  KaraokeOperatorAudioClient,
  KARAOKE_SUPERSEDED_CLOSE_CODE,
  type KaraokeOperatorSocket,
} from "../packages/karaoke/operator-audio-client.ts";

class FakeSocket implements KaraokeOperatorSocket {
  sent: (string | ArrayBuffer)[] = [];
  closed: number | null = null;
  private listeners: Record<string, ((event: any) => void)[]> = {};
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.closed = code;
  }
  addEventListener(type: string, listener: (event: any) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, event: unknown) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
  ready(
    attemptId = "0xattempt",
    context: { resumed?: boolean; audioSequence?: unknown } = {},
  ) {
    this.emit("message", {
      data: JSON.stringify({
        type: "ready",
        attemptId,
        resumed: false,
        ...context,
      }),
    });
  }
  frames(ticketId: string, attemptId = "0xattempt") {
    return this.sent
      .filter((d): d is ArrayBuffer => d instanceof ArrayBuffer)
      .map(
        (d) =>
          decodeKaraokeBinaryFrame(d, { sessionId: ticketId, attemptId })
            .frame!,
      );
  }
  controls() {
    return this.sent
      .filter((d): d is string => typeof d === "string")
      .map((d) => JSON.parse(d));
  }
}
const chunk = () => new ArrayBuffer(3200); // 100 ms of 16 kHz PCM16

function harness(
  extra: Partial<
    ConstructorParameters<typeof KaraokeOperatorAudioClient>[0]
  > = {},
) {
  const sockets: FakeSocket[] = [];
  const timers: { ms: number; run: () => void }[] = [];
  const events: string[] = [];
  const client = new KaraokeOperatorAudioClient({
    ticketId: "0xticket",
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimer: (run, ms) => timers.push({ ms, run }),
    suspendCapture: async () => {
      events.push("suspend");
    },
    resumeCapture: async () => {
      events.push("resume");
      client.setCaptureAnchor({
        captureMs: 10_000,
        songMs: 5_000,
        playbackRate: 1,
      });
    },
    onError: (error) => events.push(`error:${error.code}`),
    ...extra,
  });
  return { client, sockets, timers, events };
}

test("a scoring recovery reuses the ticket and cursor, rejects late old feedback and resumes without replay", async () => {
  const received: string[] = [];
  const { client, sockets, timers, events } = harness({
    onMessage: (m) => received.push(String(m.type)),
  });
  assert.equal(client.reconnect(), false);
  client.start();
  sockets[0].ready();
  client.setCaptureAnchor({ captureMs: 1000, songMs: 0, playbackRate: 1 });
  client.pushAudio(chunk(), 1100);
  assert.equal(client.reconnect(), true);
  assert.equal(client.getPhase(), "reconnecting");
  assert.equal(sockets[0].closed, 1000);
  sockets[0].emit("message", {
    data: JSON.stringify({ type: "old-feedback" }),
  });
  timers.find((t) => t.ms === 250)!.run();
  sockets[1].ready("0xattempt", { resumed: true, audioSequence: 1 });
  await new Promise((r) => setTimeout(r, 0));
  client.pushAudio(chunk(), 10100);
  assert.deepEqual(
    sockets[1].frames("0xticket").map((f) => f.sequence),
    [2],
  );
  assert.deepEqual(received, ["ready", "ready"]);
  assert.equal(events.filter((e) => e === "suspend").length, 1);
  assert.equal(events.filter((e) => e === "resume").length, 1);
  timers.find((t) => t.ms === 10000)!.run();
  assert.equal(
    client.getPhase(),
    "live",
    "a ready response cancels the recovery deadline",
  );
  client.close();
});

test("a scoring recovery with no ready response stops after its deadline and cannot reopen", () => {
  const { client, sockets, timers, events } = harness();
  client.start();
  sockets[0].ready();
  assert.equal(client.reconnect(), true);
  timers.find((t) => t.ms === 250)!.run();
  assert.equal(sockets.length, 2);
  timers.find((t) => t.ms === 10000)!.run();
  assert.equal(client.getPhase(), "aborted");
  assert.equal(sockets[1].closed, 1000);
  assert.ok(events.includes("error:karaoke_recovery_timeout"));
  assert.equal(client.reconnect(), false);
  timers.find((t) => t.ms === 250)!.run();
  assert.equal(sockets.length, 2);
});

test("closing still closes the wire when a phase observer throws", () => {
  const { client, sockets } = harness({
    onPhaseChange: (phase) => {
      if (phase === "closed") throw Error("observer_failed");
    },
  });
  client.start();
  sockets[0].ready();
  assert.throws(() => client.close(), /observer_failed/);
  assert.equal(sockets[0].closed, 1000);
});

test("audio is framed only while live and anchored, with mapped song ranges", () => {
  const { client, sockets } = harness();
  client.start();
  client.setCaptureAnchor({ captureMs: 1_000, songMs: 0, playbackRate: 1 });
  client.pushAudio(chunk(), 1_100); // not live yet: dropped
  sockets[0].ready();
  client.pushAudio(chunk(), 1_100, { songStartMs: 0, songEndMs: 100 });
  client.pushAudio(chunk(), 1_200);
  client.pushAudio(chunk(), 900); // before the anchor: dropped
  client.pushAudio(chunk(), 1_150); // regresses within the epoch: dropped
  client.clearCaptureAnchor();
  client.pushAudio(chunk(), 1_300); // unanchored: dropped
  const frames = sockets[0].frames("0xticket");
  assert.deepEqual(
    frames.map((f) => [
      f.sequence,
      f.chunkId,
      f.songStartMs,
      f.songEndMs,
      f.sampleRate,
    ]),
    [
      [1, 1, 0, 100, 16000],
      [2, 2, 100, 200, 16000],
    ],
  );
});

test("a dropped socket suspends capture once, reconnects with backoff, resumes on a fresh anchor and never replays audio", async () => {
  const { client, sockets, timers, events } = harness();
  client.start();
  sockets[0].ready();
  client.setCaptureAnchor({ captureMs: 1_000, songMs: 0, playbackRate: 1 });
  client.pushAudio(chunk(), 1_100);
  sockets[0].emit("close", { code: 1006 });
  assert.equal(client.getPhase(), "reconnecting");
  client.pushAudio(chunk(), 1_200); // during the gap: dropped, not queued
  assert.deepEqual(
    timers.map((t) => t.ms),
    [250],
  );
  timers.shift()!.run();
  sockets[1].emit("close", { code: 1006 }); // the first retry fails
  assert.deepEqual(
    timers.map((t) => t.ms),
    [500],
  );
  timers.shift()!.run();
  sockets[2].ready();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["suspend", "resume"]);
  client.pushAudio(chunk(), 10_100);
  assert.deepEqual(
    sockets[0].frames("0xticket").map((f) => f.sequence),
    [1],
  );
  assert.deepEqual(
    sockets[2]
      .frames("0xticket")
      .map((f) => [f.sequence, f.songStartMs, f.songEndMs]),
    [[2, 5_000, 5_100]],
  );
});

test("a fresh page continues the operator cursor and chunk identity without replaying audio", () => {
  const { client, sockets } = harness();
  client.start();
  sockets[0].ready("0xattempt", { resumed: true, audioSequence: 45 });
  client.setCaptureAnchor({ captureMs: 0, songMs: 4500, playbackRate: 1 });
  client.pushAudio(chunk(), 100);
  assert.deepEqual(
    sockets[0].frames("0xticket").map((f) => [f.sequence, f.chunkId]),
    [[46, 46]],
  );
  client.close();
});

test("an invalid or missing resumed cursor aborts before sending audio", () => {
  for (const audioSequence of [
    undefined,
    null,
    "45",
    -1,
    1.5,
    0xffff_ffff,
    0x1_0000_0000,
  ]) {
    const { client, sockets, events } = harness();
    client.start();
    sockets[0].ready("0xattempt", { resumed: true, audioSequence });
    client.setCaptureAnchor({ captureMs: 0, songMs: 4500, playbackRate: 1 });
    client.pushAudio(chunk(), 100);
    assert.equal(client.getPhase(), "aborted", String(audioSequence));
    assert.deepEqual(sockets[0].sent, []);
    assert.ok(events.includes("error:karaoke_audio_cursor_invalid"));
  }
});

test("an in-memory reconnect keeps its later sent cursor when the operator saw fewer frames", async () => {
  const { client, sockets, timers } = harness();
  client.start();
  sockets[0].ready();
  client.setCaptureAnchor({ captureMs: 0, songMs: 0, playbackRate: 1 });
  client.pushAudio(chunk(), 100);
  sockets[0].emit("close", { code: 1006 });
  timers.shift()!.run();
  sockets[1].ready("0xattempt", { resumed: true, audioSequence: 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.pushAudio(chunk(), 10100);
  assert.equal(sockets[1].frames("0xticket")[0].sequence, 2);
  client.close();
});

test("reconnects stop after five attempts, and a superseded socket never reconnects", () => {
  const exhausted = harness();
  exhausted.client.start();
  exhausted.sockets[0].ready();
  exhausted.sockets[0].emit("close", { code: 1006 });
  for (let i = 1; i <= 5; i++) {
    exhausted.timers.shift()!.run();
    exhausted.sockets[i].emit("close", { code: 1006 });
  }
  assert.equal(exhausted.client.getPhase(), "aborted");
  assert.ok(exhausted.events.includes("error:karaoke_reconnect_exhausted"));

  const superseded = harness();
  superseded.client.start();
  superseded.sockets[0].ready();
  superseded.sockets[0].emit("close", { code: KARAOKE_SUPERSEDED_CLOSE_CODE });
  assert.equal(superseded.client.getPhase(), "aborted");
  assert.equal(superseded.timers.length, 0);
  assert.ok(superseded.events.includes("error:karaoke_superseded"));
});

test("control frames are the operator's audio_pause, audio_seek and finish", () => {
  const { client, sockets } = harness();
  client.start();
  client.pause(10); // not live: not sent
  sockets[0].ready();
  client.pause(1234.4);
  client.seek(2500);
  client.finish();
  assert.deepEqual(sockets[0].controls(), [
    { type: "audio_pause", songMs: 1234 },
    { type: "audio_seek", songMs: 2500 },
    { type: "finish" },
  ]);
});
