// Direct production-device imports: unchanged strip-only Node must load these
// before any test/harness executes. No transform or alternate Node flags here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  VideoComposerMedia,
  type ComposerMediaOptions,
  type GuideAudio,
} from "../src/media/reference/src/features/posts/video-submission/video-composer-media.ts";
import {
  VideoCaptureError,
  createCaptureFailureBoundary,
} from "../src/media/reference/src/features/posts/video-submission/capture-failure.ts";
import {
  SongSourceError,
  loadSongSource,
} from "../src/media/reference/src/features/posts/post-composer/song-excerpt-source.ts";
import { ServiceRefusal } from "../src/media/reference/src/service-refusal.ts";
import { captureStopAfterMs } from "../src/media/reference/src/features/posts/video-submission/clip-duration.ts";
import type {
  OriginalVideoCaptureInput,
  VideoCaptureSession,
} from "../src/media/reference/src/features/posts/video-submission/capture.ts";
import type { ComposerContext } from "../src/media/reference/src/features/posts/video-submission/video-composer-machine.ts";
import { deferred } from "./media-source-repair2-helpers.ts";

// Adapted cases from exact c7cb8783 video-composer-media.test.ts. Immutable
// .reference witness remains untouched; explicit resource doubles only.
const selection = {
  songPostId: "song-fixture",
  title: "Fixture",
  audioUrl: "https://fixture.invalid/audio",
  bounds: { startMs: 0, endMs: 10000 },
};
function streamDouble() {
  let stopped = 0;
  const stoppedOnce = deferred<void>();
  const track = {
    stop() {
      stopped++;
      stoppedOnce.resolve();
    },
  };
  // The production methods here read only getTracks and pass this identity.
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return { stream, stops: () => stopped, stopped: stoppedOnce.promise };
}
function fixture(extra: Partial<ComposerMediaOptions> = {}) {
  const streams: (MediaStream | null)[] = [],
    failures: (string | null)[] = [],
    originals: File[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let released = 0,
    pauses = 0,
    created = 0;
  const audio: GuideAudio = {
    currentTime: 0,
    readyState: 4,
    play: async () => {
      for (const listener of listeners.get("playing") ?? []) listener();
    },
    pause: () => {
      pauses++;
    },
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
  };
  const media = new VideoComposerMedia({
    canCapture: () => true,
    createGuideAudio: () => {
      created++;
      return audio;
    },
    prepareGuideSource: async () => ({
      url: "blob:guide-fixture",
      blob: new Blob(["fixture"]),
      release: () => {
        released++;
      },
    }),
    onStream: (next) => {
      streams.push(next);
    },
    onOriginalTake: (file) => {
      originals.push(file);
    },
    onFailure: (_reason, issue) => {
      failures.push(issue);
    },
    onLimit() {},
    onInterrupted() {},
    ...extra,
  });
  return {
    media,
    audio,
    streams,
    failures,
    originals,
    releases: () => released,
    pauses: () => pauses,
    created: () => created,
    listeners: () =>
      Array.from(listeners.values()).reduce((n, set) => n + set.size, 0),
  };
}

test(
  "actual device controller constructs, hands preview to capture, cancels and releases guide/listeners",
  { timeout: 2000 },
  async () => {
    const camera = streamDouble(),
      attached = deferred<void>();
    let cancels = 0,
      input: OriginalVideoCaptureInput | undefined;
    const take = new File(["take"], "take.mp4");
    const device = fixture({
      openPreview: async () => camera.stream,
      onStream: (next) => {
        if (next === camera.stream) attached.resolve();
      },
      startCapture: async (value) => {
        input = value;
        return {
          stream: camera.stream,
          captureOriginMs: performance.now(),
          stop: async () => take,
          cancel: async () => {
            cancels++;
            for (const track of camera.stream.getTracks()) track.stop();
          },
        };
      },
    });
    try {
      device.media.ensurePreview(() => true);
      await attached.promise;
      const signal = new AbortController().signal;
      const prepared = await device.media.prepareGuide(selection, signal);
      const started = await device.media.startCapture(prepared, signal);
      assert.equal(input?.stream, camera.stream);
      assert.equal(input?.limitMs, captureStopAfterMs(selection.bounds));
      assert.equal(
        (await device.media.startGuide(started, signal)).started,
        true,
      );
      assert.equal(device.listeners(), 3);
      await device.media.cancelCapture();
      assert.equal(cancels, 1);
      assert.equal(camera.stops(), 1);
      assert.equal(device.releases(), 1);
      assert.equal(device.listeners(), 0);
      device.media.dispose();
      assert.equal(cancels, 1);
      assert.equal(device.releases(), 1);
    } finally {
      device.media.dispose();
    }
  },
);

for (const cancellation of ["abort", "dispose"] as const) {
  test(
    `original late camera case after ${cancellation}: cancel without attaching or retaining guide`,
    { timeout: 2000 },
    async () => {
      const permission = deferred<VideoCaptureSession>(),
        entered = deferred<void>(),
        camera = streamDouble();
      let cancels = 0;
      const device = fixture({
        startCapture: async () => {
          entered.resolve();
          return permission.promise;
        },
      });
      const controller = new AbortController();
      try {
        const prepared = await device.media.prepareGuide(
          selection,
          controller.signal,
        );
        const pending = device.media.startCapture(prepared, controller.signal);
        const outcome = assert.rejects(pending, { name: "AbortError" });
        await entered.promise;
        if (cancellation === "abort") controller.abort();
        else device.media.dispose();
        permission.resolve({
          stream: camera.stream,
          captureOriginMs: 0,
          stop: async () => {
            throw new Error("Abandoned recording must not stop into a File");
          },
          cancel: async () => {
            cancels++;
            for (const track of camera.stream.getTracks()) track.stop();
          },
        });
        await outcome;
        assert.equal(cancels, 1);
        assert.equal(camera.stops(), 1);
        assert.equal(device.streams.filter(Boolean).length, 0);
        assert.equal(device.releases(), 1);
        assert.equal(device.pauses(), 1);
      } finally {
        device.media.dispose();
      }
    },
  );
  test(
    `original late guide case after ${cancellation}: release before creating playable audio`,
    { timeout: 2000 },
    async () => {
      const source = deferred<{
          url: string;
          blob: Blob;
          release: () => void;
        }>(),
        entered = deferred<void>();
      let releases = 0;
      const device = fixture({
        prepareGuideSource: async () => {
          entered.resolve();
          return source.promise;
        },
      });
      const controller = new AbortController();
      try {
        const pending = device.media.prepareGuide(selection, controller.signal);
        const outcome = assert.rejects(pending, { name: "AbortError" });
        await entered.promise;
        if (cancellation === "abort") controller.abort();
        else device.media.dispose();
        source.resolve({
          url: "blob:late-guide-fixture",
          blob: new Blob(),
          release: () => {
            releases++;
          },
        });
        await outcome;
        assert.equal(releases, 1);
        assert.equal(device.created(), 0);
      } finally {
        device.media.dispose();
      }
    },
  );
}

test(
  "original late preview permission case disposes tracks without attaching",
  { timeout: 2000 },
  async () => {
    const permission = deferred<MediaStream>(),
      entered = deferred<void>(),
      camera = streamDouble();
    const device = fixture({
      openPreview: async () => {
        entered.resolve();
        return permission.promise;
      },
    });
    device.media.ensurePreview(() => true);
    await entered.promise;
    device.media.dispose();
    permission.resolve(camera.stream);
    await camera.stopped;
    assert.equal(camera.stops(), 1);
    assert.equal(device.streams.filter(Boolean).length, 0);
  },
);

test(
  "original pending-preview eligibility loss refuses encoder startup and releases resources",
  { timeout: 2000 },
  async () => {
    const permission = deferred<MediaStream>(),
      camera = streamDouble();
    let eligible = true,
      encoders = 0;
    const device = fixture({
      canCapture: () => eligible,
      openPreview: async () => permission.promise,
      startCapture: async () => {
        encoders++;
        throw new Error("Ineligible encoder must not start");
      },
    });
    try {
      device.media.ensurePreview(() => true);
      const signal = new AbortController().signal,
        prepared = await device.media.prepareGuide(selection, signal);
      const pending = device.media.startCapture(prepared, signal),
        outcome = assert.rejects(pending, { name: "AbortError" });
      eligible = false;
      permission.resolve(camera.stream);
      await outcome;
      assert.equal(encoders, 0);
      assert.equal(camera.stops(), 1);
      assert.equal(device.releases(), 1);
    } finally {
      device.media.dispose();
    }
  },
);

test(
  "actual device finish retains the exact returned File and releases captured tracks",
  { timeout: 2000 },
  async () => {
    const camera = streamDouble(),
      take = new File(["captured bytes"], "take.mp4");
    const device = fixture({
      startCapture: async () => ({
        stream: camera.stream,
        captureOriginMs: 0,
        stop: async () => take,
        cancel: async () => {
          throw new Error("Successful finish must not cancel");
        },
      }),
      measureDuration: async (file) => {
        assert.equal(file, take);
        return 10000;
      },
    });
    try {
      const signal = new AbortController().signal;
      const prepared = await device.media.prepareGuide(selection, signal),
        started = await device.media.startCapture(prepared, signal);
      await device.media.startGuide(started, signal);
      // finishCapture reads only these fields when no soundtrack alignment is requested.
      const context = {
        session: started.session,
        takeSoundtrack: null,
      } as ComposerContext;
      const result = await device.media.finishCapture(context, signal);
      assert.equal(result.file, take);
      assert.equal(result.durationMs, 10000);
      assert.equal(result.alignment, "none");
      assert.deepEqual(device.originals, [take]);
      assert.equal(camera.stops(), 1);
      assert.equal(device.releases(), 1);
    } finally {
      device.media.dispose();
    }
  },
);

test(
  "adopted refusal constructors retain fields and original source/refusal projection",
  { timeout: 2000 },
  async () => {
    const capture = new VideoCaptureError("camera_denied", "Fixture denied");
    assert.equal(capture.reason, "camera_denied");
    assert.equal(capture.name, "VideoCaptureError");
    assert.equal(capture.message, "Fixture denied");
    const source = new SongSourceError(
      "age_restricted",
      "Fixture restricted",
      false,
    );
    assert.equal(source.reasonCode, "age_restricted");
    assert.equal(source.retryable, false);
    assert.equal(source.name, "SongSourceError");
    const result = await loadSongSource(
      { kind: "post", postId: "song-fixture" },
      async () => {
        throw source;
      },
    );
    assert.equal(result.kind, "restricted");
    const details = { reason_code: "capability_unavailable" },
      refusal = new ServiceRefusal(403, "fixture-refusal", false, details, 7);
    assert.equal(refusal.status, 403);
    assert.equal(refusal.code, "fixture-refusal");
    assert.equal(refusal.retryable, false);
    assert.equal(refusal.details, details);
    assert.equal(refusal.retryAfterSeconds, 7);
    assert.equal(refusal.message, "fixture-refusal");
  },
);

test(
  "original capture resource boundary releases and cancels once on asynchronous source failure",
  { timeout: 2000 },
  async () => {
    const source = deferred<void>(),
      cancelled = deferred<void>();
    let ended = false,
      releases = 0,
      cancellations = 0;
    const failures: VideoCaptureError[] = [];
    const boundary = createCaptureFailureBoundary({
      ended: () => ended,
      markEnded: () => {
        ended = true;
      },
      dimensionsChanged: () => false,
      release: () => {
        releases++;
      },
      cancel: async () => {
        cancellations++;
        cancelled.resolve();
      },
      onFailure: (error) => {
        failures.push(error);
      },
    });
    boundary.observe(source.promise);
    source.reject(new Error("Fixture encoder failed"));
    await cancelled.promise;
    boundary.fail("interrupted", "Already ended");
    assert.equal(releases, 1);
    assert.equal(cancellations, 1);
    assert.equal(failures[0].reason, "encoder_failed");
    assert.throws(
      () => boundary.assertFinalized(),
      (error) =>
        error instanceof VideoCaptureError &&
        error.reason === failures[0].reason &&
        error.message === failures[0].message,
    );
  },
);
