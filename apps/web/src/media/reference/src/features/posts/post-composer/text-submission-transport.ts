import type { PendingSubmissionEnvelopeV1 } from "./pending-submission.ts";
import type { TextContentSubmissionV1 } from "./text-submission-contract.ts";
export interface TextSubmissionTransport {
  readonly dispatch: (
    envelope: PendingSubmissionEnvelopeV1,
  ) => Promise<TextContentSubmissionV1>;
  readonly read: (
    submissionId: string,
  ) => Promise<TextContentSubmissionV1 | null>;
}

export class AmbiguousTextSubmissionError extends Error {
  constructor(message = "The submission result is uncertain") {
    super(message);
    this.name = "AmbiguousTextSubmissionError";
  }
}

/**
 * The server would not act without a signed-in account. Sending the same
 * request again cannot succeed until the author authenticates, and it says
 * nothing about an earlier attempt that went unanswered.
 */
export class TextSubmissionAuthenticationRequiredError extends Error {
  constructor() {
    super("The text submission needs an authenticated session");
    this.name = "TextSubmissionAuthenticationRequiredError";
  }
}

export class IdempotencyConflictError extends Error {
  readonly submission_id: string;

  constructor(submissionId: string) {
    super("The idempotency key is already bound to a different request hash");
    this.name = "IdempotencyConflictError";
    this.submission_id = submissionId;
  }
}

export class TextSubmissionServerRejectionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly definitive: boolean;

  constructor(status: number, code: string, definitive = false) {
    super(`The text submission was rejected with HTTP ${status}`);
    this.name = "TextSubmissionServerRejectionError";
    this.status = status;
    this.code = code;
    this.definitive =
      definitive ||
      (status === 400 && code === "bad_request") ||
      (status === 403 &&
        (code === "membership_required" || code === "gate_unsatisfied")) ||
      (status === 404 && code === "not_found");
  }
}
