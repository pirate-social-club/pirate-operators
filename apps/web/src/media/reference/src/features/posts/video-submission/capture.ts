import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  canEncodeVideo,
  Input,
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output,
  Quality,
  type AudioEncodingConfig,
  type VideoEncodingConfig,
} from "mediabunny";

import { GUIDED_TAKE_MAX_DURATION_SECONDS } from "./clip-duration.ts";
import {
  createCaptureFailureBoundary,
  VideoCaptureError,
  videoAdmissionProblem,
} from "./capture-failure.ts";
import {
  isPortraitFrame,
  portraitCoverCrop,
  PORTRAIT_HEIGHT,
  PORTRAIT_WIDTH,
} from "./portrait-crop.ts";
export { VideoCaptureError } from "./capture-failure.ts";
export interface VideoCaptureSession {
  readonly stream: MediaStream;
  /** The capture timeline's origin in `performance.now()` terms: the moment
   * the encoder began. The guide's start is measured against this, not against
   * the later moment the session object reached its caller. */
  readonly captureOriginMs: number;
  readonly stop: () => Promise<File>;
  readonly cancel: () => Promise<void>;
}

// Android's variable-rate quality floor can make motion exceed the upload
// limit despite the requested bitrate. Probe and record with the same mode.
const videoQuality = new Quality({
  bitrate: 4_000_000,
  bitrateMode: "constant",
});
const audioQuality = new Quality({ bitrate: 128_000 });

/** Measures a chosen file's **video** duration in whole milliseconds, or null
 * when it cannot be read. The container duration is not the video's: an
 * aligned take carries the captured audio, which is not trimmed and can run
 * longer than the video, and a container that lasts longer than the excerpt
 * says nothing about whether the video itself covers it. The local duration
 * guard uses the video track; the sealed server probe remains authoritative. */
export async function measureVideoDuration(
  file: File,
  signal?: AbortSignal,
): Promise<number | null> {
  signal?.throwIfAborted();
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  const abort = () => input.dispose();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const video = await input.getPrimaryVideoTrack();
    const duration =
      video === null
        ? await input.computeDuration()
        : await video.computeDuration();
    return Number.isFinite(duration) && duration > 0
      ? Math.round(duration * 1_000)
      : null;
  } catch {
    return null;
  } finally {
    signal?.removeEventListener("abort", abort);
    input.dispose();
  }
}

const DEFAULT_MAX_DURATION_SECONDS = 180;

/** Browser admission is an early UX check; the sealed server probe stays authoritative. */
export async function inspectVideoFile(
  file: File,
  options: {
    readonly maxDurationSeconds?: number;
    readonly requirePortrait?: boolean;
  } = {},
): Promise<File> {
  const declared = file.type.toLowerCase().split(";")[0]?.trim();
  const type =
    declared ||
    (/\.mov$/iu.test(file.name)
      ? "video/quicktime"
      : /\.mp4$/iu.test(file.name)
        ? "video/mp4"
        : "");
  if (
    (type !== "video/mp4" && type !== "video/quicktime") ||
    file.size < 1 ||
    file.size > 500 * 1024 * 1024
  ) {
    throw new VideoCaptureError(
      "invalid_media",
      "Choose an MP4 or MOV no larger than 500 MiB",
    );
  }
  const maxDuration =
    options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const container = (await input.getMimeType()).split(";")[0]?.trim();
    const duration = await input.computeDuration();
    // Scan metadata for the whole track: a prefix estimate can miss a later
    // high-rate section. Packet rate is average video FPS in Mediabunny 1.55.5.
    const averageFrameRate =
      video === null
        ? Number.NaN
        : await video
            .computePacketStats()
            .then((stats) => stats.averagePacketRate)
            .catch(() => Number.NaN);
    const problem = videoAdmissionProblem({
      container,
      hasVideo: video !== null,
      hasAudio: audio !== null,
      videoCodec: video === null ? null : await video.getCodec(),
      audioCodec: audio === null ? null : await audio.getCodec(),
      width: video === null ? 0 : await video.getCodedWidth(),
      height: video === null ? 0 : await video.getCodedHeight(),
      averageFrameRate,
      durationSeconds: duration,
      maxDurationSeconds: maxDuration,
    });
    if (problem !== null || video === null)
      throw new VideoCaptureError(
        "invalid_media",
        problem ?? "That video has no picture.",
      );
    if (
      options.requirePortrait &&
      !isPortraitFrame(
        await video.getDisplayWidth(),
        await video.getDisplayHeight(),
      )
    ) {
      throw new VideoCaptureError(
        "invalid_media",
        "The camera didn’t save a vertical video. Record again before uploading.",
      );
    }
    return new File([file], file.name, {
      type,
      lastModified: file.lastModified,
    });
  } finally {
    input.dispose();
  }
}

