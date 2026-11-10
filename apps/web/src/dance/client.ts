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
  type DanceJournal,
  type DanceJournalEntry,
} from "./journal.ts";
export interface DanceClient {
  capture(
    songKey: string,
    offerId: string | null,
    referenceId: string | null,
    consent: DanceConsentAcceptance,
  ): Promise<DanceCapture>;
  submit(
    captureId: string,
    mediaId: string,
    recordingSha256: string,
  ): Promise<DanceReceipt>;
  get(reviewId: string): Promise<DanceReview>;
  queue(cursor?: string | null): Promise<DanceQueue>;
  decide(
    reviewId: string,
    revision: number,
    verdict: DanceVerdict,
    consentVersion: string,
  ): Promise<DanceReceipt>;
  withdraw(reviewId: string, revision: number): Promise<DanceReceipt>;
  recover(): Promise<DanceJournalEntry | null>;
  acknowledgeRecovery(): Promise<void>;
  resetDefiniteCapture(): Promise<void>;
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
  function current() {
    if (controller.signal.aborted || !options.isCurrent())
      throw new DanceClientError("dance_account_changed");
  }
  async function readResponse(response: Response, write = false) {
    current();
    let v: unknown;
    try {
      v = await response.json();
    } catch {
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
  async function send(e: DanceJournalEntry) {
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
        signal: controller.signal,
        headers: {
          "x-dance-account": scope.accountId,
          "content-type": "application/json",
          "x-csrf-token": options.csrf,
        },
        body: JSON.stringify({
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
  async function recover() {
    current();
    return (recovery ??= (async () => {
      const active = await journal.active(scope);
      if (active) {
        await send(active);
        return active;
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
      if (!retained.receiptJson) await send(retained);
      throw new DanceClientError(
        "dance_original_command_recovered",
        false,
        409,
      );
    }
    if (retained.receiptJson) return JSON.parse(retained.receiptJson) as T;
    return (await send(retained)) as T;
  }
  async function get<T>(path: string): Promise<T> {
    await recover();
    current();
    let response: Response;
    try {
      response = await fetcher("/api/dance/" + path, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: { "x-dance-account": scope.accountId },
      });
    } catch {
      current();
      throw new DanceClientError("dance_read_unavailable");
    }
    return (await readResponse(response)) as T;
  }
  return {
    capture: (songKey, offerId, referenceId, consent) =>
      mutate("capture", "captures", { songKey, offerId, referenceId, consent }),
    submit: (captureId, mediaId, recordingSha256) =>
      mutate("submission:" + captureId, "reviews", {
        captureId,
        mediaId,
        recordingSha256,
      }),
    get: (id) => get("reviews/" + encodeURIComponent(id)),
    queue: (cursor) =>
      get("queue" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "")),
    decide: (id, revision, verdict, consentVersion) =>
      mutate(
        "decision:" + id,
        "reviews/" + encodeURIComponent(id) + "/verdict",
        { revision, verdict, consentVersion },
      ),
    withdraw: (id, revision) =>
      mutate(
        "withdraw:" + id,
        "reviews/" + encodeURIComponent(id) + "/withdraw",
        { revision },
      ),
    recover,
    acknowledgeRecovery: async () => {
      current();
      await journal.acknowledge(scope);
    },
    resetDefiniteCapture: async () => {
      current();
      await journal.definiteCaptureReset(scope);
    },
    dispose: () => controller.abort(),
  };
}
