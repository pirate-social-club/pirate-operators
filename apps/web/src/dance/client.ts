import type {
  DanceCapture,
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
  ): Promise<DanceJournalEntry>;
  dispatchPrepared?(
    entry: DanceJournalEntry,
    signal?: AbortSignal,
  ): Promise<unknown>;
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
export function privateAccessLost(e: unknown) {
  return (
    e instanceof DanceClientError &&
    (e.status === 401 || e.status === 403 || e.code === "dance_account_changed")
  );
}
export function createDanceClient(options: {
  communityId: string;
  accountId: string;
  csrf: string;
  fetcher?: typeof fetch;
  isCurrent: () => boolean;
  journal?: DanceJournal;
}): DanceClient {
  const controller = new AbortController(),
    fetcher = options.fetcher ?? fetch,
    journal = options.journal ?? createIndexedDanceJournal();
  const scope = {
    communityId: options.communityId,
    accountId: options.accountId,
  };
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
        error.code === "dance_capture_expired"
      )
        await journal.rejectExpired(e);
      throw error;
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
    };
    const original = await journal.reserve(candidate);
    current();
    if (!identicalCommand(original, candidate))
      throw new DanceClientError("dance_other_original_pending", false, 409);
    return original;
  }
  async function dispatchPrepared(e: DanceJournalEntry, signal?: AbortSignal) {
    current();
    if (!journal.command || !journal.markDispatch)
      throw new DanceClientError("dance_preparation_port_unavailable");
    const original = await journal.command(scope, e.commandId);
    current();
    if (!original || !sameOriginalCommand(original, e))
      throw new DanceClientError("dance_original_command_changed");
    if (original.receiptJson) return JSON.parse(original.receiptJson);
    const admitted = await journal.markDispatch(original);
    current();
    if (admitted.receiptJson) return JSON.parse(admitted.receiptJson);
    return send(admitted, signal);
  }
  async function get<T>(
    path: string,
    recoverCommands = true,
    signal?: AbortSignal,
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
    return (await readResponse(response)) as T;
  }
  return {
    prepareCapture: (target, songKey, offerId, referenceId, consent) =>
      prepare(target, "capture", "captures", {
        songKey,
        offerId,
        referenceId,
        consent,
      }),
    prepareSubmission: (target, captureId, mediaId, recordingSha256) =>
      prepare(target, "submission:" + captureId, "reviews", {
        captureId,
        mediaId,
        recordingSha256,
      }),
    dispatchPrepared,
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
        { songKey, offerId, referenceId, consent },
        signal,
      ),
    submit: (captureId, mediaId, recordingSha256, signal) =>
      mutate(
        "submission:" + captureId,
        "reviews",
        {
          captureId,
          mediaId,
          recordingSha256,
        },
        signal,
      ),
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
      if (captureId && journal.acceptedCapture) {
        const e = await journal.acceptedCapture(scope);
        current();
        if (e)
          await journal.definiteCaptureReset(scope, {
            commandId: e.commandId,
            captureId,
          });
        else {
          const active = await journal.active(scope);
          current();
          if (active) throw Error("dance_response_unknown");
        }
      } else await journal.definiteCaptureReset(scope);
    },
    dispose: () => controller.abort(),
  };
}
