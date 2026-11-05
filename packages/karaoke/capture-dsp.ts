// Independently adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-capture-dsp.ts; see docs/karaoke-capture-handoff.md.
/**
 * Phase 5.2 capture DSP core — PURE, browser-independent (no AudioWorklet, no
 * AudioContext), so it is fully unit-testable off the worklet. The worklet
 * processor is a thin wrapper around this module (downmix → resample → Int16 →
 * trailing-edge chunking); see `web/docs/karaoke-audio-capture.md` §3–§4.
 *
 * Output is always PCM16 mono 16 kHz, the format the transport's `pushAudio`
 * expects. Chunk timestamps are derived from processed sample counts (NOT the
 * AudioContext time at emit), so accumulation latency is not folded into timing.
 */

const KARAOKE_CAPTURE_OUTPUT_RATE = 16_000 as const;
/** ~100 ms of 16 kHz mono PCM16 = 1600 samples (3200 bytes). */
export const KARAOKE_CAPTURE_CHUNK_SAMPLES = 1_600 as const;

/** Averages interleaved-by-channel Float32 frames down to a mono Float32Array. */
export function downmixToMono(channels: readonly Float32Array[], frames: number): Float32Array {
  const out = new Float32Array(frames);
  const channelCount = channels.length;
  if (channelCount === 0) return out;
  if (channelCount === 1) {
    out.set(channels[0]!.subarray(0, frames));
    return out;
  }
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channelCount; c += 1) sum += channels[c]![i] ?? 0;
    out[i] = sum / channelCount;
  }
  return out;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/** Blackman window over |x| <= halfTaps; 0 at the edges. */
function blackman(x: number, halfTaps: number): number {
  if (x <= -halfTaps || x >= halfTaps) return 0;
  const t = x / halfTaps; // [-1, 1]
  return 0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t);
}

export interface StreamingResamplerOptions {
  inputRate: number;
  outputRate?: number;
  /** Half kernel width in (output-domain) taps; larger = sharper, more CPU. */
  halfTaps?: number;
}

/**
 * Arbitrary-ratio streaming windowed-sinc resampler with **persistent phase +
 * filter state across calls** (so feeding N small blocks == feeding one big
 * block). When downsampling the kernel is stretched by the ratio so the cutoff
 * tracks `outputRate/2` — i.e. it anti-aliases below 8 kHz before decimation.
 * Linear interpolation / naive decimation would alias and is NOT used.
 */
export class StreamingResampler {
  readonly inputRate: number;
  readonly outputRate: number;
  private readonly halfTaps: number;
  private readonly filterScale: number; // < 1 when downsampling (lowers cutoff)
  private readonly halfWidthInput: number; // kernel half-width in input samples
  private readonly step: number; // input samples advanced per output sample
  // Precomputed windowed-sinc kernel, sampled `oversample` points per tap, so the
  // hot loop is table-lookup + linear interp (NO sin()/cos() per tap) — important
  // for real-time worklet cost (audit F4).
  private readonly oversample = 512;
  private readonly kernelTable: Float64Array;

  private history: number[] = []; // sliding window of input samples
  private historyBase = 0; // global input index of history[0]
  private inputPos = 0; // global (fractional) input index of the next output sample

  constructor(options: StreamingResamplerOptions) {
    this.inputRate = options.inputRate;
    this.outputRate = options.outputRate ?? KARAOKE_CAPTURE_OUTPUT_RATE;
    this.halfTaps = options.halfTaps ?? 16;
    const factor = this.outputRate / this.inputRate;
    this.filterScale = Math.min(1, factor);
    this.halfWidthInput = this.halfTaps / this.filterScale;
    this.step = this.inputRate / this.outputRate;
    const length = this.halfTaps * this.oversample + 2;
    const table = new Float64Array(length);
    for (let k = 0; k < length; k += 1) {
      const x = k / this.oversample;
      table[k] = sinc(x) * blackman(x, this.halfTaps);
    }
    this.kernelTable = table;
  }

  /** Whether this resampler is a no-op (input already at output rate). */
  get isPassthrough(): boolean {
    return this.inputRate === this.outputRate;
  }

  private kernel(x: number): number {
    // Even kernel → index by |x|; linear-interpolate the precomputed table.
    const xa = x < 0 ? -x : x;
    if (xa >= this.halfTaps) return 0;
    const pos = xa * this.oversample;
    const i = pos | 0;
    const frac = pos - i;
    const table = this.kernelTable;
    return table[i]! + (table[i + 1]! - table[i]!) * frac;
  }

  private sampleAt(p: number): number {
    const jStart = Math.ceil(p - this.halfWidthInput);
    const jEnd = Math.floor(p + this.halfWidthInput);
    let acc = 0;
    for (let j = jStart; j <= jEnd; j += 1) {
      const idx = j - this.historyBase;
      if (idx < 0 || idx >= this.history.length) continue; // edge: zero-padded
      acc += this.history[idx]! * this.kernel((p - j) * this.filterScale);
    }
    return acc * this.filterScale;
  }

  /** Feeds input samples, returns the output samples producible so far. */
  process(input: Float32Array): Float32Array {
    if (this.isPassthrough) return input.slice();
    for (let i = 0; i < input.length; i += 1) this.history.push(input[i]!);
    const lastAvailable = this.historyBase + this.history.length - 1;
    const out: number[] = [];
    while (this.inputPos + this.halfWidthInput <= lastAvailable) {
      out.push(this.sampleAt(this.inputPos));
      this.inputPos += this.step;
    }
    // Drop history that no future output can reference.
    const keepFrom = Math.floor(this.inputPos - this.halfWidthInput);
    const drop = keepFrom - this.historyBase;
    if (drop > 0) {
      this.history.splice(0, drop);
      this.historyBase += drop;
    }
    return Float32Array.from(out);
  }

