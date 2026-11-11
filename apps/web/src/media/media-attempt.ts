import type {
  MediaIntent,
  MediaStatus,
  PublishedMediaSong,
  ReadyMedia,
} from "../../../../packages/community-media/contracts.ts";
import {
  MEDIA_VERSION,
  PUBLIC_POSTING_UNDECIDED,
} from "../../../../packages/community-media/contracts.ts";
import { MediaHttpError, type MediaClient } from "./client.ts";

export const MEDIA_ATTEMPT_VERSION = "pirate.media-attempt/1" as const;
export type MediaCommand = "reserve" | "upload" | "retry" | "withdraw";
export interface MediaAttempt {
  readonly version: typeof MEDIA_ATTEMPT_VERSION;
  readonly accountId: string;
  readonly communityId: string;
  readonly file: File;
  readonly rating: "general" | "adult_18";
  readonly song: PublishedMediaSong;
  readonly intent: MediaIntent;
  readonly intentDigest: string;
  readonly status: MediaStatus | null;
  readonly pending: MediaCommand | null;
  readonly rejection?: string;
}
/** Host owns durable storage and account isolation. No reference localStorage. */
export interface MediaAttemptStorage {
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  load(): Promise<MediaAttempt | null>;
  save(record: MediaAttempt): Promise<void>;
  remove(): Promise<void>;
}
export async function digestBytes(
  bytes: ArrayBuffer | Uint8Array,
): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
const digestIntent = (intent: MediaIntent) =>
  digestBytes(new TextEncoder().encode(JSON.stringify(intent)));
const definitive = (error: unknown) =>
  error instanceof MediaHttpError &&
  error.status >= 400 &&
  error.status < 500 &&
  ![408, 409, 429].includes(error.status);
const terminal = (status: MediaStatus | null) =>
  status && ["withdrawn", "revoked", "expired"].includes(status.state);

/** The existing media protocol has one reservation and one upload job, not a
 * published Post receipt. Unknown acknowledgements retain this exact envelope.
 * All wire mutations run behind the host's exclusive durable storage lock. */
export interface MediaAttemptPorts {
  client: MediaClient;
  storage: MediaAttemptStorage;
  accountId: string;
  communityId: string;
  createId?: () => string;
  onChange?: (record: MediaAttempt | null) => void;
  onReady?: (receipt: ReadyMedia) => void;
}

