import { afterEach, describe, expect, test, vi } from "vitest";
import type { SoundtrackSelection } from "../post-composer/song-excerpt-composer";
import type { OriginalVideoCaptureInput, VideoCaptureSession } from "./capture";
import { VideoCaptureError } from "./capture-failure";
import { VideoComposerMedia, type ComposerMediaOptions, type GuideAudio } from "./video-composer-media";

const selection: SoundtrackSelection = {
  songPostId: "song", title: "Song", audioUrl: "https://example.test/song",
  bounds: { startMs: 0, endMs: 10_000 },
};
const adapters: VideoComposerMedia[] = [];
afterEach(() => { for (const media of adapters.splice(0)) media.dispose(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

function fixture(overrides: Partial<ComposerMediaOptions> = {}) {
  const onStream = vi.fn();
  const release = vi.fn();
  const audio: GuideAudio = {
    currentTime: 0, readyState: 4, play: vi.fn(async () => {}), pause: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  const createGuideAudio = vi.fn(() => audio);
  const media = new VideoComposerMedia({
    canCapture: () => true,
    createGuideAudio, prepareGuideSource: async () => ({ url: "blob:guide", blob: new Blob(), release }),
    onStream, onOriginalTake: vi.fn(), onFailure: vi.fn(), onLimit: vi.fn(), onInterrupted: vi.fn(),
    ...overrides,
  });
  adapters.push(media);
  return { media, onStream, release, audio, createGuideAudio };
}

describe.each(["abort", "dispose"] as const)("late media completion after %s", cancellation => {
  test("a late camera session is cancelled without being attached or keeping its guide", async () => {
    const permission = deferred<VideoCaptureSession>();
    const startCapture = vi.fn(() => permission.promise);
    const { media, onStream, release, audio } = fixture({ startCapture });
    const prepared = await media.prepareGuide(selection, new AbortController().signal);
    const controller = new AbortController();
    const pending = media.startCapture(prepared, controller.signal);
    await vi.waitFor(() => expect(startCapture).toHaveBeenCalledTimes(1));
    if (cancellation === "abort") controller.abort();
    else media.dispose();
    const cancel = vi.fn(async () => {});
    // SAFETY: An abandoned session's stream must never be read or attached.
    const stream = Object.create(null) as MediaStream;
    permission.resolve({ stream, captureOriginMs: 0, stop: vi.fn(), cancel });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onStream.mock.calls.filter(([value]) => value !== null)).toHaveLength(0);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("a late guide source is released without creating playable audio", async () => {
    const source = deferred<{ url: string; blob: Blob; release: () => void }>();
    const prepareGuideSource = vi.fn(() => source.promise);
    const { media, createGuideAudio } = fixture({ prepareGuideSource });
    const controller = new AbortController();
    const pending = media.prepareGuide(selection, controller.signal);
    await vi.waitFor(() => expect(prepareGuideSource).toHaveBeenCalledTimes(1));
    if (cancellation === "abort") controller.abort();
    else media.dispose();
    const release = vi.fn();
    source.resolve({ url: "blob:late-guide", blob: new Blob(), release });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(createGuideAudio).not.toHaveBeenCalled();
  });
});

test("camera permission granted after disposal stops the preview tracks", async () => {
  const permission = deferred<MediaStream>();
  const openPreview = vi.fn(() => permission.promise);
  const { media, onStream } = fixture({ openPreview });
  media.ensurePreview(() => true);
  await vi.waitFor(() => expect(openPreview).toHaveBeenCalledTimes(1));
  media.dispose();
  const stop = vi.fn();
  // SAFETY: The abandoned preview reads only getTracks to release each track.
  const stream = Object.assign(Object.create(null) as MediaStream, { getTracks: () => [{ stop }] });
  permission.resolve(stream);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  expect(onStream.mock.calls.filter(([value]) => value !== null)).toHaveLength(0);
});

test("approval lost while preview permission is pending prevents encoder startup", async () => {
  const permission = deferred<MediaStream>();
  let eligible = true;
  const startCapture = vi.fn();
  const { media, release } = fixture({
    canCapture: () => eligible,
    openPreview: () => permission.promise,
    startCapture,
  });
  media.ensurePreview(() => true);
  const controller = new AbortController();
  const prepared = await media.prepareGuide(selection, controller.signal);
  const pending = media.startCapture(prepared, controller.signal);
  eligible = false;
  const stop = vi.fn();
  // SAFETY: Only getTracks is used to release this preview before capture starts.
  const stream = Object.assign(Object.create(null) as MediaStream, { getTracks: () => [{ stop }] });
  permission.resolve(stream);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(startCapture).not.toHaveBeenCalled();
});

test("a cancelled startup's failure cannot detach or forget a newer capture", async () => {
  const first = deferred<VideoCaptureSession>();
  const inputs: OriginalVideoCaptureInput[] = [];
  const onFailure = vi.fn();
  const onLimit = vi.fn();
  const cancelSecond = vi.fn(async () => {});
  // SAFETY: This fixture only compares streams; no stream methods are needed.
  const stream = Object.create(null) as MediaStream;
  const second: VideoCaptureSession = { stream, captureOriginMs: 0, stop: vi.fn(), cancel: cancelSecond };
  const { media, onStream } = fixture({
    onFailure, onLimit,
    startCapture: async input => {
      inputs.push(input);
      return inputs.length === 1 ? first.promise : second;
    },
  });
  const firstController = new AbortController();
  const prepared = await media.prepareGuide(selection, firstController.signal);
  const pending = media.startCapture(prepared, firstController.signal);
  await vi.waitFor(() => expect(inputs).toHaveLength(1));
  firstController.abort();
  const secondController = new AbortController();
  const secondPrepared = await media.prepareGuide(selection, secondController.signal);
  await media.startCapture(secondPrepared, secondController.signal);
  inputs[0]!.onFailure(new VideoCaptureError("encoder_failed", "Old startup failed"));
  inputs[0]!.onLimit();
  expect.soft(onFailure).not.toHaveBeenCalled();
  expect.soft(onLimit).not.toHaveBeenCalled();
  expect.soft(onStream.mock.lastCall?.[0]).toBe(stream);
  await media.cancelCapture();
  expect.soft(cancelSecond).toHaveBeenCalledTimes(1);
  first.resolve({ stream, captureOriginMs: 0, stop: vi.fn(), cancel: vi.fn(async () => {}) });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});


test("a chosen file's hung measurement expires and a later measurement succeeds", async () => {
  vi.useFakeTimers();
  const duration = deferred<number>();
  let first = true;
  const file = new File(["video"], "video.mp4");
  const { media } = fixture({ inspectFile: async chosen => chosen,
    measureDuration: async () => { if (first) { first = false; return duration.promise; } return 10_000; },
  });
  try {
    const result = media.inspectFile(file, new AbortController().signal);
    const rejected = expect(result).rejects.toThrow("The recording couldn’t finish. Record again.");
    await vi.advanceTimersByTimeAsync(10_000); await rejected;
    const next = new File(["new"], "new.mp4");
    expect(await media.inspectFile(next, new AbortController().signal)).toMatchObject({ file: next, durationMs: 10_000 });
    duration.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
