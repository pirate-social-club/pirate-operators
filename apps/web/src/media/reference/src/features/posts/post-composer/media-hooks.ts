// Media layout helpers + Solid media hooks for the composer, ported from the
// React video-preview-layout.ts, use-keyboard-bottom-offset.ts, and the object
// URL / audio preview hooks inlined in the React composer components.

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

import type { PlaybackState } from "./post-card-preview-types.ts";
import { extractVideoPosterFrameDataUrl } from "./video-poster.ts";

const portraitAspectRatioMaxWidthClass = "mx-auto w-full max-w-[22rem]";
const defaultAspectRatioMaxWidthClass = "w-full";

function normalizeMediaAspectRatio(
  width: number,
  height: number,
): number | undefined {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }

  return width / height;
}

function isPortraitMedia(aspectRatio: number | undefined): boolean {
  return typeof aspectRatio === "number" && aspectRatio > 0 && aspectRatio < 1;
}

export function getVideoPreviewFrameClassName(
  aspectRatio: number | undefined,
): string {
  return isPortraitMedia(aspectRatio)
    ? portraitAspectRatioMaxWidthClass
    : defaultAspectRatioMaxWidthClass;
}

export function getVideoPreviewObjectFitClassName(
  aspectRatio: number | undefined,
): string {
  return isPortraitMedia(aspectRatio) ? "object-contain" : "object-cover";
}

export function getMediaAspectRatioStyle(
  aspectRatio: number | undefined,
): { "aspect-ratio": string } | undefined {
  return typeof aspectRatio === "number" && aspectRatio > 0
    ? { "aspect-ratio": String(aspectRatio) }
    : undefined;
}

export function createObjectUrl(
  file: Accessor<File | null | undefined>,
): Accessor<string | undefined> {
  const [objectUrl, setObjectUrl] = createSignal<string | undefined>(
    undefined,
    { ownedWrite: true },
  );

  createEffect(
    () => file(),
    (current) => {
      if (!current || typeof URL.createObjectURL !== "function") {
        setObjectUrl(undefined);
        return;
      }
      const nextUrl = URL.createObjectURL(current);
      setObjectUrl(nextUrl);
      return () => URL.revokeObjectURL(nextUrl);
    },
  );

  return objectUrl;
}

export function createVideoSourceAspectRatio(
  src: Accessor<string | undefined>,
): Accessor<number | undefined> {
  const [aspectRatio, setAspectRatio] = createSignal<number | undefined>(
    undefined,
    { ownedWrite: true },
  );

  createEffect(
    () => src(),
    (current) => {
      setAspectRatio(undefined);
      if (!current || typeof document === "undefined") return;

      let cancelled = false;
      const video = document.createElement("video");
      video.preload = "metadata";
      video.src = current;

      const updateAspectRatio = () => {
        if (cancelled) return;
        setAspectRatio(
          normalizeMediaAspectRatio(video.videoWidth, video.videoHeight),
        );
      };
      const clearAspectRatio = () => {
        if (cancelled) return;
        setAspectRatio(undefined);
      };

      video.addEventListener("loadedmetadata", updateAspectRatio, {
        once: true,
      });
      video.addEventListener("error", clearAspectRatio, { once: true });
      video.load();

      onCleanup(() => {
        cancelled = true;
        video.removeAttribute("src");
        video.load();
      });
    },
  );

  return aspectRatio;
}

// First-frame poster for the write-step video attachment card.
export function createVideoPosterUrl(
  file: Accessor<File | null | undefined>,
): Accessor<string | undefined> {
  const [posterUrl, setPosterUrl] = createSignal<string | undefined>(
    undefined,
    { ownedWrite: true },
  );

  createEffect(
    () => file(),
    (current) => {
      setPosterUrl(undefined);
      if (!current) return;

      let cancelled = false;
      void extractVideoPosterFrameDataUrl(current, "0")
        .then((poster) => {
          if (!cancelled) setPosterUrl(poster.dataUrl);
        })
        .catch(() => {
          if (!cancelled) setPosterUrl(undefined);
        });

      onCleanup(() => {
        cancelled = true;
      });
    },
  );

  return posterUrl;
}

// Selected-frame poster for the publish preview. Keeps the last valid frame
// when a new frame cannot be extracted (same as React).
export function createVideoPosterFrameUrl(
  file: Accessor<File | null | undefined>,
  frameSeconds: Accessor<string | undefined>,
): Accessor<string | undefined> {
  const [posterUrl, setPosterUrl] = createSignal<string | undefined>(
    undefined,
    { ownedWrite: true },
  );
  let previousFile: File | null | undefined;

  createEffect(
    () => [file(), frameSeconds()] as const,
    ([current, seconds]) => {
      if (!current) {
        previousFile = null;
        setPosterUrl(undefined);
        return;
      }

      const fileChanged = previousFile !== current;
      previousFile = current;
      if (fileChanged) {
        setPosterUrl(undefined);
      }

      let cancelled = false;
      void extractVideoPosterFrameDataUrl(current, seconds)
        .then((poster) => {
          if (!cancelled) setPosterUrl(poster.dataUrl);
        })
        .catch(() => undefined);

      onCleanup(() => {
        cancelled = true;
      });
    },
  );

  return posterUrl;
}