  /**
   * Drains the samples the sinc kernel was holding for look-ahead, producing the
   * final outputs up to (and including) the LAST real input sample. The right tail
   * of the kernel is zero-padded for these last outputs — but we never advance
   * past the last real sample, so no post-signal silence is invented as audio
   * (audit F3). Leaves the resampler reset; call once at end-of-stream.
   */
  flush(): Float32Array {
    if (this.isPassthrough) return new Float32Array(0);
    const lastAvailable = this.historyBase + this.history.length - 1;
    const out: number[] = [];
    while (this.inputPos <= lastAvailable) {
      out.push(this.sampleAt(this.inputPos));
      this.inputPos += this.step;
    }
    this.reset();
    return Float32Array.from(out);
  }

  reset(): void {
    this.history = [];
    this.historyBase = 0;
    this.inputPos = 0;
  }
}

/** Converts Float32 [-1,1] to clamped Int16 (×32767, rounded). */
export function floatToInt16(input: Float32Array, out?: Int16Array): Int16Array {
  const result = out ?? new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i]!));
    result[i] = Math.round(clamped * 32767);
  }
  return result;
}

export interface KaraokeCaptureChunk {
  /** PCM16 mono 16 kHz, exactly `chunkSamples` samples (`chunkSamples*2` bytes). */
  pcm16: ArrayBuffer;
  /** Capture-clock ms of the chunk's TRAILING edge (last sample), from sample counts. */
  capturedAtMs: number;
}

export interface KaraokeCaptureChunkerOptions {
  outputRate?: number;
  chunkSamples?: number;
  /** Capture-clock ms when the first output sample was captured (the activation anchor). */
  startTimeMs: number;
}

/**
 * Accumulates resampled Int16 samples into fixed-size chunks and stamps each with
 * a trailing-edge capture time derived from the cumulative output-sample count
 * (`startTimeMs + producedSamples / outputRate`), never the emit-time clock.
 */
export class KaraokeCaptureChunker {
  private readonly outputRate: number;
  private readonly chunkSamples: number;
  private readonly startTimeMs: number;
  private pending: number[] = [];
  private producedSamples = 0; // cumulative output samples committed to emitted chunks

  constructor(options: KaraokeCaptureChunkerOptions) {
    this.outputRate = options.outputRate ?? KARAOKE_CAPTURE_OUTPUT_RATE;
    this.chunkSamples = options.chunkSamples ?? KARAOKE_CAPTURE_CHUNK_SAMPLES;
    this.startTimeMs = options.startTimeMs;
  }

  private makeChunk(samples: number[]): KaraokeCaptureChunk {
    const pcm = new Int16Array(samples);
    this.producedSamples += samples.length;
    return {
      capturedAtMs: this.startTimeMs + (this.producedSamples / this.outputRate) * 1000,
      pcm16: pcm.buffer,
    };
  }

  /** Adds samples, returning any complete chunks (partial remainder stays buffered). */
  push(samples: Int16Array): KaraokeCaptureChunk[] {
    const chunks: KaraokeCaptureChunk[] = [];
    for (let i = 0; i < samples.length; i += 1) {
      this.pending.push(samples[i]!);
      if (this.pending.length === this.chunkSamples) {
        chunks.push(this.makeChunk(this.pending));
        this.pending = [];
      }
    }
    return chunks;
  }

  /** Emits any buffered remainder as a final (short) chunk; null if none. */
  flush(): KaraokeCaptureChunk | null {
    if (this.pending.length === 0) return null;
    const chunk = this.makeChunk(this.pending);
    this.pending = [];
    return chunk;
  }

  reset(): void {
    this.pending = [];
    this.producedSamples = 0;
  }
}

export interface KaraokeCaptureDspOptions {
  inputRate: number;
  outputRate?: number;
  chunkSamples?: number;
  halfTaps?: number;
  /** Capture-clock ms at activation (the first source sample's time). */
  startTimeMs: number;
}

/**
 * The full per-quantum pipeline the worklet runs: downmix → resample (persistent
 * state) → Int16 → trailing-edge chunking. Pure and deterministic.
 */
export class KaraokeCaptureDsp {
  private readonly resampler: StreamingResampler;
  private readonly chunker: KaraokeCaptureChunker;

  constructor(options: KaraokeCaptureDspOptions) {
    const outputRate = options.outputRate ?? KARAOKE_CAPTURE_OUTPUT_RATE;
    this.resampler = new StreamingResampler({
      halfTaps: options.halfTaps,
      inputRate: options.inputRate,
      outputRate,
    });
    this.chunker = new KaraokeCaptureChunker({
      chunkSamples: options.chunkSamples,
      outputRate,
      startTimeMs: options.startTimeMs,
    });
  }

  processQuantum(channels: readonly Float32Array[], frames: number): KaraokeCaptureChunk[] {
    const mono = downmixToMono(channels, frames);
    const resampled = this.resampler.process(mono);
    if (resampled.length === 0) return [];
    return this.chunker.push(floatToInt16(resampled));
  }

  /**
   * End-of-stream flush (deactivate/seek/finish): drains the resampler's retained
   * tail through the chunker, then emits any partial chunk — so the final
   * filter-width of audio is NOT lost (audit F3). Returns all resulting chunks.
   */
  flush(): KaraokeCaptureChunk[] {
    const chunks: KaraokeCaptureChunk[] = [];
    const tail = this.resampler.flush();
    if (tail.length > 0) chunks.push(...this.chunker.push(floatToInt16(tail)));
    const remainder = this.chunker.flush();
    if (remainder) chunks.push(remainder);
    return chunks;
  }
}
