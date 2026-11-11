// Video poster frame extraction, ported verbatim from the React
// video-poster-frame.ts. Framework-free DOM/canvas code; only `dataUrlToBlob`
// is exercised by the offline unit tests.

export type ExtractedVideoPosterFrame = {
  dataUrl: string;
  frameMs: number;
  height: number;
  width: number;
};

type VideoPosterFrameOptions = {
  maxWidth?: number;
};

function parsePosterFrameSeconds(value: string | undefined): number {
  const parsed = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: "loadeddata" | "loadedmetadata" | "seeked",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleEvent = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Could not read the selected video frame."));
    };
    const cleanup = () => {
      video.removeEventListener(eventName, handleEvent);
      video.removeEventListener("error", handleError);
    };
    video.addEventListener(eventName, handleEvent, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

function isBlankFrame(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return false;

  const sampleWidth = Math.min(64, canvas.width);
  const sampleHeight = Math.min(64, canvas.height);
  if (sampleWidth <= 0 || sampleHeight <= 0) return false;

  const image = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let totalLuma = 0;
  let brightPixels = 0;
  const pixelCount = image.length / 4;

  for (let index = 0; index < image.length; index += 4) {
    const luma =
      0.2126 * image[index]! +
      0.7152 * image[index + 1]! +
      0.0722 * image[index + 2]!;
    totalLuma += luma;
    if (luma > 24) brightPixels += 1;
  }

  return totalLuma / pixelCount < 10 && brightPixels / pixelCount < 0.01;
}

async function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  const target = Math.max(0, seconds);
  if (Math.abs(video.currentTime - target) < 0.01) return;
  video.currentTime = target;
  await waitForVideoEvent(video, "seeked");
}

function candidateSeconds(duration: number, selectedSeconds: number): number[] {
  const rawCandidates =
    selectedSeconds > 0
      ? [selectedSeconds]
      : [0, 0.5, 1, 2, duration * 0.1, duration * 0.25];

  return Array.from(
    new Set(
      rawCandidates.reduce<number[]>((result, candidate) => {
        if (Number.isFinite(candidate) && candidate >= 0) {
          const clampedCandidate = Math.min(Math.max(0, duration), candidate);
          result.push(Math.round(clampedCandidate * 10) / 10);
        }
        return result;
      }, []),
    ),
  );
}

interface PosterFrame {
  canvas: HTMLCanvasElement;
  height: number;
  width: number;
}

function drawPosterFrame(
  video: HTMLVideoElement,
  maxWidth: number | undefined,
): PosterFrame {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error("Could not read the selected video frame.");
  }

  const scale = maxWidth && sourceWidth > maxWidth ? maxWidth / sourceWidth : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not prepare the selected video frame.");
  }
  context.drawImage(
    video,
    0,
    0,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height,
  );
  return { canvas, height, width };
}

export function dataUrlToBlob(
  dataUrl: string,
  fallbackType = "application/octet-stream",
): Blob {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) {
    throw new Error("Could not save the selected video frame.");
  }

  const mimeType = match[1] || fallbackType;
  const isBase64 = match[2] === ";base64";
  const body = match[3] ?? "";

  if (!isBase64) {
    return new Blob([decodeURIComponent(body)], { type: mimeType });
  }

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

async function extractVideoPosterFrameFromObjectUrl(
  objectUrl: string,
  frameSeconds: string | undefined,
  options: VideoPosterFrameOptions = {},
): Promise<ExtractedVideoPosterFrame> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";

  try {
    video.src = objectUrl;
    await waitForVideoEvent(video, "loadedmetadata");
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForVideoEvent(video, "loadeddata");
    }

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const selectedSeconds = Math.min(
      Math.max(0, duration),
      parsePosterFrameSeconds(frameSeconds),
    );
    let fallback: ExtractedVideoPosterFrame | null = null;

    for (const seconds of candidateSeconds(duration, selectedSeconds)) {
      await seekTo(video, seconds);
      const { canvas, height, width } = drawPosterFrame(
        video,
        options.maxWidth,
      );
      const frame: ExtractedVideoPosterFrame = {
        dataUrl: canvas.toDataURL("image/jpeg", 0.9),
        frameMs: Math.round(seconds * 1000),
        height,
        width,
      };

      if (!fallback) fallback = frame;
      if (!isBlankFrame(canvas)) return frame;
      if (selectedSeconds > 0) return frame;
    }

    if (fallback) return fallback;
    throw new Error("Could not save the selected video frame.");
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export async function extractVideoPosterFrameDataUrl(
  file: File,
  frameSeconds: string | undefined,
  options: VideoPosterFrameOptions = {},
): Promise<ExtractedVideoPosterFrame> {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await extractVideoPosterFrameFromObjectUrl(
      objectUrl,
      frameSeconds,
      options,
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function extractVideoPosterFrameSourceDataUrl(
  src: string,
  frameSeconds: string | undefined,
  options: VideoPosterFrameOptions = {},
): Promise<ExtractedVideoPosterFrame> {
  return await extractVideoPosterFrameFromObjectUrl(src, frameSeconds, options);
}

async function extractVideoPosterFrameFile(
  file: File,
  frameSeconds: string | undefined,
  options: VideoPosterFrameOptions = {},
): Promise<ExtractedVideoPosterFrame & { file: File }> {
  const frame = await extractVideoPosterFrameDataUrl(
    file,
    frameSeconds,
    options,
  );
  const blob = dataUrlToBlob(frame.dataUrl, "image/jpeg");
  return {
    ...frame,
    file: new File(
      [blob],
      `${file.name.replace(/\.[^.]+$/, "") || "video"}-cover-frame.jpg`,
      {
        type: "image/jpeg",
      },
    ),
  };
}