export function createKeyboardBottomOffset(): Accessor<number> {
  const [offset, setOffset] = createSignal(0, { ownedWrite: true });

  createEffect(
    () => (typeof window === "undefined" ? null : window.visualViewport),
    (viewport) => {
      if (!viewport) return;
      const activeViewport: VisualViewport = viewport;

      const updateOffset = () => {
        setOffset(
          Math.max(
            0,
            window.innerHeight -
              activeViewport.height -
              activeViewport.offsetTop,
          ),
        );
      };

      updateOffset();
      activeViewport.addEventListener("resize", updateOffset);
      activeViewport.addEventListener("scroll", updateOffset, {
        passive: true,
      });
      onCleanup(() => {
        activeViewport.removeEventListener("resize", updateOffset);
        activeViewport.removeEventListener("scroll", updateOffset);
      });
    },
  );

  return offset;
}

export interface LocalAudioPreview {
  durationMs: Accessor<number | undefined>;
  onPause: () => void;
  onPlay: () => Promise<void>;
  onSeek: (progressMs: number) => void;
  progressMs: Accessor<number>;
  state: Accessor<PlaybackState>;
}

// Local <audio> preview playback for the song publish preview, ported from the
// React useLocalAudioPreview.
export function createLocalAudioPreview(
  src: Accessor<string | undefined>,
): LocalAudioPreview {
  const audio = typeof Audio === "undefined" ? null : new Audio();
  const [state, setState] = createSignal<PlaybackState>("idle", {
    ownedWrite: true,
  });
  const [progressMs, setProgressMs] = createSignal(0, { ownedWrite: true });
  const [durationMs, setDurationMs] = createSignal<number | undefined>(
    undefined,
    { ownedWrite: true },
  );

  if (audio) {
    const handlePlay = () => setState("playing");
    const handlePause = () =>
      setState(audio.currentTime > 0 && !audio.ended ? "paused" : "idle");
    const handleEnded = () => setState("ended");
    const handleWaiting = () => setState("buffering");
    const handleCanPlay = () => {
      if (!audio.paused) setState("playing");
    };
    const updateProgress = () => {
      setProgressMs(Math.round(audio.currentTime * 1000));
      setDurationMs(
        Number.isFinite(audio.duration) && audio.duration > 0
          ? Math.round(audio.duration * 1000)
          : undefined,
      );
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("canplay", handleCanPlay);
    audio.addEventListener("durationchange", updateProgress);
    audio.addEventListener("loadedmetadata", updateProgress);
    audio.addEventListener("seeked", updateProgress);
    audio.addEventListener("timeupdate", updateProgress);

    onCleanup(() => {
      audio.pause();
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("durationchange", updateProgress);
      audio.removeEventListener("loadedmetadata", updateProgress);
      audio.removeEventListener("seeked", updateProgress);
      audio.removeEventListener("timeupdate", updateProgress);
    });
  }

  createEffect(
    () => src(),
    (current) => {
      if (!audio) return;
      audio.pause();
      audio.removeAttribute("src");
      setState("idle");
      setProgressMs(0);
      setDurationMs(undefined);
      if (current) {
        audio.preload = "metadata";
        audio.src = current;
      }
      audio.load();
    },
  );

  async function onPlay() {
    const current = src();
    if (!audio || !current) return;
    setState("buffering");
    if (audio.src !== current) {
      audio.src = current;
    }
    try {
      await audio.play();
    } catch {
      setState("idle");
    }
  }

  function onPause() {
    audio?.pause();
  }

  function onSeek(nextProgressMs: number) {
    const current = src();
    if (!audio || !current) return;
    if (audio.src !== current) {
      audio.src = current;
    }
    const nextSeconds = Math.max(0, nextProgressMs / 1000);
    const seekTo = () => {
      audio.currentTime = Number.isFinite(audio.duration)
        ? Math.min(nextSeconds, audio.duration)
        : nextSeconds;
    };
    if (audio.readyState > HTMLMediaElement.HAVE_NOTHING) {
      seekTo();
    } else {
      audio.addEventListener("loadedmetadata", seekTo, { once: true });
    }
    setProgressMs(Math.max(0, Math.round(nextProgressMs)));
  }

  return { durationMs, onPause, onPlay, onSeek, progressMs, state };
}

export function downloadLocalPreviewFile(
  url: string,
  filename: string | undefined,
) {
  if (typeof document === "undefined") return;

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename?.trim() || "song";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
