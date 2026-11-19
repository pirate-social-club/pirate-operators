import {
  parseDanceCaptureV2,
  type CaptureRequestV2,
} from "../../../../packages/dance/capture-v2.ts";
import { validDanceTarget } from "../../../../packages/dance/production.ts";
import type { DanceCapture } from "./capture.ts";
import {
  dancePublicationRetryable, dancePublicationTerminal, isDancePublicationStatusReply, readDancePublicationStatus,
  type DancePublicationStatus,
} from "../../../../packages/dance/publication-status.ts";
import type {
  DanceConsentAcceptance,
  DanceQueue,
  DanceReceipt,
  DanceReview,
  DanceVerdict,
} from "../../../../packages/dance/contracts.ts";
import {
  createIndexedDanceJournal,
  identicalCommand,
  sameOriginalCommand,
  hasDanceExpiredOutcome,
  type DanceJournal,
  type DanceJournalEntry,
} from "./journal.ts";
import { assertDanceReview } from "./source/dance-review-api.ts";
import { captureTarget } from "./source/ports.ts";
export interface DanceClient {
  prepareCapture?(
    targetKey: string,
    songKey: string,
    offerId: string | null,
    referenceId: string | null,
    consent: DanceConsentAcceptance,
  ): Promise<DanceJournalEntry>;
  prepareSubmission?(
    targetKey: string,
    captureId: string,
    mediaId: string,
    recordingSha256: string,
    publicationBound?: boolean,
  ): Promise<DanceJournalEntry>;
  dispatchPrepared?(
    entry: DanceJournalEntry,
    signal?: AbortSignal,
    publicationBound?: boolean,
  ): Promise<unknown>;
  observeSubmission?(entry: DanceJournalEntry, signal?: AbortSignal): Promise<DancePublicationStatus>;
  command?(commandId: string): Promise<DanceJournalEntry | null>;
  acceptedCapture?(): Promise<DanceJournalEntry | null>;
  releaseCompletedCapture?(
    commandId: string,
    captureId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  onAccessLost?(listener: (error: DanceClientError) => void): () => void;
  capture(
    songKey: string,
    offerId: string | null,
    referenceId: string | null,
    consent: DanceConsentAcceptance,
    signal?: AbortSignal,
  ): Promise<DanceCapture>;
  submit(
    captureId: string,
    mediaId: string,
    recordingSha256: string,
    signal?: AbortSignal,
  ): Promise<DanceReceipt>;
  get(reviewId: string): Promise<DanceReview>;
  queue(cursor?: string | null): Promise<DanceQueue>;
  decide(
    reviewId: string,
    revision: number,
    verdict: DanceVerdict,
    consentVersion: string,
  ): Promise<DanceReceipt>;
  withdraw(
    reviewId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<DanceReceipt>;
  recover(signal?: AbortSignal): Promise<DanceJournalEntry | null>;
  /** Read-only capabilities used by the original recorder journey. Optional
   * for historical callers; a source mount requires both explicitly. */
  retained?(): Promise<DanceJournalEntry | null>;
  observe?(reviewId: string, signal?: AbortSignal): Promise<DanceReview>;
  acknowledgeRecovery(commandId?: string): Promise<void>;
  resetDefiniteCapture(captureId?: string): Promise<void>;
  dispose(): void;
}
export class DanceClientError extends Error {
  readonly code: string;
  readonly unknown: boolean;
  readonly status?: number;
  constructor(code: string, unknown = false, status?: number) {
    super(code);
    this.code = code;
    this.unknown = unknown;
    this.status = status;
  }
}
export class DancePublicationStatusError extends Error {
  readonly publicationStatus?: DancePublicationStatus;
  constructor(publicationStatus?: DancePublicationStatus) {
    super("dance_publication_status");
    this.publicationStatus = publicationStatus;
  }
}
export function privateAccessLost(e: unknown) {
  return (
    e instanceof DanceClientError &&
    (e.status === 401 || e.status === 403 || e.code === "dance_account_changed")
  );
}

function isLegacySubmissionReceipt(value: unknown, original: DanceJournalEntry): boolean {
  if (!value || typeof value !== "object") return false;
  const receipt = value as DanceReceipt;
  return Object.keys(receipt).length === 6 && receipt.version === "pirate.dance/1" &&
    receipt.commandId === original.commandId &&
    receipt.reviewId === JSON.parse(original.bodyJson).captureId &&
    Number.isSafeInteger(receipt.revision) && receipt.revision > 0 &&
    ["awaiting_review", "decision_pending", "withdrawal_pending", "expired", "canonical"].includes(receipt.state) &&
    (receipt.intentId === null || (typeof receipt.intentId === "string" && !!receipt.intentId));
}
export function createDanceClient(options: {
  communityId: string;
  accountId: string;
  csrf: string;
  fetcher?: typeof fetch;
  isCurrent: () => boolean;
  journal?: DanceJournal;
  captureProfile?: Pick<CaptureRequestV2, "version" | "target"> & {
    publication: { kind: "private" };
  };
}): DanceClient {
  const controller = new AbortController(),
    fetcher = options.fetcher ?? fetch,
    journal = options.journal ?? createIndexedDanceJournal();
  const scope = {
    communityId: options.communityId,
    accountId: options.accountId,
  };
  const captureProfile = options.captureProfile
    ? structuredClone(options.captureProfile)
    : null;
  if (
    captureProfile &&
    (captureProfile.version !== "pirate.dance-capture-request/2" ||
      captureProfile.publication.kind !== "private" ||
      !validDanceTarget(captureProfile.target) ||
      captureProfile.target.communityId !== scope.communityId)
  )
    throw new DanceClientError("dance_capture_profile_invalid");
  function captureBody(
    songKey: string,
    offerId: string | null,
    referenceId: string | null,
    consent: DanceConsentAcceptance,
  ) {
    if (!captureProfile) return { songKey, offerId, referenceId, consent };
    const t = captureProfile.target;
    if (
      songKey !== t.songKey ||
      offerId !== t.offerId ||
      referenceId !== (t.reference?.id ?? null)
    )
      throw new DanceClientError("dance_preparation_target_changed");
    return {
      version: captureProfile.version,
      target: structuredClone(t),
      publication: { kind: "private" },
      consent,
    };
  }
  function publicReview() {
    current();
    if (captureProfile)
      throw new DanceClientError(
        "dance_private_recording_not_public",
        false,
        403,
      );
  }
  let recovery: Promise<DanceJournalEntry | null> | null = null;
  let denial: DanceClientError | null = null;
  const deniedListeners = new Set<(error: DanceClientError) => void>();
  function current() {
    if (denial) throw denial;
    if (controller.signal.aborted || !options.isCurrent())
      throw new DanceClientError("dance_account_changed");
  }
  async function readResponse(response: Response, write = false) {
    current();
    if (response.status === 401 || response.status === 403) {
      const refusal = new DanceClientError(
        "dance_request_denied",
        false,
        response.status,
      );
      denial = refusal;
      for (const listener of [...deniedListeners]) {
        try {
          listener(refusal);
        } catch {
          /* A consumer cannot suppress the denial for other private surfaces. */
        }
      }
      // Permission is already revoked. Decoding may retain a declared policy
      // error code, but neither a stalled body nor a late 200 can restore data.
      try {
        const body = (await response.json()) as { error?: unknown };
        throw new DanceClientError(
          typeof body?.error === "string" ? body.error : refusal.code,
          false,
          response.status,
        );
      } catch (error) {
        throw error instanceof DanceClientError ? error : refusal;
      }
    }
    let v: unknown;
    try {
      v = await response.json();
    } catch {
      current();
      if (!response.ok)
        throw new DanceClientError(
          response.status === 401 || response.status === 403
            ? "dance_request_denied"
            : "dance_request_failed",
          write && response.status >= 500,
          response.status,
        );
      throw new DanceClientError("dance_response_unknown", write);
    }
    current();
    if (!response.ok) {
      const code =
        v &&
        typeof v === "object" &&
        "error" in v &&
        typeof v.error === "string"
          ? v.error
          : "dance_request_failed";
      throw new DanceClientError(
        code,
        write && response.status >= 500,
        response.status,
      );
    }
    return v;
  }
  async function send(e: DanceJournalEntry, signal?: AbortSignal) {
    current();
    if (
      e.scope.communityId !== scope.communityId ||
      e.scope.accountId !== scope.accountId
    )
      throw new DanceClientError("dance_account_changed");
    if (hasDanceExpiredOutcome(e))
      throw new DanceClientError("dance_capture_expired", false, 410);
    let response: Response;
    try {
      response = await fetcher("/api/dance/" + e.path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal,
        headers: {
          "x-dance-account": scope.accountId,
          "content-type": "application/json",
          "x-csrf-token": options.csrf,
        },
        body:
          e.requestJson ??
          JSON.stringify({
            ...JSON.parse(e.bodyJson),
            commandId: e.commandId,
          }),
      });
    } catch {
      current();
      throw new DanceClientError("dance_response_unknown", true);
    }
    let value: unknown;
    try {
      value = await readResponse(response, true);
    } catch (error) {
      if (
        error instanceof DanceClientError &&
        error.status === 410 &&
        error.code === "dance_capture_expired" &&
        ["captures", "reviews"].includes(e.path)
      )
        await journal.rejectExpired(e);
      throw error;
    }
    if (e.path === "captures" && captureProfile) {
      const capture = parseDanceCaptureV2(value);
      if (capture.publication.kind !== "private")
        throw new DanceClientError("dance_response_unknown", true);
    }
    if (e.path === "reviews") {
      if (isDancePublicationStatusReply(value)) {
        const status = readDancePublicationStatus(value, e.commandId);
        if (response.status !== (dancePublicationTerminal(status.state) ? 200 : 202))
          throw new DanceClientError("dance_response_unknown", true);
        await recordPublicationStatus(e, status);
        throw new DancePublicationStatusError(status);
      }
      if (e.publicationBound || e.publicationStatus || response.status !== 200 || !isLegacySubmissionReceipt(value, e))
        throw new DanceClientError("dance_response_unknown", true);
    }
    const receipt = value as {
      commandId?: string;
      consent?: { receiptId?: string };
    };
    if (
      receipt.commandId !== e.commandId &&
      receipt.consent?.receiptId !== e.commandId
    )
      throw new DanceClientError("dance_response_unknown", true);
    await journal.accept(e, JSON.stringify(value));
    current();
    return value;
  }
  async function recover(signal?: AbortSignal) {
    current();
    return (recovery ??= (async () => {
      const active = await journal.active(scope);
      if (active) {
        if (active.targetKey) await dispatchPrepared(active, signal);
        else await send(active, signal);
        return journal.latest(scope);
      }
      return journal.latest(scope);
    })().finally(() => {
      recovery = null;
    }));
  }
  async function mutate<T>(
    subject: string,
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    current();
    const candidate: DanceJournalEntry = {
      version: 1,
      scope,
      commandId: crypto.randomUUID(),
      subject,
      path,
      bodyJson: JSON.stringify(body),
    };
    const retained = await journal.reserve(candidate);
    current();
    if (!identicalCommand(retained, candidate)) {
      throw new DanceClientError(
        "dance_original_command_recovered",
        false,
        409,
      );
    }
    if (retained.receiptJson) return JSON.parse(retained.receiptJson) as T;
    return (await send(retained, signal)) as T;
  }
  async function prepare(
    targetKey: string,
    subject: string,
    path: string,
    body: Record<string, unknown>,
    publicationBound = false,
  ) {
    current();
    const commandId = crypto.randomUUID(),
      bodyJson = JSON.stringify(body);
    const candidate: DanceJournalEntry = {
      version: 1,
      scope,
      commandId,
      subject,
      path,
      bodyJson,
      targetKey,
      requestJson: JSON.stringify({ ...body, commandId }),
      ...(publicationBound ? { publicationBound: true as const } : {}),
    };
    const original = await journal.reserve(candidate);
    current();
    if (!identicalCommand(original, candidate))
      throw new DanceClientError("dance_other_original_pending", false, 409);
    return original;
  }
  async function dispatchPrepared(e: DanceJournalEntry, signal?: AbortSignal, publicationBound = false) {
    current();
    if (!journal.command || !journal.markDispatch)
      throw new DanceClientError("dance_preparation_port_unavailable");
    const original = await journal.command(scope, e.commandId);
    current();
    if (!original || !sameOriginalCommand(original, e))
      throw new DanceClientError("dance_original_command_changed");
    if (hasDanceExpiredOutcome(original))
      throw new DanceClientError("dance_capture_expired", false, 410);
    if (original.receiptJson) return JSON.parse(original.receiptJson);
    if (original.attempted && (publicationBound || original.publicationBound || original.publicationStatus)) {
      let status: DancePublicationStatus;
      try {
        status = await observeSubmission(original, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (privateAccessLost(error)) throw error;
        throw new DancePublicationStatusError();
      }
      if (!dancePublicationRetryable(status.state)) throw new DancePublicationStatusError(status);
    }
    const admitted = await journal.markDispatch(original);
    current();
    if (hasDanceExpiredOutcome(admitted))
      throw new DanceClientError("dance_capture_expired", false, 410);
    if (admitted.receiptJson) return JSON.parse(admitted.receiptJson);
    if (admitted.retainedPublicationOriginal ||
        (admitted.publicationStatus && !dancePublicationRetryable(admitted.publicationStatus.state)))
      throw new DancePublicationStatusError(admitted.publicationStatus);
    return send(admitted, signal);
  }
  async function get<T>(
    path: string,
    recoverCommands = true,
    signal?: AbortSignal,
    requireStatus200 = false,
  ): Promise<T> {
    if (recoverCommands) {
      const active = await journal.active(scope);
      current();
      if (active?.targetKey)
        throw new DanceClientError("dance_original_command_pending", true, 409);
      await recover(signal);
    }
    current();
    let response: Response;
    try {
      response = await fetcher("/api/dance/" + path, {
        credentials: "same-origin",
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal,
        headers: { "x-dance-account": scope.accountId },
      });
    } catch {
      current();
      throw new DanceClientError("dance_read_unavailable");
    }
    if (requireStatus200 && response.ok && response.status !== 200) {
      current();
      throw new DanceClientError("dance_read_unavailable", false, response.status);
    }
    return (await readResponse(response)) as T;
  }
  async function recordPublicationStatus(entry: DanceJournalEntry, status: DancePublicationStatus) {
    if (!journal.recordPublicationStatus)
      throw new DanceClientError("dance_publication_status_unavailable", true);
    await journal.recordPublicationStatus(entry, status);
    current();
  }
  async function observeSubmission(entry: DanceJournalEntry, signal?: AbortSignal) {
    publicReview();
    if (entry.path !== "reviews" || entry.scope.communityId !== scope.communityId ||
        entry.scope.accountId !== scope.accountId || !entry.attempted)
      throw new DanceClientError("dance_publication_original_changed", true);
    const { captureId } = JSON.parse(entry.bodyJson);
    if (typeof captureId !== "string" || !/^0x[0-9a-f]{64}(?![\s\S])/.test(captureId))
      throw new DanceClientError("dance_publication_original_changed", true);
    const reply = await get<unknown>(
      "reviews/" + captureId + "/submission-status?" + new URLSearchParams({ requestId: entry.commandId }),
      false, signal, true,
    );
    const status = readDancePublicationStatus(reply, entry.commandId);
    await recordPublicationStatus(entry, status);
    return status;
  }
  return {
    prepareCapture: (target, songKey, offerId, referenceId, consent) =>
      prepare(
        target,
        "capture",
        "captures",
        captureBody(songKey, offerId, referenceId, consent),
      ),
    prepareSubmission: async (target, captureId, mediaId, recordingSha256, publicationBound) => {
      publicReview();
      return prepare(target, "submission:" + captureId, "reviews", {
        captureId,
        mediaId,
        recordingSha256,
      }, publicationBound);
    },
    dispatchPrepared,
    observeSubmission,
    command: async (id) => {
      current();
      if (!journal.command) throw Error("dance_preparation_port_unavailable");
      const e = await journal.command(scope, id);
      current();
      return e;
    },
    acceptedCapture: async () => {
      current();
      if (!journal.acceptedCapture)
        throw Error("dance_preparation_port_unavailable");
      const e = await journal.acceptedCapture(scope);
      current();
      return e;
    },
    releaseCompletedCapture: async (commandId, captureId, signal) => {
      current();
      if (!journal.acceptedCapture)
        throw Error("dance_preparation_port_unavailable");
      const e = await journal.acceptedCapture(scope);
      current();
      if (!e?.receiptJson || e.commandId !== commandId)
        throw Error("dance_capture_reset_changed");
      const capture = JSON.parse(e.receiptJson) as DanceCapture;
      if (
        capture.captureId !== captureId ||
        capture.learner.accountId !== scope.accountId ||
        capture.communityId !== scope.communityId
      )
        throw Error("dance_capture_reset_changed");
      const review = await get<DanceReview>(
        "reviews/" + encodeURIComponent(captureId),
        false,
        signal,
      );
      current();
      assertDanceReview(review, captureTarget(capture), capture);
      if (
        review.localDenied ||
        !review.canonical?.canonical ||
        review.canonical.finality !== "safe"
      )
        throw Error("dance_original_not_safely_completed");
      await journal.definiteCaptureReset(scope, { commandId, captureId });
      current();
    },
    onAccessLost: (listener) => {
      deniedListeners.add(listener);
      if (denial) listener(denial);
      return () => deniedListeners.delete(listener);
    },
    capture: (songKey, offerId, referenceId, consent, signal) =>
      mutate(
        "capture",
        "captures",
        captureBody(songKey, offerId, referenceId, consent),
        signal,
      ),
    submit: async (captureId, mediaId, recordingSha256, signal) => {
      publicReview();
      return mutate(
        "submission:" + captureId,
        "reviews",
        {
          captureId,
          mediaId,
          recordingSha256,
        },
        signal,
      );
    },
    get: (id) => get("reviews/" + encodeURIComponent(id)),
    queue: (cursor) =>
      get("queue" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "")),
    decide: (id, revision, verdict, consentVersion) =>
      mutate(
        "decision:" + id,
        "reviews/" + encodeURIComponent(id) + "/verdict",
        { revision, verdict, consentVersion },
      ),
    withdraw: (id, revision, signal) =>
      mutate(
        "withdraw:" + id,
        "reviews/" + encodeURIComponent(id) + "/withdraw",
        { revision },
        signal,
      ),
    recover,
    retained: async () => {
      current();
      const result =
        (await journal.active(scope)) ?? (await journal.latest(scope));
      current();
      return result;
    },
    observe: (id, signal) =>
      get("reviews/" + encodeURIComponent(id), false, signal),
    acknowledgeRecovery: async (commandId) => {
      current();
      await journal.acknowledge(scope, commandId);
    },
    resetDefiniteCapture: async (captureId) => {
      current();
      if (captureId)
        await journal.definiteCaptureReset(scope, {
          captureId,
          keepUnrelated: true,
        });
      else await journal.definiteCaptureReset(scope);
      current();
    },
    dispose: () => controller.abort(),
  };
}
