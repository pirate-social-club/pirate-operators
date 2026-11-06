// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-capture-processor.ts; only imports changed.
/**
 * Phase 5.2.3 — the AudioWorklet processor. Runs in `AudioWorkletGlobalScope`
 * (NOT unit-testable under bun), so it is deliberately a THIN wrapper around the
 * fully-tested {@link KaraokeCaptureDsp}: it owns no DSP math, only the message
 * protocol with the main-thread {@link KaraokeMicCapture} engine.
 *
 * Engine → processor: `configure` | `activate` | `deactivate` | `stop`.
 * Processor → engine: `chunk` (transfers the PCM buffer) | `flushed` (ack).
 *
 * Loaded via `audioContext.audioWorklet.addModule(new URL('./karaoke-capture-processor.ts', import.meta.url))`.
 */

import { KaraokeCaptureDsp } from "../../../../packages/karaoke/capture-dsp.ts";

// Minimal ambient declarations for the AudioWorklet scope (not in the DOM lib).
declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare abstract class AudioWorkletProcessor {
  readonly port: {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    onmessage: ((event: { data: unknown }) => void) | null;
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

interface ConfigureMessage { type: "configure"; inputRate: number; chunkSamples?: number; halfTaps?: number }
interface ActivateMessage { type: "activate"; epoch: number; startTimeMs: number }
interface DeactivateMessage { type: "deactivate"; epoch: number }
interface StopMessage { type: "stop" }
type EngineMessage = ConfigureMessage | ActivateMessage | DeactivateMessage | StopMessage;

class KaraokeCaptureProcessor extends AudioWorkletProcessor {
  private inputRate = sampleRate;
  private chunkSamples: number | undefined;
  private halfTaps: number | undefined;
  private epoch = 0;
  private active = false;
  private stopped = false;
  private dsp: KaraokeCaptureDsp | null = null;
  private inputSamples = 0;
  private renderQuanta = 0;
  private outputSamples = 0;
  private firstInputMs: number | null = null;

  constructor() {
    super();
    this.port.onmessage = (event) => this.handle(event.data as EngineMessage);
  }

  private handle(message: EngineMessage): void {
    switch (message.type) {
      case "configure":
        this.inputRate = message.inputRate || sampleRate;
        this.chunkSamples = message.chunkSamples;
        this.halfTaps = message.halfTaps;
        break;
      case "activate":
        this.epoch = message.epoch;
        // The activate message can wait in a queue. Sample timestamps start at
        // the first input quantum that actually runs, not when it was posted.
        this.dsp = null;
        this.inputSamples = 0;
        this.renderQuanta = 0;
        this.outputSamples = 0;
        this.firstInputMs = null;
        this.active = true;
        break;
      case "deactivate":
        this.active = false;
        this.flushTail();
        this.port.postMessage({ epoch: message.epoch, type: "flushed" });
        this.dsp = null;
        break;
      case "stop":
        this.active = false;
        this.dsp = null;
        this.stopped = true;
        break;
    }
  }

  private flushTail(): void {
    if (!this.dsp) return;
    for (const chunk of this.dsp.flush()) {
      this.emitChunk(chunk);
    }
  }

  private emitChunk(chunk: { capturedAtMs: number; pcm16: ArrayBuffer }): void {
    this.outputSamples += chunk.pcm16.byteLength / 2;
    this.port.postMessage({
      capturedAtMs: chunk.capturedAtMs, epoch: this.epoch, pcm16: chunk.pcm16, type: "chunk",
      accounting: { renderQuanta: this.renderQuanta, inputSamples: this.inputSamples, outputSamples: this.outputSamples, firstInputMs: this.firstInputMs, inputRate: this.inputRate },
    }, [chunk.pcm16]);
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false; // terminate the processor
    if (!this.active) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0]?.length ?? 0;
    if (frames === 0) return true;
    if (!this.dsp) {
      this.firstInputMs = currentTime * 1000;
      this.dsp = new KaraokeCaptureDsp({
        chunkSamples: this.chunkSamples,
        halfTaps: this.halfTaps,
        inputRate: this.inputRate,
        startTimeMs: this.firstInputMs,
      });
    }
    this.renderQuanta += 1;
    this.inputSamples += frames;
    for (const chunk of this.dsp.processQuantum(input, frames)) {
      this.emitChunk(chunk);
    }
    return true;
  }
}

registerProcessor("karaoke-capture-processor", KaraokeCaptureProcessor);
