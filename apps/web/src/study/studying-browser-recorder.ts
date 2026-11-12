// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-browser-recorder.ts.
import type { StudyingRecorder } from "./studying-route-model";

type SupportedContentType = Awaited<
  ReturnType<StudyingRecorder["stop"]>
>["contentType"];

const CONTENT_TYPES: readonly SupportedContentType[] = [
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
];
const MAX_DURATION_MS = 60_000;
const MAX_CAPTURE_BYTES = 524_288;

function recordingContentType(recorder: MediaRecorder): SupportedContentType {
  const normalized = recorder.mimeType.split(";", 1)[0]?.toLowerCase();
  const supported = CONTENT_TYPES.find((candidate) => candidate === normalized);
  if (!supported)
    throw new Error(
      "This browser does not expose a supported audio recording format.",
    );
  return supported;
}

/**
 * Browser microphone recorder that returns only API-accepted bounded audio
 * formats. Capture is cancellable at any moment — including while permission
 * is still pending — and the duration/size limits are enforced while
 * recording, not only once it stops.
 */
export function createStudyingBrowserRecorder(): StudyingRecorder {
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let chunks: Blob[] = [];
  let startedAt = 0;
  let capturedBytes = 0;
  let captureTimer: number | undefined;
  let oversize = false;
  // Bumping the generation invalidates everything an earlier start() is still
  // waiting on, so a permission granted after cancellation is released
  // immediately instead of recording unwatched.
  let generation = 0;

  const stopTracks = () => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  };

  const clearCaptureTimer = () => {
    if (captureTimer !== undefined && typeof window !== "undefined") {
      window.clearTimeout(captureTimer);
    }
    captureTimer = undefined;
  };

  const haltCapture = () => {
    clearCaptureTimer();
    if (recorder !== undefined && recorder.state !== "inactive")
      recorder.stop();
    stopTracks();
    recorder = undefined;
  };

  const release = () => {
    haltCapture();
    chunks = [];
    capturedBytes = 0;
  };

  const armCaptureLimits = () => {
    clearCaptureTimer();
    if (typeof window === "undefined") return;
    captureTimer = window.setTimeout(() => {
      oversize = true;
      haltCapture();
    }, MAX_DURATION_MS);
  };

  return {
    async start() {
      if (
        !globalThis.navigator?.mediaDevices ||
        typeof MediaRecorder === "undefined"
      ) {
        throw new Error("Voice recording is not available in this browser.");
      }
      const myGeneration = ++generation;
      oversize = false;
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      if (myGeneration !== generation) {
        // Cancelled (or disposed) while permission was pending: stop the
        // late-arriving tracks instead of starting an orphaned recording.
        acquired.getTracks().forEach((track) => track.stop());
        throw new Error("Study recording was cancelled.");
      }
      stream = acquired;
      const contentType = CONTENT_TYPES.find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      try {
        recorder = contentType
          ? new MediaRecorder(stream, { mimeType: contentType })
          : new MediaRecorder(stream);
        chunks = [];
        capturedBytes = 0;
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size === 0) return;
          chunks.push(event.data);
          capturedBytes += event.data.size;
          if (capturedBytes > MAX_CAPTURE_BYTES) {
            oversize = true;
            haltCapture();
          }
        });
        recorder.start(250);
        startedAt = performance.now();
        armCaptureLimits();
      } catch (error) {
        release();
        throw error;
      }
    },
    async stop() {
      if (oversize) {
        release();
        throw new Error(
          "The Study recording is empty or too large. Record a shorter answer.",
        );
      }
      const current = recorder;
      if (!current || current.state === "inactive") {
        // Stopping with nothing active also invalidates an in-flight
        // permission request, so its late grant cannot record unwatched.
        generation += 1;
        release();
        throw new Error("No Study recording is active.");
      }
      let contentType: SupportedContentType;
      try {
        contentType = recordingContentType(current);
      } catch (error) {
        release();
        throw error;
      }
      return await new Promise((resolve, reject) => {
        current.addEventListener(
          "error",
          () => {
            release();
            reject(
              new Error("The browser could not finish the Study recording."),
            );
          },
          { once: true },
        );
        current.addEventListener(
          "stop",
          () => {
            const elapsedMs = Math.round(performance.now() - startedAt);
            const audio = new Blob(chunks, { type: contentType });
            release();
            if (
              oversize ||
              elapsedMs > MAX_DURATION_MS ||
              audio.size === 0 ||
              audio.size > MAX_CAPTURE_BYTES
            ) {
              reject(
                new Error(
                  "The Study recording is empty or too large. Record a shorter answer.",
                ),
              );
              return;
            }
            const durationMs = Math.max(1, elapsedMs);
            resolve({ audio, contentType, durationMs });
          },
          { once: true },
        );
        current.stop();
      });
    },
    async cancel() {
      generation += 1;
      oversize = false;
      release();
    },
  };
}
