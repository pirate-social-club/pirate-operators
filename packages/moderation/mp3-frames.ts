// Independently owned adaptation of api-next a5c63b8db01d4359344d33c31d294a00fbeadb20.
// Source digest and selected boundaries: docs/moderation-source-provenance.json.
export type Mp3Frame = Readonly<{
  readonly bitrateBps: number;
  readonly byteLength: number;
  readonly channels: 1 | 2;
  readonly durationMs: number;
  readonly sampleRateHz: number;
  readonly version: 1 | 2 | 2.5;
}>;

export type Mp3FrameWindow = Readonly<{
  readonly bytes: Uint8Array;
  readonly durationMs: number;
  readonly offsetMs: number;
  readonly firstFrame: number;
  readonly frameCount: number;
}>;

export class Mp3WindowFailure extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = "Mp3WindowFailure";
  }
}

type Mp3StreamReader = Readonly<{
  readonly read: () => Promise<
    Readonly<{ readonly done: boolean; readonly value: Uint8Array | undefined }>
  >;
  readonly cancel: (reason?: unknown) => Promise<void>;
  readonly releaseLock: () => void;
}>;

export class StreamBytes {
  readonly #reader: Mp3StreamReader;
  readonly #signal: AbortSignal;
  #buffer = new Uint8Array(0);
  #offset = 0;
  #ended = false;

  constructor(stream: ReadableStream<Uint8Array>, signal: AbortSignal) {
    this.#reader = stream.getReader();
    this.#signal = signal;
  }

  get available(): number {
    return this.#buffer.byteLength - this.#offset;
  }

  async ensure(count: number): Promise<boolean> {
    while (this.available < count && !this.#ended) {
      if (this.#signal.aborted) throw new Mp3WindowFailure("aborted");
      let next: Readonly<{
        readonly done: boolean;
        readonly value: Uint8Array | undefined;
      }>;
      try {
        next = await this.#reader.read();
      } catch {
        throw new Mp3WindowFailure(
          this.#signal.aborted ? "aborted" : "stream_failed",
        );
      }
      if (next.done) {
        this.#ended = true;
        break;
      }
      if (!(next.value instanceof Uint8Array))
        throw new Mp3WindowFailure("stream_failed");
      const retained = this.#buffer.subarray(this.#offset);
      const combined = new Uint8Array(
        retained.byteLength + next.value.byteLength,
      );
      combined.set(retained);
      combined.set(next.value, retained.byteLength);
      this.#buffer = combined;
      this.#offset = 0;
    }
    return this.available >= count;
  }

  view(count: number): Uint8Array {
    return this.#buffer.subarray(this.#offset, this.#offset + count);
  }

  take(count: number): Uint8Array {
    const value = this.#buffer.slice(this.#offset, this.#offset + count);
    this.#offset += count;
    return value;
  }

  discard(count: number): void {
    this.#offset += count;
  }

  async cancel(reason: string): Promise<void> {
    try {
      await this.#reader.cancel(reason);
    } catch {
      // Cancellation is cleanup after a selected outcome.
    }
  }

  release(): void {
    this.#reader.releaseLock();
  }
}

export function synchsafe(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.byteLength) return null;
  const values = bytes.subarray(offset, offset + 4);
  if (values.some((value) => value > 0x7f)) return null;
  return values.reduce((total, value) => total * 128 + value, 0);
}

export function parseMp3Frame(bytes: Uint8Array): Mp3Frame | null {
  if (bytes.byteLength < 4) return null;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const third = bytes[2] ?? 0;
  const fourth = bytes[3] ?? 0;
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return null;
  const versionBits = (second >> 3) & 0x03;
  const layerBits = (second >> 1) & 0x03;
  if (versionBits === 1 || layerBits !== 1) return null;
  const bitrateIndex = (third >> 4) & 0x0f;
  const sampleRateIndex = (third >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3)
    return null;
  const version: 1 | 2 | 2.5 =
    versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const mpeg1Bitrates = [
    32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
  ];
  const mpeg2Bitrates = [
    8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
  ];
  const bitrateKbps = (version === 1 ? mpeg1Bitrates : mpeg2Bitrates)[
    bitrateIndex - 1
  ];
  const baseSampleRate = [44_100, 48_000, 32_000][sampleRateIndex];
  if (bitrateKbps === undefined || baseSampleRate === undefined) return null;
  const sampleRateHz =
    version === 1
      ? baseSampleRate
      : version === 2
        ? baseSampleRate / 2
        : baseSampleRate / 4;
  const padding = (third >> 1) & 1;
  const byteLength =
    Math.floor(
      ((version === 1 ? 144 : 72) * bitrateKbps * 1_000) / sampleRateHz,
    ) + padding;
  if (byteLength < 4) return null;
  const samples = version === 1 ? 1_152 : 576;
  return {
    bitrateBps: bitrateKbps * 1_000,
    byteLength,
    channels: ((fourth >> 6) & 0x03) === 3 ? 1 : 2,
    durationMs: (samples * 1_000) / sampleRateHz,
    sampleRateHz,
    version,
  };
}
