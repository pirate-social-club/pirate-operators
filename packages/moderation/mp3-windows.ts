// Independently owned adaptation of api-next a5c63b8db01d4359344d33c31d294a00fbeadb20.
// Source digest and selected boundaries: docs/moderation-source-provenance.json.
import {
  Mp3WindowFailure,
  StreamBytes,
  parseMp3Frame,
  synchsafe,
  type Mp3Frame,
  type Mp3FrameWindow,
} from "./mp3-frames.ts";
import { insist } from "../community/common.ts";
const MAXIMUM_INITIAL_SCAN_BYTES = 64 * 1024;
const AUDIO_MPEG = "audio/mpeg";
export interface Mp3Probe {
  version: "media-transform-probe-v1";
  durationMs: number;
  container: "mp3";
  mimeType: "audio/mpeg";
  tracks: {
    kind: "audio";
    codec: "mp3";
    channels: 1 | 2;
    sampleRateHz: number;
    bitrateBps: number;
    bitrateMode: "variable" | "constant";
  }[];
}
export function sampleWindow(
  durationMs: number,
  variant: "primary" | "alternate",
) {
  insist(
    Number.isSafeInteger(durationMs) && durationMs > 0 && durationMs <= 3600000,
    "invalid_mp3_duration",
  );
  const duration = Math.min(durationMs, 12000);
  return {
    offsetMs: Math.floor(
      Math.max(0, durationMs - duration) *
        (variant === "primary" ? 0.25 : 0.75),
    ),
    durationMs: duration,
  };
}
/** Probe one sealed MP3 by walking every complete frame. */
export async function readMp3Probe(
  stream: ReadableStream<Uint8Array>,
  maximumDurationMs: number,
  signal: AbortSignal,
): Promise<Mp3Probe> {
  const reader = new StreamBytes(stream, signal);
  let durationMs = 0;
  let audioBytes = 0;
  let frames = 0;
  let first: Mp3Frame | null = null;
  let variableBitrate = false;
  try {
    await discardId3(reader);
    let scanned = 0;
    while (true) {
      if (!(await reader.ensure(4)))
        throw new Mp3WindowFailure("unsupported_codec");
      if (parseMp3Frame(reader.view(4)) !== null) break;
      reader.discard(1);
      scanned += 1;
      if (scanned > MAXIMUM_INITIAL_SCAN_BYTES) {
        throw new Mp3WindowFailure("unsupported_codec");
      }
    }

    while (true) {
      if (!(await reader.ensure(4))) {
        if (reader.available === 0 && frames > 0) break;
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      const header = reader.view(4);
      const frame = parseMp3Frame(header);
      if (frame === null) {
        if (header[0] === 0x54 && header[1] === 0x41 && header[2] === 0x47) {
          if (!(await reader.ensure(128))) {
            throw new Mp3WindowFailure("inconsistent_media_facts");
          }
          reader.discard(128);
          if ((await reader.ensure(1)) || reader.available !== 0) {
            throw new Mp3WindowFailure("inconsistent_media_facts");
          }
          break;
        }
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      if (
        first !== null &&
        (frame.version !== first.version ||
          frame.sampleRateHz !== first.sampleRateHz ||
          frame.channels !== first.channels)
      ) {
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      first ??= frame;
      variableBitrate ||= frame.bitrateBps !== first.bitrateBps;
      if (!(await reader.ensure(frame.byteLength))) {
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      reader.discard(frame.byteLength);
      frames += 1;
      audioBytes += frame.byteLength;
      durationMs += frame.durationMs;
      if (durationMs > maximumDurationMs) {
        throw new Mp3WindowFailure("duration_exceeded");
      }
    }
  } finally {
    await reader.cancel("probe_complete");
    reader.release();
  }

  if (first === null || frames === 0 || durationMs <= 0) {
    throw new Mp3WindowFailure("unsupported_codec");
  }
  return {
    version: "media-transform-probe-v1",
    durationMs: Math.round(durationMs),
    container: "mp3",
    mimeType: AUDIO_MPEG,
    tracks: [
      {
        kind: "audio",
        codec: "mp3",
        channels: first.channels,
        sampleRateHz: first.sampleRateHz,
        bitrateBps: variableBitrate
          ? Math.round((audioBytes * 8 * 1_000) / durationMs)
          : first.bitrateBps,
        bitrateMode: variableBitrate ? "variable" : "constant",
      },
    ],
  };
}

async function discardId3(reader: StreamBytes): Promise<void> {
  if (!(await reader.ensure(10)))
    throw new Mp3WindowFailure("unsupported_codec");
  const header = reader.view(10);
  if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) return;
  const tagBytes = synchsafe(header, 6);
  if (tagBytes === null) throw new Mp3WindowFailure("unsupported_codec");
  const footerBytes = ((header[5] ?? 0) & 0x10) === 0 ? 0 : 10;
  let remaining = 10 + tagBytes + footerBytes;
  while (remaining > 0) {
    if (!(await reader.ensure(1)))
      throw new Mp3WindowFailure("unsupported_codec");
    const selected = Math.min(remaining, reader.available);
    reader.discard(selected);
    remaining -= selected;
  }
}

function joinBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Select a target-duration MP3 window using complete source frames only. */
export async function readMp3FrameWindow(
  stream: ReadableStream<Uint8Array>,
  sourceDurationMs: number,
  variant: "primary" | "alternate",
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Mp3FrameWindow> {
  const window = sampleWindow(sourceDurationMs, variant);
  const reader = new StreamBytes(stream, signal);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let elapsedMs = 0;
  let selectedOffsetMs: number | null = null;
  let selectedDurationMs = 0;
  let expected: Pick<Mp3Frame, "channels" | "sampleRateHz" | "version"> | null =
    null;
  let completed = false;
  let frameIndex = 0,
    firstFrame = 0,
    frameCount = 0;
  try {
    await discardId3(reader);
    let scanned = 0;
    while (true) {
      if (!(await reader.ensure(4)))
        throw new Mp3WindowFailure("unsupported_codec");
      if (parseMp3Frame(reader.view(4)) !== null) break;
      reader.discard(1);
      scanned += 1;
      if (scanned > MAXIMUM_INITIAL_SCAN_BYTES) {
        throw new Mp3WindowFailure("unsupported_codec");
      }
    }

    while (true) {
      if (!(await reader.ensure(4)))
        throw new Mp3WindowFailure("inconsistent_media_facts");
      const frame = parseMp3Frame(reader.view(4));
      if (frame === null)
        throw new Mp3WindowFailure("inconsistent_media_facts");
      if (
        expected !== null &&
        (frame.version !== expected.version ||
          frame.sampleRateHz !== expected.sampleRateHz ||
          frame.channels !== expected.channels)
      ) {
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      expected ??= frame;
      if (!(await reader.ensure(frame.byteLength))) {
        throw new Mp3WindowFailure("inconsistent_media_facts");
      }
      const frameEndMs = elapsedMs + frame.durationMs;
      if (frameEndMs > window.offsetMs) {
        if (selectedOffsetMs === null) firstFrame = frameIndex;
        selectedOffsetMs ??= elapsedMs;
        frameCount++;
        byteLength += frame.byteLength;
        if (byteLength > maximumBytes)
          throw new Mp3WindowFailure("output_too_large");
        chunks.push(reader.take(frame.byteLength));
        selectedDurationMs += frame.durationMs;
        if (
          selectedDurationMs >= window.durationMs ||
          (sourceDurationMs <= 12000 &&
            Math.round(selectedDurationMs) >= sourceDurationMs)
        ) {
          completed = true;
          await reader.cancel("sample_complete");
          return {
            bytes: joinBytes(chunks, byteLength),
            durationMs: Math.round(selectedDurationMs),
            offsetMs: Math.round(selectedOffsetMs),
            firstFrame,
            frameCount,
          };
        }
      } else {
        reader.discard(frame.byteLength);
      }
      elapsedMs = frameEndMs;
      frameIndex++;
    }
  } finally {
    if (!completed) await reader.cancel("sample_failed");
    reader.release();
  }
}
