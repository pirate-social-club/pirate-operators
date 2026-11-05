import assert from "node:assert/strict";
import { test } from "node:test";
import { createKaraokeCaptureController } from "../packages/karaoke/capture-controller.ts";
import type { KaraokeOperatorPhase } from "../packages/karaoke/operator-audio-client.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { micFails?: boolean } = {}) {
  const log: string[] = [];
  let clockMs = 1_000;
  let songMs = 0;
  let onChunk: ((pcm16: ArrayBuffer, capturedAtMs: number) => void) | null =
    null;
  let hooks:
    | Parameters<
        Parameters<typeof createKaraokeCaptureController>[0]["createClient"]
      >[0]
    | null = null;
  let phase: KaraokeOperatorPhase = "idle";
  const pushed: { songStartMs: number; songEndMs: number }[] = [];
  const controller = createKaraokeCaptureController({
    deferCaptureUntilPlaying: true,
    getPlaybackPosition: () => ({ songMs, playbackRate: 1 }),
    createCaptureEngine: (handlers) => {
      onChunk = handlers.onChunk;
      return {
        captureClockMs: () => clockMs,
        start: async () => {
          log.push("mic");
          if (options.micFails)
            throw Object.assign(new Error("denied"), {
              code: "permission_denied",
            });
        },
        activate: async () => log.push("activate"),
        deactivateAndFlush: async () => {
          log.push("flush");
          // The flush delivers the capture tail while the anchor is still set.
          onChunk?.(new ArrayBuffer(3200), clockMs);
        },
        stop: async () => {
          log.push("stop");
        },
      };
    },
    createClient: (clientHooks) => {
      hooks = clientHooks;
      log.push("client");
      return {
        start: () => {
          phase = "connecting";
        },
        getPhase: () => phase,
        pushAudio: (_pcm, _at, range) => {
          if (range) pushed.push(range);
          log.push("audio");
        },
        pause: (ms) => log.push(`pause:${ms}`),
        seek: (ms) => log.push(`seek:${ms}`),
        finish: () => log.push("finish"),
        close: () => log.push("close"),
        setCaptureAnchor: (anchor) => log.push(`anchor:${anchor.songMs}`),
        clearCaptureAnchor: () => log.push("clear"),
      };
    },
  });
  const goLive = () => {
    phase = "live";
    hooks!.onPhaseChange!("live");
  };
  const play = (at: number) => {
    songMs = at;
    controller.notePlay(at);
  };
  const advance = (ms: number) => {
    clockMs += ms;
    songMs += ms;
    controller.noteTime(songMs);
  };
  const chunk = () => onChunk?.(new ArrayBuffer(3200), clockMs);
  return {
    controller,
    log,
    goLive,
    play,
    advance,
    chunk,
    pushed,
    setSong: (ms: number) => (songMs = ms),
  };
}

test("the microphone comes first; a refusal opens no operator socket", async () => {
  const h = harness({ micFails: true });
  await h.controller.start(0);
  assert.deepEqual(h.log, ["mic", "stop"]);
  assert.equal(h.controller.getState().status, "error");
  assert.equal(h.controller.getState().micError?.code, "permission_denied");
});

test("initial activation waits for both a live socket and playback, then maps chunks to song time", async () => {
  const h = harness();
  await h.controller.start(0);
  h.goLive();
  await tick();
  assert.ok(!h.log.includes("activate"));
  h.play(0);
  await tick();
  assert.deepEqual(h.log.slice(-2), ["anchor:0", "activate"]);
  h.advance(100);
  h.chunk();
  h.advance(100);
  h.chunk();
  assert.deepEqual(h.pushed, [
    { songStartMs: 0, songEndMs: 100 },
    { songStartMs: 100, songEndMs: 200 },
  ]);
});

test("a pause flushes the capture tail before telling the operator", async () => {
  const h = harness();
  await h.controller.start(0);
  h.goLive();
  h.play(0);
  await tick();
  h.advance(300);
  await h.controller.notePause(300);
  const tail = h.log.slice(h.log.indexOf("flush"));
  assert.deepEqual(tail, ["flush", "audio", "clear", "pause:300"]);
});

test("a seek while playing starts a new capture epoch and announces the seek after the flush", async () => {
  const h = harness();
  await h.controller.start(0);
  h.goLive();
  h.play(0);
  await tick();
  h.advance(5_000);
  h.setSong(2_500);
  h.controller.noteSeek(2_500);
  await tick();
  await tick();
  const tail = h.log.slice(h.log.indexOf("flush"));
  assert.deepEqual(tail, [
    "flush",
    "audio",
    "clear",
    "seek:2500",
    "anchor:2500",
    "activate",
  ]);
});

test("finish flushes, releases the microphone and then finishes on the open socket", async () => {
  const h = harness();
  await h.controller.start(0);
  h.goLive();
  h.play(0);
  await tick();
  h.advance(1_000);
  await h.controller.noteFinish(1_000);
  const tail = h.log.slice(h.log.indexOf("flush"));
  assert.deepEqual(tail, ["flush", "audio", "clear", "stop", "finish"]);
  assert.equal(h.controller.getState().status, "finishing");
});

test("a chunk the playback clock cannot map aborts the take", async () => {
  const h = harness();
  await h.controller.start(0);
  h.goLive();
  h.play(0);
  await tick();
  // A chunk far past the last clock observation cannot be mapped.
  h.chunk();
  const state = h.controller.getState();
  assert.equal(state.micError?.code, "karaoke_clock_unavailable");
  assert.ok(h.log.includes("stop"));
});
