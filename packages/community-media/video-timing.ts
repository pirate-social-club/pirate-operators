import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireMedia } from "./validation.ts";
const exec = promisify(execFile);
interface DecodedFrame {
  best_effort_timestamp_time?: string;
  pkt_duration_time?: string;
  duration_time?: string;
}

/** Decode the selected video stream. Audio/container duration is never a
 * proxy for visual coverage; frame PTS and packet duration prove its timeline. */
export async function verifyVideoTiming(
  path: string,
  seconds: number,
  kind: "source" | "rendition",
  ffprobe = "ffprobe",
) {
  const { stdout } = await exec(
    ffprobe,
    [
      "-v",
      "error",
      "-threads",
      "1",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "mov,matroska,webm",
      "-select_streams",
      "v:0",
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp_time,pkt_duration_time,duration_time",
      "-of",
      "json",
      path,
    ],
    { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const frames =
    (JSON.parse(stdout) as { frames?: DecodedFrame[] }).frames ?? [];
  const error =
    kind === "source"
      ? "media_video_too_short"
      : "media_rendition_video_invalid";
  requireMedia(frames.length >= 2, error, 422);
  const timestamps = frames.map((frame) =>
    Number(frame.best_effort_timestamp_time),
  );
  requireMedia(timestamps.every(Number.isFinite), error, 422);
  const deltas = timestamps.slice(1).map((time, i) => time - timestamps[i]!);
  requireMedia(
    deltas.every((delta) => delta > 0),
    error,
    422,
  );
  const nominal = [...deltas].sort((a, b) => a - b)[
    Math.floor(deltas.length / 2)
  ]!;
  const durations = frames.map((frame) => {
    const observed = Number(frame.duration_time ?? frame.pkt_duration_time);
    return Number.isFinite(observed) && observed > 0 ? observed : nominal;
  });
  const start = timestamps[0]!,
    end = timestamps.at(-1)! + durations.at(-1)!;
  const tolerance = 0.04;
  requireMedia(
    start >= -tolerance &&
      start <= tolerance &&
      deltas.every((delta, i) => delta <= durations[i]! + tolerance) &&
      end + tolerance >= seconds &&
      (kind === "source" || Math.abs(end - seconds) <= tolerance),
    error,
    422,
  );
  return {
    startSeconds: start,
    endSeconds: end,
    durationMs: Math.round((end - start) * 1000),
  };
}
