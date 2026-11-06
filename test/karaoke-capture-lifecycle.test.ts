// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-capture-lifecycle.test.ts; only imports changed.
import { describe, expect, test } from "./karaoke-expect.ts";

import {
  createKaraokeCaptureLifecycle,
  type CaptureAnchorSink,
  type CaptureEngineLike,
} from "../packages/karaoke/capture-lifecycle.ts";

interface FakeCapture extends CaptureEngineLike {
  clockMs: number;
}

function harness(songMs = 0, playbackRate = 1) {
  const events: string[] = [];
  const anchors: { captureMs: number; songMs: number; playbackRate: number }[] = [];
  const song = { value: songMs };
  const rate = { value: playbackRate };

  const capture: FakeCapture = {
    clockMs: 7_000,
    activate: async () => { events.push("activate"); },
    captureClockMs: () => capture.clockMs,
    deactivateAndFlush: async () => { events.push("deactivate"); },
    stop: async () => { events.push("stop"); },
  };

  const client: CaptureAnchorSink = {
    clearCaptureAnchor: () => { events.push("clearAnchor"); },
    setCaptureAnchor: (anchor) => {
      events.push("setAnchor");
      anchors.push(anchor);
    },
  };

  const lifecycle = createKaraokeCaptureLifecycle({
    capture,
    getPlaybackRate: () => rate.value,
    getSongMs: () => song.value,
    onError: (e) => events.push(`error:${e.code}`),
  });

  return { anchors, capture, client, events, lifecycle, rate, song };
}

describe("createKaraokeCaptureLifecycle", () => {
  test("resume anchors at the live capture clock + current song/rate, THEN activates", async () => {
    const h = harness(0, 1);
    h.lifecycle.attachClient(h.client);
    h.capture.clockMs = 7_500;
    h.song.value = 12_000;
    h.rate.value = 1.5;
    await h.lifecycle.resumeCapture();
    expect(h.events).toEqual(["setAnchor", "activate"]); // anchor before activate
    expect(h.anchors[0]).toEqual({ captureMs: 7_500, playbackRate: 1.5, songMs: 12_000 });
  });

  test("initial activation uses the same anchor-then-activate ordering", async () => {
    const h = harness(0, 1);
    h.lifecycle.attachClient(h.client);
    h.song.value = 0;
    await h.lifecycle.activateInitial();
    expect(h.events).toEqual(["setAnchor", "activate"]);
    expect(h.anchors[0]!.songMs).toBe(0);
  });

  test("suspend deactivates + flushes, THEN clears the anchor (never anchors at pause)", async () => {
    const h = harness();
    h.lifecycle.attachClient(h.client);
    await h.lifecycle.suspendCapture();
    expect(h.events).toEqual(["deactivate", "clearAnchor"]);
  });

  test("teardown stops the engine", async () => {
    const h = harness();
    h.lifecycle.attachClient(h.client);
    await h.lifecycle.teardownCapture();
    expect(h.events).toEqual(["stop"]);
  });

  test("resume before attach reports an error and does not activate", async () => {
    const h = harness();
    await h.lifecycle.resumeCapture(); // no client attached
    expect(h.events).toEqual(["error:karaoke_capture_not_attached"]);
  });

  test("a full reconnect cycle: suspend then resume re-anchors with a fresh capture clock", async () => {
    const h = harness();
    h.lifecycle.attachClient(h.client);
    await h.lifecycle.suspendCapture();
    h.capture.clockMs = 9_000; // capture clock advanced during the gap
    h.song.value = 20_000;
    await h.lifecycle.resumeCapture();
    expect(h.events).toEqual(["deactivate", "clearAnchor", "setAnchor", "activate"]);
    expect(h.anchors[0]).toEqual({ captureMs: 9_000, playbackRate: 1, songMs: 20_000 });
  });
  test("teardown is idempotent and late reconnects cannot reacquire capture", async () => {
    const h = harness();
    h.lifecycle.attachClient(h.client);
    await h.lifecycle.activateInitial();
    await Promise.all([h.lifecycle.teardownCapture(), h.lifecycle.teardownCapture()]);
    await h.lifecycle.resumeCapture();
    await h.lifecycle.suspendCapture();
    expect(h.events).toEqual(["setAnchor", "activate", "stop"]);
  });

});
