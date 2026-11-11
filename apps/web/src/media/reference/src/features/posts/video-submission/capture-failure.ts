export type VideoCaptureFailure =
  | "capability_unavailable"
  | "camera_denied"
  | "orientation_lost"
  | "encoder_failed"
  | "invalid_media"
  /** The page was hidden while a take depended on page-driven frames. */
  | "interrupted";
export class VideoCaptureError extends Error {
  readonly reason: VideoCaptureFailure;
  constructor(reason: VideoCaptureFailure, message: string) {
    super(message);
    this.reason = reason;
    this.name = "VideoCaptureError";
  }
}

/** What is wrong with a chosen or recorded video, in words a person can act
 * on, or null when it can be used. These are the browser's early admission
 * checks; the sealed server probe stays authoritative. */
export function videoAdmissionProblem(facts: {
  readonly container: string | undefined;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly width: number;
  readonly height: number;
  readonly averageFrameRate: number;
  readonly durationSeconds: number;
  readonly maxDurationSeconds: number;
}): string | null {
  const unsupported =
    "That video’s format isn’t supported. Choose an MP4 or MOV recorded on a phone.";
  if (
    !facts.hasVideo ||
    (facts.container !== "video/mp4" &&
      facts.container !== "video/quicktime") ||
    facts.videoCodec !== "avc"
  )
    return unsupported;
  if (!facts.hasAudio) return "That video has no sound. Choose one with audio.";
  if (facts.audioCodec !== "aac" || !Number.isFinite(facts.durationSeconds))
    return unsupported;
  if (
    !Number.isInteger(facts.width) ||
    !Number.isInteger(facts.height) ||
    facts.width < 1 ||
    facts.height < 1
  ) {
    return "That video’s dimensions couldn’t be read. Choose another video.";
  }
  // Match api-next's video-ingest-policy-v1; the server still verifies the file.
  if (Math.max(facts.width, facts.height) > 1_920) {
    return "Choose a video no wider or taller than 1920 pixels.";
  }
  // The sealed probe uses avg_frame_rate rounded to whole millihertz, not a
  // peak instantaneous rate or the camera's advertised capture rate.
  const frameRateMillihertz = Math.round(facts.averageFrameRate * 1_000);
  if (!Number.isSafeInteger(frameRateMillihertz) || frameRateMillihertz < 1) {
    return "That video’s frame rate couldn’t be read. Choose another video.";
  }
  if (frameRateMillihertz > 60_000) {
    return "Choose a video at 60 frames per second or lower.";
  }
  if (facts.durationSeconds < 3)
    return "That video is shorter than 3 seconds. Record or choose a longer one.";
  if (facts.durationSeconds > facts.maxDurationSeconds)
    return "That video is too long. Choose a shorter one.";
  return null;
}

/** Source error promises are independent of Stop and must end recording now. */
export function createCaptureFailureBoundary(input: {
  readonly ended: () => boolean;
  readonly markEnded: () => void;
  readonly dimensionsChanged: () => boolean;
  readonly release: () => void;
  readonly cancel: () => Promise<void>;
  readonly onFailure: (error: VideoCaptureError) => void;
}) {
  let sourceError: VideoCaptureError | null = null;
  function fail(reason: VideoCaptureFailure, message: string) {
    if (input.ended()) return;
    input.markEnded();
    input.release();
    input.onFailure(new VideoCaptureError(reason, message));
    void input.cancel().catch(() => {});
  }
  function sourceFailed() {
    const changed = input.dimensionsChanged();
    sourceError = new VideoCaptureError(
      changed ? "orientation_lost" : "encoder_failed",
      changed
        ? "Capture dimensions changed. Retake in one orientation."
        : "Recording failed. Try again or upload a video.",
    );
    fail(sourceError.reason, sourceError.message);
  }
  return {
    fail,
    observe(source: Promise<void>) {
      void source.catch(sourceFailed);
    },
    assertFinalized() {
      if (sourceError) throw sourceError;
    },
  };
}