/** Production composition of the proved 1.55.5 fMP4 path; no WebM or AAC polyfill. */
export interface OriginalVideoCaptureInput {
  readonly onFailure: (error: VideoCaptureError) => void;
  readonly onLimit: () => void;
  /** Recording stops at this length. A guided take passes the excerpt plus
   * its tail guard; without one the platform limit stands. */
  readonly limitMs?: number;
  /** A live camera stream already shown as the preview. The recording takes
   * ownership of it and stops its tracks when the take ends. */
  readonly stream?: MediaStream;
  /** Start the file with video before admitting microphone samples. Both
   * retain synced-zero time; the microphone is never shifted to video zero. */
  readonly videoFirst?: boolean;
  /** Optional observation before encoder initialization. Both tracks keep
   * their shared synced-zero timestamps. This reports source arrival, not
   * camera exposure, audible output or encoded-packet acknowledgement. */
  readonly onSourceSample?: (sample: {
    readonly kind: "video" | "audio";
    readonly timestampMs: number;
    readonly durationMs: number;
    readonly originMs: number;
  }) => void;
}

async function assertRecordingCapability(): Promise<void> {
  if (
    !globalThis.isSecureContext ||
    !navigator.mediaDevices?.getUserMedia ||
    !("VideoEncoder" in globalThis) ||
    !("AudioEncoder" in globalThis) ||
    !(await canEncodeVideo("avc", {
      width: 720,
      height: 1280,
      quality: videoQuality,
      fullCodecString: "avc1.42e01f",
      hardwareAcceleration: "prefer-hardware",
      latencyMode: "realtime",
    })) ||
    !(await canEncodeAudio("aac", {
      numberOfChannels: 1,
      sampleRate: 48_000,
      quality: audioQuality,
    }))
  ) {
    throw new VideoCaptureError(
      "capability_unavailable",
      "This browser can’t record video. Upload a video instead.",
    );
  }
}

async function openCameraStream(): Promise<MediaStream> {
  try {
    // Phone cameras size themselves by their landscape sensor. Asking for
    // 1920x1080 made the Pixel 8 front camera deliver native 1080x1920
    // portrait frames, where asking for 720x1280 delivered 1280x720 landscape
    // and left only a 405x720 portrait crop. Landscape frames still go through
    // the centered portrait crop below.
    return await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: true,
    });
  } catch {
    throw new VideoCaptureError(
      "camera_denied",
      "Camera or microphone access is off.",
    );
  }
}

/** Opens the camera for a live preview before recording, so the capture
 * screen shows the camera immediately. The caller stops the tracks when the
 * preview is abandoned; a recording started from it stops them itself. */
export async function openCameraPreview(): Promise<MediaStream> {
  await assertRecordingCapability();
  return openCameraStream();
}

/** Android may return landscape camera frames even for exact portrait media
 * constraints. Encode the same centered cover shown in the 9:16 viewfinder;
 * never silently upload the underlying landscape track. */
