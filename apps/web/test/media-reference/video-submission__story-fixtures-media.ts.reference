import { ALL_FORMATS, BlobSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat, Output } from "mediabunny";

/** Local sample media for the authoring stories.
 *
 * Storybook has no camera, microphone or provider, so the stories stand in
 * generated media: a real tone for the song and a real canvas-encoded MP4 for
 * the take. Both are decodable by the browser, so playback, trimming and the
 * review preview can be inspected for real. This is simulated capture, not
 * device evidence: no camera, microphone, encoder or hardware clock is
 * involved, and real-device timing remains a separate acceptance step.
 */

const audioCache = new Map<number, string>();

/** A mono tone whose pitch steps every two seconds, so a moving excerpt sounds
 * different rather than merely looking different. */
export function toneWavUrl(durationMs: number): string {
  const cached = audioCache.get(durationMs);
  if (cached !== undefined) return cached;
  const rate = 8_000;
  const samples = Math.floor((durationMs / 1_000) * rate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, samples * 2, true);
  const scale = [220, 247, 277, 330, 370, 440];
  let phase = 0;
  for (let index = 0; index < samples; index += 1) {
    const bar = Math.floor((index / rate) * 1_000 / 2_000) % scale.length;
    phase += (2 * Math.PI * scale[bar]!) / rate;
    view.setInt16(44 + index * 2, Math.round(Math.sin(phase) * 0.25 * 32_767), true);
  }
  const url = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  audioCache.set(durationMs, url);
  return url;
}

const videoCache = new Map<string, Promise<File>>();

/** A real MP4 drawn on a canvas: a moving bar and a frame counter, dimmed
 * before `markerAtMs` and bright after, so a viewer can see whether a take
 * starts before or after the guide did. */
export function sampleVideoFile(durationMs = 12_000, markerAtMs = 0): Promise<File> {
  const key = `${durationMs}:${markerAtMs}`;
  const cached = videoCache.get(key);
  if (cached !== undefined) return cached;
  const pending = (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 426;
    const context = canvas.getContext("2d")!;
    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
      target,
    });
    const source = new CanvasSource(canvas, { codec: "avc", bitrate: 500_000, keyFrameInterval: 1 });
    output.addVideoTrack(source);
    await output.start();
    const frameRate = 12;
    const frameDuration = 1 / frameRate;
    const frames = Math.floor((durationMs / 1_000) * frameRate);
    for (let index = 0; index < frames; index += 1) {
      const atMs = index * frameDuration * 1_000;
      const beforeGuide = atMs < markerAtMs;
      context.fillStyle = beforeGuide ? "#101a2e" : "#0f2f22";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = beforeGuide ? "#3d5a80" : "#2dd4a7";
      const travel = (index / frames) * (canvas.width - 40);
      context.fillRect(travel, canvas.height - 90, 40, 40);
      context.fillStyle = "#ffffff";
      context.font = "20px monospace";
      context.fillText(`${(atMs / 1_000).toFixed(2)}s`, 12, 32);
      await source.add(index * frameDuration, frameDuration);
    }
    await output.finalize();
    if (!target.buffer) throw new Error("the sample video did not finalize");
    return new File([target.buffer], "sample-take.mp4", { type: "video/mp4" });
  })();
  videoCache.set(key, pending);
  return pending;
}

/** Reads a generated or aligned file's first frame timestamp and duration, for
 * story notes and tests that want to show the alignment. */
export async function readVideoFacts(file: File): Promise<{ durationMs: number; firstFrameMs: number }> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const duration = await input.computeDuration();
    const first = await input.getFirstTimestamp();
    return { durationMs: Math.round(duration * 1_000), firstFrameMs: Math.round(first * 1_000) };
  } finally {
    input.dispose();
  }
}
