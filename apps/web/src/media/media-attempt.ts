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
  /** False proves this command has not yet crossed its first dispatch fence.
   * Missing on a legacy pending record is conservatively uncertain. */
  readonly commandDispatched?: boolean;
  readonly authenticationHold?: boolean;
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
  ![401, 403, 408, 409, 429].includes(error.status);
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
  onChange?: (
    record: MediaAttempt | null,
    notificationCurrent: () => boolean,
  ) => void;
  onReady?: (receipt: ReadyMedia, notificationCurrent: () => boolean) => void;
  /** Host lifetime/authority fence, not an authentication substitute. */
  isCurrentOwner?: () => boolean;
}

interface OperationFence {
  current(): boolean;
  assert(): void;
}

/** Presentation projection only; the copied XState chart still owns flow. */
export function mediaNeedsStartOver(record: MediaAttempt | null): boolean {
  return Boolean(
    record &&
      (record.pending === "withdraw" ||
        terminal(record.status) ||
        (record.status?.state === "failed" && !record.status.canRetry) ||
        (record.rejection && !record.pending && !record.authenticationHold)),
  );
}

export class MediaAttemptController {
  private record: MediaAttempt | null = null;
  private busy = false;
  private pauseRevision = 0;
  private abort: AbortController | undefined;
  private disposed = false;
  private withdrawalRequested = false;
  private ownsStorage = false;
  private loaded = false;
  private busyDone: Promise<void> | undefined;
  private withdrawal: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private readonly ports: MediaAttemptPorts;
  constructor(ports: MediaAttemptPorts) {
    this.ports = { ...ports };
  }
  get current() {
    return this.record;
  }
  /** Local playback is denied before the withdrawal request leaves this device. */
  get playbackUrl() {
    return this.disposed ||
      !(this.ports.isCurrentOwner?.() ?? true) ||
      this.withdrawalRequested ||
      this.record?.pending === "withdraw" ||
      terminal(this.record?.status ?? null)
      ? undefined
      : this.record?.status?.playbackUrl;
  }
  pause() {
    this.pauseRevision++;
    this.abort?.abort();
  }
  dispose() {
    this.disposed = true;
    this.pause();
  }
  private fence(): OperationFence {
    const revision = this.pauseRevision;
    const current = () =>
      !this.disposed &&
      revision === this.pauseRevision &&
      (this.ports.isCurrentOwner?.() ?? true);
    return {
      current,
      assert() {
        if (!current())
          throw new Error("Video paused; resume the retained attempt");
      },
    };
  }
  /** The active operation owns the storage lock. Serialize its writes with a
   * preempting withdrawal so a late receipt cannot overwrite the delete intent
   * and a delete-intent write cannot overwrite a late canonical receipt. */
  private update(
    change: (current: MediaAttempt | null) => MediaAttempt,
    fence: OperationFence,
  ) {
    const work = this.writes.then(async () => {
      let record = change(this.record);
      if (this.withdrawalRequested && !terminal(record.status))
        record = { ...record, pending: "withdraw" };
      await this.ports.storage.save(record);
      this.record = record;
      if (fence.current()) this.ports.onChange?.(record, fence.current);
    });
    this.writes = work.catch(() => {});
    return work;
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
    work: (active: OperationFence) => Promise<T>,
  ): Promise<T> {
    if (this.busy) throw new Error("A video command is already in progress");
    this.busy = true;
    let complete!: () => void;
    this.busyDone = new Promise((resolve) => {
      complete = resolve;
    });
    const active = this.fence();
    try {
      return await this.ports.storage.exclusive(async () => {
        this.ownsStorage = true;
        try {
          const stored = await this.ports.storage.load();
          if (stored) await this.validate(stored);
          this.record = stored;
          this.loaded = true;
          if (this.withdrawalRequested && stored && !terminal(stored.status))
            await this.update(
              (current) => ({ ...current!, pending: "withdraw" }),
              active,
            );
          if (active.current())
            this.ports.onChange?.(this.record, active.current);
          active.assert();
          return await work(active);
        } finally {
          while (true) {
            const tail = this.writes;
            await tail;
            if (tail === this.writes) break;
          }
          this.loaded = false;
          this.ownsStorage = false;
        }
      });
    } finally {
      this.busy = false;
      complete();
    }
  }
  private async accept(status: MediaStatus, active: OperationFence) {
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
    await this.update((current) => {
      const {
        rejection: _rejection,
        authenticationHold: _hold,
        ...accepted
      } = current!;
      const pending =
        (this.withdrawalRequested || accepted.pending === "withdraw") &&
        !terminal(status)
          ? "withdraw"
          : null;
      return {
        ...accepted,
        status,
        pending,
        commandDispatched: pending !== null,
      };
    }, active);
    if (
      active.current() &&
      !this.withdrawalRequested &&
      status.state === "ready" &&
      status.ready &&
      this.record?.pending !== "withdraw"
    )
      this.ports.onReady?.(status.ready, active.current);
  }
  private async refusal(
    error: unknown,
    command: MediaCommand,
    priorUnknown: boolean,
    active: OperationFence,
  ) {
    if (!(error instanceof MediaHttpError)) return;
    const hold = error.status === 401 || error.status === 403;
    if (hold || definitive(error))
      await this.update(
        (current) => ({
          ...current!,
          pending:
            command === "withdraw" || this.withdrawalRequested
              ? "withdraw"
              : hold || priorUnknown
                ? command
                : null,
          commandDispatched:
            hold ||
            priorUnknown ||
            command === "withdraw" ||
            this.withdrawalRequested,
          authenticationHold: hold,
          // This names the latest refused wire attempt, never proof that an
          // earlier uncertain reservation did not commit. pending is authoritative.
          rejection: error.code,
        }),
        active,
      );
  }
  private async execute(command: MediaCommand, active: OperationFence) {
    const record = this.require();
    if (record.pending && record.pending !== command)
      throw new Error("Reconcile the retained command first");
    const priorUnknown =
      record.pending === command && record.commandDispatched !== false;
    active.assert();
    await this.update(
      (current) => ({ ...current!, pending: command, commandDispatched: true }),
      active,
    );
    active.assert();
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
      await this.accept(status, active); // Persist late replies even if paused meanwhile.
      active.assert();
      if (command === "withdraw" && !terminal(status))
        throw new Error("Withdrawal is not yet confirmed");
    } catch (error) {
      await this.refusal(error, command, priorUnknown, active);
      throw error;
    }
  }
  private async finishWithdrawal(active: OperationFence) {
    if (terminal(this.require().status)) {
      await this.accept(this.require().status!, active);
      return;
    }
    // The only recovery needed for DELETE is its identifier. Replaying the
    // exact reservation envelope settles a lost acknowledgement without bytes.
    if (!this.require().status) {
      active.assert();
      await this.update(
        (current) => ({
          ...current!,
          pending: "withdraw",
          commandDispatched: true,
        }),
        active,
      );
      active.assert();
      try {
        await this.accept(
          await this.ports.client.reserve(this.require().intent),
          active,
        );
      } catch (error) {
        await this.refusal(error, "withdraw", true, active);
        throw error;
      }
      active.assert();
    }
    if (!terminal(this.require().status))
      await this.execute("withdraw", active);
  }
  private async reconcile(active: OperationFence) {
    const record = this.require();
    if (record.pending === "reserve") {
      await this.execute("reserve", active);
      return;
    }
    if (record.pending === "withdraw") {
      await this.finishWithdrawal(active);
      return;
    }
    if (!record.status) return;
    const pending = record.pending;
    // Lost upload/retry acknowledgements read canonical job state first. A
    // receiving/queued/processing response never triggers another upload.
    let status: MediaStatus;
    try {
      status = await this.ports.client.status(record.status.id);
    } catch (error) {
      if (
        error instanceof MediaHttpError &&
        [401, 403].includes(error.status)
      ) {
        // A refused read says nothing about the pending mutation's outcome.
        // Preserve its exact command/dispatch witness, bytes and identity.
        await this.update(
          (current) => ({ ...current!, authenticationHold: true }),
          active,
        );
      }
      throw error;
    }
    await this.accept(status, active);
    active.assert();
    if (pending === "upload" && status.state === "uploading")
      await this.execute("upload", active);
    if (pending === "retry" && status.state === "failed" && status.canRetry) {
      // Failed may be the outcome of the acknowledged retry. Require a new
      // explicit author action instead of silently spending another attempt.
      return;
    }
  }
  restore(options: { reconcileHeld?: boolean } = {}) {
    return this.exclusive(async (active) => {
      // Automatic host restoration can display a durable reconnect hold
      // without retrying it. Explicit same-owner reconciliation keeps the
      // existing default behavior and uses the transport's fresh CSRF/session.
      if (
        this.record &&
        !(this.record.authenticationHold && options.reconcileHeld === false)
      )
        await this.reconcile(active);
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
      const intentDigest = await digestIntent(intent);
      active.assert();
      await this.update(
        () => ({
          version: MEDIA_ATTEMPT_VERSION,
          accountId: this.ports.accountId,
          communityId: this.ports.communityId,
          file: input.file,
          rating: input.rating,
          song: { ...input.song },
          intent,
          intentDigest,
          status: null,
          pending: "reserve",
          commandDispatched: false,
        }),
        active,
      );
      await this.execute("reserve", active);
    });
  }
  submit() {
    return this.exclusive(async (active) => {
      if (mediaNeedsStartOver(this.record))
        throw new Error("Start over after closing the retained video");
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
      // Background polling cannot release an authentication hold. Only an
      // explicit restore/submit/start-over reconciliation may do so.
      if (this.require().authenticationHold) return this.require().status;
      await this.reconcile(active);
      return this.require().status;
    });
  }
  withdraw() {
    if (this.withdrawal) return this.withdrawal;
    this.withdrawalRequested = true;
    const inFlight = this.busy ? this.busyDone : undefined;
    this.pause(); // Abort bytes, invalidate old notifications and later effects.
    const active = this.fence();
    // An in-flight operation already holds the exclusive storage lock. Its
    // serialized write queue can persist DELETE intent before its late reply.
    const persisted =
      this.ownsStorage && this.loaded && this.record
        ? this.update(
            (current) => ({ ...current!, pending: "withdraw" }),
            active,
          )
        : Promise.resolve();
    const work = (async () => {
      await persisted;
      await inFlight;
      await this.exclusive(async (current) => {
        this.require();
        if (!terminal(this.record!.status))
          await this.update(
            (record) => ({ ...record!, pending: "withdraw" }),
            current,
          );
        await this.finishWithdrawal(current);
      });
    })();
    const completion: Promise<void> = work.finally(() => {
      if (this.withdrawal === completion) this.withdrawal = undefined;
    });
    this.withdrawal = completion;
    return completion;
  }
  discard() {
    return this.exclusive(async (active) => {
      // Discard never resumes bytes or retries processing as a side effect.
      if (terminal(this.require().status))
        await this.accept(this.require().status!, active);
      if (this.require().pending === "withdraw")
        await this.finishWithdrawal(active);
      const record = this.require();
      if (
        record.pending ||
        (!terminal(record.status) &&
          !(
            record.rejection &&
            !record.status &&
            !record.pending &&
            record.commandDispatched === false
          ))
      )
        throw new Error("Withdraw the retained video before discarding it");
      active.assert();
      await this.ports.storage.remove();
      this.record = null;
      this.withdrawalRequested = false;
      if (active.current()) this.ports.onChange?.(null, active.current);
    });
  }
  async startOver() {
    const record = this.require();
    const rejectedBeforeCommit =
      record.rejection &&
      !record.status &&
      !record.pending &&
      record.commandDispatched === false;
    if (!terminal(record.status) && !rejectedBeforeCommit)
      await this.withdraw();
    await this.discard();
  }
}
