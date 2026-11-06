// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-capture-dsp.test.ts; only imports changed.
import { describe, expect, test } from "./karaoke-expect.ts";

import {
  downmixToMono,
  floatToInt16,
  KaraokeCaptureChunker,
  KaraokeCaptureDsp,
  StreamingResampler,
} from "../packages/karaoke/capture-dsp.ts";

function sine(freqHz: number, rate: number, samples: number, amp = 0.8): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / rate);
  return out;
}

function rms(values: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i]! * values[i]!;
  return Math.sqrt(sum / Math.max(1, values.length));
}

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}

describe("downmixToMono", () => {
  test("passes a single channel through", () => {
    const mono = downmixToMono([new Float32Array([0.1, 0.2, 0.3])], 3);
    expect(Array.from(mono)).toEqual([0.1, 0.2, 0.3].map((v) => Math.fround(v)));
  });

  test("averages multiple channels", () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 0, 1]);
    expect(Array.from(downmixToMono([left, right], 3))).toEqual([0.5, 0, 0]);
  });
});

describe("floatToInt16", () => {
  test("scales, rounds, and clamps to int16 range", () => {
    const out = floatToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(out)).toEqual([0, 32767, -32767, 32767, -32767, Math.round(0.5 * 32767)]);
  });
});

describe("StreamingResampler", () => {
  test("is a passthrough when input rate equals output rate", () => {
    const r = new StreamingResampler({ inputRate: 16_000, outputRate: 16_000 });
    expect(r.isPassthrough).toBe(true);
    const input = sine(440, 16_000, 256);
    expect(Array.from(r.process(input))).toEqual(Array.from(input));
  });

  test("persistent state: many small blocks == one big block (continuity)", () => {
    const input = sine(1_000, 44_100, 4_096);

    const single = new StreamingResampler({ inputRate: 44_100 });
    const whole = single.process(input);

    const chunked = new StreamingResampler({ inputRate: 44_100 });
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 128) parts.push(chunked.process(input.subarray(i, i + 128)));
    const joined = concat(parts);

    expect(joined.length).toBe(whole.length);
    // Deterministic, state-preserving → effectively identical (allow fp noise).
    expect(maxAbsDiff(joined, whole) < 1e-6).toBe(true);
  });

  test("44.1kHz → 16kHz produces ~factor output samples over a long run", () => {
    const input = sine(1_000, 44_100, 44_100); // 1 s
    const out = new StreamingResampler({ inputRate: 44_100 }).process(input);
    const expected = 44_100 * (16_000 / 44_100); // = 16000
    expect(Math.abs(out.length - expected) < 100).toBe(true);
  });

  test("48kHz → 16kHz (integer ÷3) produces ~factor output samples", () => {
    const input = sine(1_000, 48_000, 48_000); // 1 s
    const out = new StreamingResampler({ inputRate: 48_000 }).process(input);
    expect(Math.abs(out.length - 16_000) < 100).toBe(true);
  });

  test("flush() drains the retained look-ahead tail without inventing post-signal audio", () => {
    const r = new StreamingResampler({ inputRate: 44_100 });
    const input = sine(1_000, 44_100, 4_096);
    const main = r.process(input);
    const tail = r.flush();
    expect(tail.length > 0).toBe(true); // recovered samples the sinc kernel was holding back
    const total = main.length + tail.length;
    expect(Math.abs(total - 4_096 * (16_000 / 44_100)) < 3).toBe(true); // ≈ inputs × factor
    expect(r.flush().length).toBe(0); // fully drained
  });

  test("anti-aliases: content above 8kHz is heavily attenuated vs a passband tone", () => {
    const samples = 44_100; // 1 s
    const pass = new StreamingResampler({ inputRate: 44_100, halfTaps: 24 }).process(sine(1_000, 44_100, samples));
    const stop = new StreamingResampler({ inputRate: 44_100, halfTaps: 24 }).process(sine(14_000, 44_100, samples));
    // Trim edges (startup transient) before measuring energy.
    const trim = (a: Float32Array) => a.subarray(200, a.length - 200);
    const passRms = rms(trim(pass));
    const stopRms = rms(trim(stop));
    expect(passRms > 0.3).toBe(true); // passband tone preserved (~0.8/√2)
    expect(stopRms < passRms * 0.15).toBe(true); // 14kHz rejected (well below Nyquist 8k)
  });
});

