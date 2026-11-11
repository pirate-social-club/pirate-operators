// Story-only doubles extracted from exact c7cb8783 video-authoring.stories.tsx.
// They simulate device timing; they establish no physical-device acceptance.
import type { GuideAudio } from "../../src/media/reference/src/features/posts/video-submission/video-composer-media.ts";
import {
  VideoCaptureError,
  type OriginalVideoCaptureInput,
  type VideoCaptureSession,
} from "../../src/media/reference/src/features/posts/video-submission/capture.ts";
import { sampleVideoFile } from "./story-fixtures-media.ts";
interface StoryGuide extends GuideAudio {
  /** Freeze the guide's clock and report a playback gap, as a stalled stream does. */
  readonly stall: () => void;
}

let activeGuide: StoryGuide | undefined;

/** A guide with its own clock rather than an audio element. A real element is
 * refused by most browsers until the page has had a user gesture, which put
 * every recording story in the "would not play" state whenever it opened
 * unattended, whatever it was named for. This one starts when asked, so each
 * story shows the state it names; `blocked` makes it refuse the way a browser
 * does, for the one story about that refusal. The sound is not played: what
 * these stories show is the take's timing and its interruptions. */
export function storyGuide(
  options: { readonly blocked?: boolean } = {},
): StoryGuide {
  const listeners = new Map<string, Set<() => void>>();
  const emit = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  let base = 0;
  let startedAt = 0;
  let playing = false;
  const now = () =>
    playing ? base + (performance.now() - startedAt) / 1_000 : base;
  const guide: StoryGuide = {
    get currentTime() {
      return now();
    },
    set currentTime(value: number) {
      base = value;
      startedAt = performance.now();
    },
    play: async () => {
      if (options.blocked)
        throw new DOMException(
          "play() failed because the user didn't interact with the document first.",
          "NotAllowedError",
        );
      if (!playing) {
        base = now();
        startedAt = performance.now();
        playing = true;
      }
      queueMicrotask(() => emit("playing"));
    },
    pause: () => {
      base = now();
      playing = false;
    },
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    stall: () => {
      base = now();
      playing = false;
      emit("waiting");
    },
  };
  activeGuide = guide;
  return guide;
}

/** A canvas stream as the viewfinder: a real moving picture, no camera. */
export function canvasStream(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 426;
  const context = canvas.getContext("2d")!;
  const stream = canvas.captureStream(12);
  let frame = 0;
  const draw = () => {
    if (!stream.getVideoTracks().some((track) => track.readyState === "live"))
      return;
    context.fillStyle = "#123047";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#7dd3fc";
    context.fillRect((frame % 24) * 10, 300, 30, 30);
    frame += 1;
    requestAnimationFrame(draw);
  };
  draw();
  return stream;
}

export function captureDouble(
  options: {
    readonly fail?: "camera_denied" | "capability_unavailable";
    readonly autoStopAfterMs?: number;
    /** The encoder or a camera source fails this long after recording starts. */
    readonly encoderFailsAfterMs?: number;
    readonly orientationLost?: boolean;
  } = {},
) {
  return async (
    input: OriginalVideoCaptureInput,
  ): Promise<VideoCaptureSession> => {
    if (options.fail !== undefined) {
      throw new VideoCaptureError(
        options.fail,
        options.fail === "camera_denied"
          ? "Camera or microphone access is off."
          : "This browser can’t record video. Upload a video instead.",
      );
    }
    const stream = input.stream ?? canvasStream();
    if (options.autoStopAfterMs !== undefined) {
      setTimeout(() => {
        void input.onLimit();
      }, options.autoStopAfterMs);
    }
    if (options.encoderFailsAfterMs !== undefined) {
      setTimeout(() => {
        input.onFailure(
          new VideoCaptureError(
            options.orientationLost ? "orientation_lost" : "encoder_failed",
            "Recording stopped. Record again.",
          ),
        );
      }, options.encoderFailsAfterMs);
    }
    return {
      stream,
      captureOriginMs: performance.now(),
      stop: async () => sampleVideoFile(12_000, 0),
      cancel: async () => {
        for (const track of stream.getTracks()) track.stop();
      },
    };
  };
}