export class MediaAttemptController {
  private record: MediaAttempt | null = null;
  private busy = false;
  private pauseRevision = 0;
  private abort: AbortController | undefined;
  private readonly ports: MediaAttemptPorts;
  constructor(ports: MediaAttemptPorts) {
    this.ports = ports;
  }
  get current() {
    return this.record;
  }
  /** Local playback is denied before the withdrawal request leaves this device. */
  get playbackUrl() {
    return this.record?.pending === "withdraw"
      ? undefined
      : this.record?.status?.playbackUrl;
  }
  pause() {
    this.pauseRevision++;
    this.abort?.abort();
  }
  private async save(record: MediaAttempt) {
    await this.ports.storage.save(record);
    this.record = record;
    this.ports.onChange?.(record);
  }
  private require(): MediaAttempt {
    if (!this.record) throw new Error("No retained video attempt");
    return this.record;
  }
  private async validate(record: MediaAttempt) {
    if (
      record.version !== MEDIA_ATTEMPT_VERSION ||
      record.intent.purpose !== "public-feed" ||
      record.accountId !== this.ports.accountId ||
      record.communityId !== this.ports.communityId ||
      record.song.communityId !== record.communityId ||
      record.intent.songKey !== record.song.songKey ||
      record.intent.songRevision !== record.song.songRevision ||
      record.intentDigest !== (await digestIntent(record.intent)) ||
      record.intent.recordingSha256 !==
        (await digestBytes(await record.file.arrayBuffer())) ||
      record.intent.bytes !== record.file.size
    )
      throw new Error("Retained video identity or digest changed");
  }
  private async exclusive<T>(
    work: (active: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.busy) throw new Error("A video command is already in progress");
    this.busy = true;
    const revision = this.pauseRevision;
    const active = () => {
      if (revision !== this.pauseRevision)
        throw new Error("Video paused; resume the retained attempt");
    };
    try {
      return await this.ports.storage.exclusive(async () => {
        const stored = await this.ports.storage.load();
        if (stored) await this.validate(stored);
        this.record = stored;
        this.ports.onChange?.(stored);
        active();
        return work(active);
      });
    } finally {
      this.busy = false;
    }
  }
  private async accept(status: MediaStatus) {
    const record = this.require();
    if (
      !status ||
      typeof status.id !== "string" ||
      !status.id ||
      status.purpose !== record.intent.purpose ||
      (record.status && status.id !== record.status.id) ||
      ![
        "uploading",
        "receiving",
        "queued",
        "processing",
        "ready",
        "failed",
        "withdrawn",
        "revoked",
        "expired",
      ].includes(status.state) ||
      !Number.isSafeInteger(status.expiresAt)
    )
      throw new Error("Unconfirmed media response identity");
    if (
      status.playbackUrl !== undefined &&
      status.playbackUrl !== `/api/media/${status.id}/playback`
    )
      throw new Error(
        "Media playback must use the authorized same-origin port",
      );
    if (status.ready) {
      const ready = status.ready;
      if (
        ready.version !== MEDIA_VERSION ||
        !Number.isSafeInteger(ready.revision) ||
        ready.revision < 1 ||
        !Number.isSafeInteger(ready.readyAt) ||
        !Number.isSafeInteger(ready.expiresAt) ||
        ready.expiresAt !== status.expiresAt ||
        ready.id !== status.id ||
        ready.accountId !== record.accountId ||
        ready.communityId !== record.communityId ||
        ready.songKey !== record.song.songKey ||
        ready.songRevision !== record.song.songRevision ||
        ready.audioSha256 !== record.song.audioSha256 ||
        ready.recordingSha256 !== record.intent.recordingSha256 ||
        ready.startSample !== record.intent.startSample ||
        ready.durationSamples !== record.intent.durationSamples ||
        ready.purpose !== record.intent.purpose
      )
        throw new Error("Media receipt changed frozen bindings");
    }
    // A status read cannot settle a lost withdrawal until revocation is proven.
    const pending =
      record.pending === "withdraw" && !terminal(status) ? "withdraw" : null;
    const { rejection: _rejection, ...accepted } = record;
    await this.save({ ...accepted, status, pending });
    if (status.state === "ready" && status.ready && pending !== "withdraw")
      this.ports.onReady?.(status.ready);
  }
  private async execute(command: MediaCommand, active: () => void) {
    const record = this.require();
    if (record.pending && record.pending !== command)
      throw new Error("Reconcile the retained command first");
    active();
    await this.save({ ...record, pending: command });
    active();
    try {
      let status: MediaStatus;
      if (command === "reserve")
        status = await this.ports.client.reserve(record.intent);
      else {
        if (!record.status)
          throw new Error("Reservation acknowledgement is missing");
        if (command === "upload") {
          this.abort = new AbortController();
          try {
            status = await this.ports.client.upload(
              record.status.id,
              record.file,
              this.abort.signal,
            );
          } finally {
            this.abort = undefined;
          }
        } else if (command === "retry")
          status = await this.ports.client.retry(record.status.id);
        else status = await this.ports.client.withdraw(record.status.id);
      }
      await this.accept(status); // Persist late replies even if paused meanwhile.
      active();
    } catch (error) {
      if (definitive(error)) {
        await this.save({
          ...this.require(),
          pending: command === "withdraw" ? "withdraw" : null,
          rejection: (error as MediaHttpError).code,
        });
      }
      throw error;
    }
  }
  private async reconcile(active: () => void) {
    const record = this.require();
    if (record.pending === "reserve") {
      await this.execute("reserve", active);
      return;
    }
    if (record.pending === "withdraw") {
      await this.execute("withdraw", active);
      return;
    }
    if (!record.status) return;
    const pending = record.pending;
    // Lost upload/retry acknowledgements read canonical job state first. A
    // receiving/queued/processing response never triggers another upload.
    const status = await this.ports.client.status(record.status.id);
    await this.accept(status);
    active();
    if (pending === "upload" && status.state === "uploading")
      await this.execute("upload", active);
    if (pending === "retry" && status.state === "failed" && status.canRetry) {
      // Failed may be the outcome of the acknowledged retry. Require a new
      // explicit author action instead of silently spending another attempt.
      return;
    }
  }
  restore() {
    return this.exclusive(async (active) => {
      if (this.record) await this.reconcile(active);
      return this.record;
    });
  }
  begin(input: {
    file: File;
    rating: "general" | "adult_18";
    song: PublishedMediaSong;
    startSample: number;
    durationSamples: number;
  }) {
    return this.exclusive(async (active) => {
      if (this.record)
        throw new Error("Resolve the retained video before starting another");
      // Direct owner rights decision is a separate gate from technical upload
      // capability. No public consent or permission is inferred here.
      if (!PUBLIC_POSTING_UNDECIDED.allowed)
        throw new MediaHttpError(403, "media_public_posting_not_permitted");
      const capability = await this.ports.client.capability(
        input.song.songKey,
        input.song.songRevision,
      );
      if (!capability.publicPosting.allowed)
        throw new MediaHttpError(403, "media_public_posting_not_permitted");
      if (
        input.song.communityId !== this.ports.communityId ||
        input.durationSamples < 3 * 48000 ||
        input.durationSamples > 15 * 48000 ||
        !Number.isSafeInteger(input.startSample) ||
        !Number.isSafeInteger(input.durationSamples) ||
        input.startSample < 0 ||
        input.startSample + input.durationSamples > input.song.durationSamples
      )
        throw new Error("The song segment is unavailable");
      const intent: MediaIntent = {
        requestId: this.ports.createId?.() ?? crypto.randomUUID(),
        songKey: input.song.songKey,
        songRevision: input.song.songRevision,
        recordingSha256: await digestBytes(await input.file.arrayBuffer()),
        bytes: input.file.size,
        startSample: input.startSample,
        durationSamples: input.durationSamples,
        purpose: "public-feed",
        publicConsent: false,
      };
      active();
      await this.save({
        version: MEDIA_ATTEMPT_VERSION,
        accountId: this.ports.accountId,
        communityId: this.ports.communityId,
        file: input.file,
        rating: input.rating,
        song: { ...input.song },
        intent,
        intentDigest: await digestIntent(intent),
        status: null,
        pending: "reserve",
      });
      await this.execute("reserve", active);
    });
  }
  submit() {
    return this.exclusive(async (active) => {
      await this.reconcile(active);
      const record = this.require();
      if (record.rejection)
        throw new Error("This video wasn’t accepted. Start over explicitly.");
      if (record.status?.state === "uploading")
        await this.execute("upload", active);
      else if (record.status?.state === "failed" && record.status.canRetry)
        await this.execute("retry", active);
      return this.require().status;
    });
  }
  refresh() {
    return this.exclusive(async (active) => {
      await this.reconcile(active);
      return this.require().status;
    });
  }
  withdraw() {
    return this.exclusive(async (active) => {
      if (this.require().pending && this.require().pending !== "withdraw")
        await this.reconcile(active);
      await this.execute("withdraw", active);
    });
  }
  discard() {
    return this.exclusive(async (active) => {
      if (this.require().pending) await this.reconcile(active);
      const record = this.require();
      if (
        !terminal(record.status) &&
        !(record.rejection && !record.status && !record.pending)
      )
        throw new Error("Withdraw the retained video before discarding it");
      await this.ports.storage.remove();
      this.record = null;
      this.ports.onChange?.(null);
    });
  }
}
