// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-mic-capture.test.ts; only imports changed.
import { describe, expect, test } from "./karaoke-expect.ts";

import {
  KaraokeMicCapture,
  KaraokeMicError,
  type KaraokeMicCaptureDeps,
} from "../packages/karaoke/mic-capture.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class FakeTimers {
  private timers: { id: number; cb: () => void }[] = [];
  private id = 0;
  setTimer = (cb: () => void): unknown => {
    this.id += 1;
    this.timers.push({ cb, id: this.id });
    return this.id;
  };
  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle);
  };
  fire(): void {
    const pending = this.timers;
    this.timers = [];
    for (const t of pending) t.cb();
  }
}

class FakePort {
  readonly posted: Record<string, unknown>[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage(message: unknown): void {
    this.posted.push(message as Record<string, unknown>);
  }
  /** Simulate the worklet posting a message back to the engine. */
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
  postedOfType(type: string): Record<string, unknown>[] {
    return this.posted.filter((m) => m.type === type);
  }
}

class FakeTrack {
  stopped = false;
  onended: ((event?: unknown) => void) | null = null;
  stop(): void {
    this.stopped = true;
  }
}
class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}
class FakeSource {
  connected = false;
  disconnected = false;
  connect(): void {
    this.connected = true;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}
class FakeNode {
  readonly port = new FakePort();
  disconnected = false;
  connect(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}
class FakeContext {
  sampleRate = 44_100;
  currentTime = 5; // → captureClockMs 5000
  destination = {};
  closed = false;
  resumed = false;
  readonly source = new FakeSource();
  resume(): Promise<void> {
    this.resumed = true;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  createMediaStreamSource(): FakeSource {
    return this.source;
  }
}

interface Harness {
  capture: KaraokeMicCapture;
  chunks: { pcm16: ArrayBuffer; capturedAtMs: number }[];
  errors: { code: string; message: string }[];
  node: FakeNode;
  context: FakeContext;
  stream: FakeStream;
  timers: FakeTimers;
}

function harness(overrides: Partial<KaraokeMicCaptureDeps> & { getUserMedia?: KaraokeMicCaptureDeps["getUserMedia"] } = {}): Harness {
  const node = new FakeNode();
  const context = new FakeContext();
  const stream = new FakeStream();
  const chunks: Harness["chunks"] = [];
  const errors: Harness["errors"] = [];
  const timers = new FakeTimers();

  const deps: KaraokeMicCaptureDeps = {
    addWorkletModule: overrides.addWorkletModule ?? (async () => {}),
    createContext: overrides.createContext ?? (() => context),
    createWorkletNode: overrides.createWorkletNode ?? (() => node),
    getUserMedia: overrides.getUserMedia ?? (async () => stream),
    releaseContext: overrides.releaseContext,
  };

  const capture = new KaraokeMicCapture({
    clearTimer: timers.clearTimer,
    deps,
    flushTimeoutMs: 1_000,
    onChunk: (pcm16, capturedAtMs) => chunks.push({ capturedAtMs, pcm16 }),
    onError: (error) => errors.push(error),
    setTimer: timers.setTimer,
  });

  return { capture, chunks, context, errors, node, stream, timers };
}

function chunkMsg(epoch: number, capturedAtMs = 100): unknown {
  return { capturedAtMs, epoch, pcm16: new Int16Array(1_600).buffer, type: "chunk" };
}

describe("KaraokeMicCapture", () => {
  test("start() wires the graph, configures the worklet, and begins INACTIVE", async () => {
    const h = harness();
    await h.capture.start();
    expect(h.context.source.connected).toBe(true);
    const configure = h.node.port.postedOfType("configure");
    expect(configure).toHaveLength(1);
    expect(configure[0]!.inputRate).toBe(44_100);
    // Inactive: a chunk arriving before activate() is dropped (epoch 0 never emitted).
    h.node.port.emit(chunkMsg(0));
    expect(h.chunks).toHaveLength(0);
    expect(h.node.port.postedOfType("activate")).toHaveLength(0);
  });

  test("start() requests RAW mic constraints (no echo cancellation / noise suppression / AGC) so the sung vocal reaches the STT", async () => {
    let captured: unknown = null;
    const h = harness({
      getUserMedia: async (constraints) => {
        captured = constraints;
        return new FakeStream();
      },
    });
    await h.capture.start();
    // Voice-call DSP suppresses singing over an instrumental (echoCancellation
    // removes playback-correlated audio incl. the vocal; noiseSuppression strips
    // sustained tones) — it must be off for karaoke scoring to receive real audio.
    expect(captured).toEqual({
      audio: {
        autoGainControl: false,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
      },
    });
  });

  test("activate() bumps the epoch and forwards only current-epoch chunks", async () => {
    const h = harness();
    await h.capture.start();
    await h.capture.activate();
    const activate = h.node.port.postedOfType("activate");
    expect(activate).toHaveLength(1);
    expect(activate[0]!.epoch).toBe(1);
    expect(activate[0]!.startTimeMs).toBe(5_000); // currentTime 5 × 1000

    h.node.port.emit(chunkMsg(1, 5_100)); // current epoch → forwarded
    h.node.port.emit(chunkMsg(0)); // stale → dropped
    h.node.port.emit(chunkMsg(2)); // future/mismatched → dropped
    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0]!.capturedAtMs).toBe(5_100);
  });

