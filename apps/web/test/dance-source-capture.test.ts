/** UNRUN. Original c7 capture ownership/coverage controller, native encoder and
 * guide supplied as named simulations. Real packet verification is separate. */
import test from "node:test";
import assert from "node:assert/strict";
import { startDanceCapture } from "../src/dance/source/dance-capture.ts";
import type {
  OriginalVideoCaptureInput,
  VideoCaptureSession,
} from "../src/dance/source/platform/capture.ts";
import { simulatedSource } from "./dance-source-fixtures.ts";
test("video zero starts the guide once; both tracks must cover the frozen endpoint before stop", async () => {
  const f = simulatedSource();
  let input!: OriginalVideoCaptureInput,
    began!: () => void,
    stops = 0,
    guideStarts = 0,
    trackStops = 0;
  const ready = new Promise<void>((r) => {
    began = r;
  });
  const stream = {
    getTracks: () => [
      {
        stop: () => {
          trackStops++;
        },
      },
    ],
  } as unknown as MediaStream;
  const capture = startDanceCapture(
    {
      ready: f.ready,
      stream,
      signal: new AbortController().signal,
      guide: {
        sessionId: f.c.captureId,
        termsHash: f.c.termsHash,
        activate: async () => {},
        start: () => {
          guideStarts++;
        },
        dispose: () => {},
      },
    },
    {
      startCapture: async (options) => {
        input = options;
        began();
        return {
          stream,
          captureOriginMs: 0,
          stop: async () => {
            stops++;
            return new File(["simulated encoder bytes"], "take.mp4", {
              type: "video/mp4",
            });
          },
          cancel: async () => {},
        };
      },
      boundRecording: async (options) => {
        assert.equal(options.window.body_end_ms, f.session.body_end_ms);
        return options.file;
      },
    },
  );
  await ready;
  await Promise.resolve();
  input.onSourceSample!({
    kind: "video",
    timestampMs: 0,
    durationMs: 0,
    originMs: 1000,
  });
  input.onSourceSample!({
    kind: "video",
    timestampMs: 0,
    durationMs: f.session.body_end_ms,
    originMs: 1000,
  });
  assert.equal(guideStarts, 1);
  assert.equal(stops, 0);
  input.onSourceSample!({
    kind: "audio",
    timestampMs: 0,
    durationMs: f.session.body_end_ms,
    originMs: 1000,
  });
  const result = await capture.result;
  assert.equal(stops, 1);
  assert.equal(result.sessionId, f.c.captureId);
  assert.equal(result.termsHash, f.c.termsHash);
  assert.equal(result.durationMs, f.c.durationSamples / 48);
  assert.equal(trackStops > 0, true);
});
test("cancellation while the native encoder opens cannot produce a take and cleans a late encoder", async () => {
  const f = simulatedSource();
  let finish!: (s: VideoCaptureSession) => void,
    began!: () => void,
    canceled = 0;
  const opened = new Promise<void>((r) => {
    began = r;
  });
  const stream = {
    getTracks: () => [{ stop: () => {} }],
  } as unknown as MediaStream;
  const capture = startDanceCapture(
    {
      ready: f.ready,
      stream,
      signal: new AbortController().signal,
      guide: {
        sessionId: f.c.captureId,
        termsHash: f.c.termsHash,
        activate: async () => {},
        start: () => {},
        dispose: () => {},
      },
    },
    {
      startCapture: async () => {
        began();
        return new Promise((r) => {
          finish = r;
        });
      },
    },
  );
  const refused = assert.rejects(capture.result);
  await opened;
  capture.cancel();
  finish({
    stream,
    captureOriginMs: 0,
    stop: async () => {
      throw Error("must_not_finalize");
    },
    cancel: async () => {
      canceled++;
    },
  });
  await refused;
  await Promise.resolve();
  assert.equal(canceled, 1);
});