async function portraitEncodingTrack(
  stream: MediaStream,
  camera: MediaStreamVideoTrack,
  onFrameFailure: () => void,
): Promise<{
  readonly track: MediaStreamVideoTrack;
  readonly width: number;
  readonly height: number;
  readonly close: () => void;
}> {
  const settings = camera.getSettings();
  if (isPortraitFrame(settings.width ?? 0, settings.height ?? 0)) {
    return {
      track: camera,
      width: settings.width!,
      height: settings.height!,
      close: () => undefined,
    };
  }
  const canvas = document.createElement("canvas");
  canvas.width = PORTRAIT_WIDTH;
  canvas.height = PORTRAIT_HEIGHT;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context || typeof canvas.captureStream !== "function") {
    throw new VideoCaptureError(
      "capability_unavailable",
      "This browser can’t save vertical video. Upload a video instead.",
    );
  }
  const cameraView = document.createElement("video");
  cameraView.muted = true;
  cameraView.playsInline = true;
  cameraView.srcObject = stream;
  let frame = 0;
  let closed = false;
  let firstFrame = true;
  let outputTrack: MediaStreamVideoTrack | undefined;
  const close = () => {
    closed = true;
    cancelAnimationFrame(frame);
    outputTrack?.stop();
    cameraView.pause();
    cameraView.srcObject = null;
  };
  try {
    await cameraView.play();
    if (!cameraView.videoWidth || !cameraView.videoHeight) {
      throw new VideoCaptureError(
        "capability_unavailable",
        "The camera did not provide a usable frame. Retake the video.",
      );
    }
    const paint = () => {
      if (closed) return;
      try {
        const crop = portraitCoverCrop(
          cameraView.videoWidth,
          cameraView.videoHeight,
        );
        context.drawImage(
          cameraView,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          0,
          0,
          PORTRAIT_WIDTH,
          PORTRAIT_HEIGHT,
        );
      } catch {
        if (firstFrame)
          throw new VideoCaptureError(
            "capability_unavailable",
            "The camera could not draw a portrait frame.",
          );
        onFrameFailure();
        return;
      }
      firstFrame = false;
      frame = requestAnimationFrame(paint);
    };
    paint();
    outputTrack = canvas.captureStream(30).getVideoTracks()[0];
    if (!outputTrack) {
      throw new VideoCaptureError(
        "capability_unavailable",
        "The camera could not provide a portrait recording track.",
      );
    }
    return {
      track: outputTrack,
      width: PORTRAIT_WIDTH,
      height: PORTRAIT_HEIGHT,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export async function startOriginalVideoCapture(
  input: OriginalVideoCaptureInput,
): Promise<VideoCaptureSession> {
  await assertRecordingCapability();
  const stream = input.stream ?? (await openCameraStream());
  const target = new BufferTarget();
  const output = new Output({
    target,
    format: new Mp4OutputFormat({
      fastStart: "fragmented",
      minimumFragmentDuration: 1,
    }),
  });
  let ended = false;
  let frameFailed = false;
  let orientationLocked = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let portraitTrack:
    | Awaited<ReturnType<typeof portraitEncodingTrack>>
    | undefined;
  let sourceOriginMs: number | undefined;
  let admitAudio: (() => void) | undefined;
  const observe = <
    T extends { readonly timestamp: number; readonly duration: number },
  >(
    kind: "video" | "audio",
    sample: T,
  ): T => {
    sourceOriginMs ??= performance.now() - sample.timestamp * 1000;
    input.onSourceSample?.({
      kind,
      timestampMs: sample.timestamp * 1000,
      durationMs: sample.duration * 1000,
      originMs: sourceOriginMs,
    });
    if (kind === "video" && admitAudio) {
      const resume = admitAudio;
      admitAudio = undefined;
      resume();
    }
    return sample;
  };
  const tracks = stream.getTracks();
  const orientation = globalThis.screen?.orientation;
  const release = () => {
    clearInterval(timer);
    orientation?.removeEventListener("change", rotated);
    portraitTrack?.track.removeEventListener("ended", trackEnded);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", pageHidden);
    portraitTrack?.close();
    for (const track of tracks) {
      track.removeEventListener("ended", trackEnded);
      track.stop();
    }
    if (orientationLocked) orientation?.unlock();
  };
  let dimensionsChanged = () => false;
  const boundary = createCaptureFailureBoundary({
    ended: () => ended,
    markEnded: () => {
      ended = true;
    },
    dimensionsChanged: () => dimensionsChanged(),
    release,
    cancel: () => output.cancel(),
    onFailure: input.onFailure,
  });
  const rotated = () =>
    boundary.fail(
      "orientation_lost",
      "The phone rotated during capture. Retake in one orientation.",
    );
  // A hidden page stops painting portrait frames, and on the Pixel 8 even the
  // native camera track kept its frame clock but froze the picture while
  // hidden. The take is cancelled rather than finalized, so a recording with
  // a frozen stretch never exists to be reviewed or uploaded.
  const pageHidden = () => {
    if (document.visibilityState === "hidden") {
      boundary.fail(
        "interrupted",
        "The recording stopped because you left the page. Record again.",
      );
    }
  };
  const trackEnded = () =>
    boundary.fail(
      "encoder_failed",
      "The camera or microphone stopped. Try recording again.",
    );
  try {
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0];
    if (!video || !audio)
      throw new VideoCaptureError(
        "capability_unavailable",
        "A camera and a microphone are both needed to record.",
      );
    const settings = video.getSettings();
    const sound = audio.getSettings();
    portraitTrack = await portraitEncodingTrack(stream, video, () => {
      frameFailed = true;
      boundary.fail("encoder_failed", "Recording stopped. Try again.");
    });
    const { width, height } = portraitTrack;
    const pixels = width * height;
    const profile =
      pixels <= 640 * 480
        ? "avc1.42e01e"
        : pixels <= 720 * 1280
          ? "avc1.42e01f"
          : "avc1.42e028";
    if (
      pixels > 1080 * 1920 ||
      !(await canEncodeVideo("avc", {
        width,
        height,
        quality: videoQuality,
        fullCodecString: profile,
        hardwareAcceleration: "prefer-hardware",
        latencyMode: "realtime",
      })) ||
      !(await canEncodeAudio("aac", {
        numberOfChannels: sound.channelCount ?? 1,
        sampleRate: sound.sampleRate ?? 48_000,
        quality: audioQuality,
      }))
    ) {
      throw new VideoCaptureError(
        "capability_unavailable",
        "This browser can’t record with this phone’s camera and microphone.",
      );
    }
    const videoConfig: VideoEncodingConfig = {
      codec: "avc",
      quality: videoQuality,
      fullCodecString: profile,
      keyFrameInterval: 1,
      hardwareAcceleration: "prefer-hardware",
      latencyMode: "realtime",
    };
    const audioConfig: AudioEncodingConfig = {
      codec: "aac",
      quality: audioQuality,
    };
    if (input.onSourceSample || input.videoFirst) {
      videoConfig.transform = { process: (sample) => observe("video", sample) };
      audioConfig.transform = { process: (sample) => observe("audio", sample) };
    }
    const videoSource = new MediaStreamVideoTrackSource(
      portraitTrack.track,
      videoConfig,
      { frameRate: 30 },
    );
    const audioSource = new MediaStreamAudioTrackSource(audio, audioConfig);
    if (input.videoFirst) {
      audioSource.pause();
      admitAudio = () => audioSource.resume();
    }
    dimensionsChanged = () => {
      const current = video.getSettings();
      return (
        current.width !== settings.width || current.height !== settings.height
      );
    };
    boundary.observe(videoSource.errorPromise);
    boundary.observe(audioSource.errorPromise);
    if (portraitTrack.track !== video)
      portraitTrack.track.addEventListener("ended", trackEnded, { once: true });
    document.addEventListener("visibilitychange", pageHidden);
    output.addVideoTrack(videoSource);
    output.addAudioTrack(audioSource);
    // Locking is optional platform functionality. Changes are take-ending even
    // when the browser refuses the lock. A hidden page ends the take above.
    if (
      orientation &&
      "lock" in orientation &&
      typeof orientation.lock === "function"
    ) {
      try {
        await orientation.lock(orientation.type);
        orientationLocked = true;
      } catch {
        /* change guard remains active */
      }
    }
    orientation?.addEventListener("change", rotated);
    for (const track of tracks)
      track.addEventListener("ended", trackEnded, { once: true });
    await output.start();
    if (ended)
      throw new VideoCaptureError(
        "encoder_failed",
        "The recording didn’t start. Try again.",
      );
    // The exposed capture origin: the encoder is running and the file's
    // timeline begins here. Everything after this in setup time must not be
    // counted as recorded lead-in.
    const captureOriginMs = performance.now();
    const started = captureOriginMs;
    const limitMs =
      input.limitMs === undefined
        ? 180_000
        : Math.min(Math.max(3_000, input.limitMs), 181_500);
    let limitReported = false;
    timer = setInterval(() => {
      const current = video.getSettings();
      if (
        current.width !== settings.width ||
        current.height !== settings.height
      ) {
        rotated();
        return;
      }
      if (!limitReported && performance.now() - started >= limitMs) {
        limitReported = true;
        input.onLimit();
      }
    }, 100);
    return {
      stream,
      captureOriginMs,
      async stop() {
        if (ended)
          throw new VideoCaptureError(
            "encoder_failed",
            "Capture has already ended",
          );
        ended = true;
        clearInterval(timer);
        try {
          await output.finalize();
          boundary.assertFinalized();
          if (frameFailed)
            throw new VideoCaptureError(
              "encoder_failed",
              "Recording stopped. Try again.",
            );
          if (!target.buffer)
            throw new VideoCaptureError(
              "encoder_failed",
              "The recording couldn’t be saved. Try again.",
            );
          return await inspectVideoFile(
            new File([target.buffer], "original-video.mp4", {
              type: "video/mp4",
            }),
            {
              // Only the app's own guided take is allowed its tail guard; a
              // chosen file keeps the ordinary admission bound.
              maxDurationSeconds: GUIDED_TAKE_MAX_DURATION_SECONDS,
              requirePortrait: true,
            },
          );
        } finally {
          release();
        }
      },
      async cancel() {
        if (ended) {
          release();
          return;
        }
        ended = true;
        try {
          await output.cancel();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    ended = true;
    release();
    await output.cancel().catch(() => {});
    throw error;
  }
}