  test("deactivateAndFlush() resolves only after the worklet's flush ack; the tail chunk is forwarded", async () => {
    const h = harness();
    await h.capture.start();
    await h.capture.activate();

    let resolved = false;
    const flush = h.capture.deactivateAndFlush().then(() => {
      resolved = true;
    });
    expect(h.node.port.postedOfType("deactivate")).toHaveLength(1);
    await tick();
    expect(resolved).toBe(false); // still awaiting the ack

    h.node.port.emit(chunkMsg(1, 5_200)); // tail flush chunk (current epoch) still forwarded
    h.node.port.emit({ epoch: 1, type: "flushed" });
    await flush;
    expect(resolved).toBe(true);
    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0]!.capturedAtMs).toBe(5_200);
  });

  test("deactivateAndFlush() resolves (with an error) if the flush ack times out", async () => {
    const h = harness();
    await h.capture.start();
    await h.capture.activate();
    let resolved = false;
    const flush = h.capture.deactivateAndFlush().then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(false);
    h.context.currentTime += 1.1;
    h.timers.fire(); // a full second of rendering elapsed without an ack
    await flush;
    expect(resolved).toBe(true);
    expect(h.errors.some((e) => e.message.includes("flush ack"))).toBe(true);
  });

  test("a frozen render clock retains the flush tail across an output interruption", async () => {
    const h = harness();
    await h.capture.start(); await h.capture.activate();
    let resolved = false;
    const flush = h.capture.deactivateAndFlush().then(() => { resolved = true; });
    h.timers.fire(); h.timers.fire(); await tick();
    expect(resolved).toBe(false);
    expect(h.errors).toHaveLength(0);
    h.context.currentTime += 0.2;
    h.node.port.emit(chunkMsg(1, 5200));
    h.node.port.emit({ epoch: 1, type: "flushed" });
    await flush;
    expect(h.chunks[0]?.capturedAtMs).toBe(5200);
    expect(h.errors).toHaveLength(0);
    await h.capture.stop();
  });

  test("stopping during a frozen-clock flush resolves the wait and releases the microphone", async () => {
    const h = harness();
    await h.capture.start(); await h.capture.activate();
    const flush = h.capture.deactivateAndFlush();
    h.timers.fire(); await h.capture.stop(); await flush;
    h.timers.fire();
    expect(h.errors).toHaveLength(0);
    expect(h.stream.tracks[0]?.stopped).toBe(true);
  });

  test("stop() makes activate() a permanent no-op, tears down tracks/context, and drops later chunks", async () => {
    const h = harness();
    await h.capture.start();
    await h.capture.activate();
    await h.capture.stop();

    expect(h.stream.tracks[0]!.stopped).toBe(true);
    expect(h.context.closed).toBe(true);

    await h.capture.activate(); // must NOT re-activate after stop
    expect(h.node.port.postedOfType("activate")).toHaveLength(1); // only the pre-stop activate

    h.node.port.emit(chunkMsg(1)); // any late chunk is dropped
    expect(h.chunks).toHaveLength(0);
  });

  test("maps getUserMedia rejections to typed errors and reports them", async () => {
    const denied = Object.assign(new Error("no"), { name: "NotAllowedError" });
    const h = harness({ getUserMedia: async () => { throw denied; } });
    let thrown: unknown;
    try {
      await h.capture.start();
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof KaraokeMicError).toBe(true);
    expect((thrown as KaraokeMicError).code).toBe("permission_denied");
    expect(h.errors[0]!.code).toBe("permission_denied");
  });

  test("a worklet module failure reports worklet_unavailable and fully cleans up the graph", async () => {
    const h = harness({ addWorkletModule: () => { throw new Error("addModule failed"); } });
    let thrown: unknown;
    try {
      await h.capture.start();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as KaraokeMicError).code).toBe("worklet_unavailable");
    expect(h.stream.tracks[0]!.stopped).toBe(true);
    expect(h.context.closed).toBe(true); // context not leaked (audit F2)
  });

  test("a graph failure AFTER context creation still closes the context (no leak)", async () => {
    const h = harness({ createWorkletNode: () => { throw new Error("node construction failed"); } });
    let thrown: unknown;
    try {
      await h.capture.start();
    } catch (error) {
      thrown = error;
    }
    expect((thrown as KaraokeMicError).code).toBe("worklet_unavailable");
    expect(h.context.closed).toBe(true);
    expect(h.stream.tracks[0]!.stopped).toBe(true);
  });

  test("a microphone track ending mid-session reports device_unavailable AND stops capture", async () => {
    const h = harness();
    await h.capture.start();
    await h.capture.activate();
    h.stream.tracks[0]!.onended?.();
    await tick();
    expect(h.errors.some((e) => e.code === "device_unavailable")).toBe(true);
    expect(h.context.closed).toBe(true); // engine entered stopped state (audit F5)
    h.node.port.emit(chunkMsg(1)); // queued chunks can no longer continue
    expect(h.chunks).toHaveLength(0);
  });
});


test("a borrowed playback context survives mic teardown while every mic resource is released", async () => {
  let released = 0;
  const h = harness({ releaseContext: async () => { released += 1; } });
  await h.capture.start();
  await h.capture.activate();
  await h.capture.stop();
  await h.capture.stop();
  expect(h.stream.tracks.every(track => track.stopped)).toBe(true);
  expect(h.node.disconnected).toBe(true);
  expect(h.context.source.disconnected).toBe(true);
  expect(h.context.closed).toBe(false);
  expect(released).toBe(1);
});
