/** Node-only community processor. Never import into a Worker bundle. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  MediaProcessor,
  MediaRecord,
  PublishedMediaSong,
} from "./contracts.ts";
import { MAX_MEDIA_BYTES, requireMedia, sha256 } from "./validation.ts";
import { verifyVideoTiming } from "./video-timing.ts";
const exec = promisify(execFile);
interface Probe {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    duration?: string;
  }[];
  format: { duration: string };
}
export interface FFmpegMediaOptions {
  /** Private work directory, supplied by the community operator. */
  tempRoot: string;
  /** Exact published song bytes, from a server-owned verified reader. */
  loadSong(song: PublishedMediaSong): Promise<Uint8Array>;
  ffmpeg?: string;
  ffprobe?: string;
}
export class FFmpegMediaProcessor implements MediaProcessor {
  readonly options: FFmpegMediaOptions;
  constructor(options: FFmpegMediaOptions) {
    this.options = options;
  }
  async probe(path: string): Promise<Probe> {
    const { stdout } = await exec(
      this.options.ffprobe ?? "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm,wav,mp3,flac,ogg",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,duration:format=duration",
        "-of",
        "json",
        path,
      ],
      { timeout: 15_000, maxBuffer: 128 * 1024 },
    );
    return JSON.parse(stdout) as Probe;
  }
  async render(
    source: Uint8Array,
    media: MediaRecord,
    song: PublishedMediaSong,
  ) {
    requireMedia(
      source.byteLength <= MAX_MEDIA_BYTES &&
        (await sha256(source)) === media.recordingSha256,
      "media_recording_mismatch",
      422,
    );
    const audio = await this.options.loadSong(song);
    requireMedia(
      audio.byteLength <= 25 * 1024 * 1024 &&
        (await sha256(audio)) === media.audioSha256 &&
        song.audioSha256 === media.audioSha256,
      "media_song_audio_mismatch",
      422,
    );
    const dir = await mkdtemp(join(this.options.tempRoot, "community-media-"));
    try {
      const original = join(dir, "recording"),
        canonical = join(dir, "song"),
        output = join(dir, "rendition.mp4");
      await writeFile(original, source, { mode: 0o600 });
      await writeFile(canonical, audio, { mode: 0o600 });
      const videoProbe = await this.probe(original),
        audioProbe = await this.probe(canonical);
      const video = videoProbe.streams.find((s) => s.codec_type === "video"),
        duration = media.durationSamples / 48_000;
      requireMedia(
        video &&
          (video.width ?? 0) > 0 &&
          (video.height ?? 0) > 0 &&
          (video.width ?? 0) <= 4096 &&
          (video.height ?? 0) <= 4096,
        "media_video_invalid",
        422,
      );
      requireMedia(
        audioProbe.streams.some((s) => s.codec_type === "audio") &&
          Number(audioProbe.format.duration) + 0.04 >=
            (media.startSample + media.durationSamples) / 48_000,
        "media_source_too_short",
        422,
      );
      await verifyVideoTiming(
        original,
        duration,
        "source",
        this.options.ffprobe,
      );
      // Finite duration, protocols and formats, single thread and timeout bound
      // untrusted input. Source audio and all metadata are deliberately omitted.
      await exec(
        this.options.ffmpeg ?? "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-threads",
          "1",
          "-protocol_whitelist",
          "file,pipe",
          "-format_whitelist",
          "mov,matroska,webm",
          "-i",
          original,
          "-ss",
          String(media.startSample / 48_000),
          "-protocol_whitelist",
          "file,pipe",
          "-format_whitelist",
          "mov,matroska,webm,wav,mp3,flac,ogg",
          "-i",
          canonical,
          "-t",
          String(duration),
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-map_metadata",
          "-1",
          "-map_chapters",
          "-1",
          "-vf",
          "scale=w='min(720,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
          "-c:v",
          "libx264",
          "-threads",
          "1",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
          "-r",
          "30",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-movflags",
          "+faststart",
          "-fs",
          String(MAX_MEDIA_BYTES),
          output,
        ],
        { timeout: 60_000, maxBuffer: 128 * 1024 },
      );
      const bytes = new Uint8Array(await readFile(output)),
        probe = await this.probe(output);
      const rendered = probe.streams.find((s) => s.codec_type === "video"),
        sound = probe.streams.find((s) => s.codec_type === "audio");
      requireMedia(
        rendered?.codec_name === "h264" && sound?.codec_name === "aac",
        "media_rendition_invalid",
        422,
      );
      const timing = await verifyVideoTiming(
        output,
        duration,
        "rendition",
        this.options.ffprobe,
      );
      return {
        bytes,
        facts: {
          sha256: await sha256(bytes),
          bytes: bytes.byteLength,
          durationMs: timing.durationMs,
          width: rendered.width!,
          height: rendered.height!,
          videoCodec: "h264" as const,
          audioCodec: "aac" as const,
        },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