describe("KaraokeCaptureChunker", () => {
  test("emits fixed-size chunks and buffers the remainder", () => {
    const chunker = new KaraokeCaptureChunker({ chunkSamples: 1_600, startTimeMs: 1_000 });
    expect(chunker.push(new Int16Array(1_500))).toHaveLength(0); // partial held
    const chunks = chunker.push(new Int16Array(1_700)); // 1500+1700=3200 → 2 chunks, 0 remainder
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.pcm16.byteLength).toBe(3_200); // 1600 samples × 2 bytes
  });

  test("stamps the trailing edge from cumulative sample counts, not emit time", () => {
    const chunker = new KaraokeCaptureChunker({ chunkSamples: 1_600, startTimeMs: 1_000 });
    const first = chunker.push(new Int16Array(1_600))[0]!;
    const second = chunker.push(new Int16Array(1_600))[0]!;
    expect(first.capturedAtMs).toBe(1_100); // 1000 + 1600/16000 s
    expect(second.capturedAtMs).toBe(1_200);
    const tail = chunker.push(new Int16Array(800));
    expect(tail).toHaveLength(0);
    const flushed = chunker.flush()!;
    expect(flushed.capturedAtMs).toBe(1_250); // 1000 + (3200+800)/16000 s
    expect(flushed.pcm16.byteLength).toBe(1_600); // short final chunk (800 samples)
    expect(chunker.flush()).toBeNull();
  });
});

describe("KaraokeCaptureDsp.flush", () => {
  test("drains the resampler tail through the chunker and emits the partial chunk", () => {
    const dsp = new KaraokeCaptureDsp({ chunkSamples: 1_600, inputRate: 44_100, startTimeMs: 0 });
    // Feed less than one full chunk's worth so the tail lives in resampler + chunker.
    dsp.processQuantum([sine(1_000, 44_100, 2_000)], 2_000);
    const flushed = dsp.flush();
    expect(flushed.length > 0).toBe(true); // tail not lost
    const totalSamples = flushed.reduce((n, c) => n + c.pcm16.byteLength / 2, 0);
    expect(totalSamples > 0).toBe(true);
    expect(dsp.flush()).toEqual([]); // drained
  });
});

describe("KaraokeCaptureDsp (full pipeline)", () => {
  test("44.1kHz stereo quanta → 16kHz mono PCM16 chunks with monotonic trailing-edge timestamps", () => {
    const dsp = new KaraokeCaptureDsp({ inputRate: 44_100, startTimeMs: 2_000 });
    const total = 44_100; // ~1 s of audio fed 128 frames at a time
    const chunks = [] as { pcm16: ArrayBuffer; capturedAtMs: number }[];
    for (let i = 0; i < total; i += 128) {
      const frames = Math.min(128, total - i);
      const left = sine(1_000, 44_100, frames);
      const right = sine(1_000, 44_100, frames);
      chunks.push(...dsp.processQuantum([left, right], frames));
    }
    expect(chunks.length > 8).toBe(true); // ~1 s / 100 ms ≈ 9–10 full chunks
    for (const c of chunks) expect(c.pcm16.byteLength).toBe(3_200);
    // Trailing-edge timestamps are strictly increasing in ~100 ms steps from start.
    expect(chunks[0]!.capturedAtMs).toBe(2_100);
    let prev = chunks[0]!.capturedAtMs;
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.capturedAtMs - prev).toBe(100);
      prev = chunks[i]!.capturedAtMs;
    }
  });
});
