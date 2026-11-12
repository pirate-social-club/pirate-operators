import { assign, fromPromise, setup } from "xstate";

import type { PendingSubmissionEnvelopeV1 } from "../post-composer/pending-submission.ts";
import type { TextContentSubmissionV1 } from "../post-composer/text-submission-contract.ts";
import {
  IdempotencyConflictError,
  TextSubmissionAuthenticationRequiredError,
  TextSubmissionServerRejectionError,
  type TextSubmissionTransport,
} from "../post-composer/text-submission-transport.ts";

/** Why the server refused a text post. Only a definitive answer lands here;
 * anything the client could not read is unconfirmed, never a refusal. */
export type TextSubmissionRejection =
  | "not_allowed"
  | "invalid"
  | "held"
  | "blocked";

export interface TextSubmissionContext {
  /** The exact request, kept for the life of the operation. Every attempt
   * sends these bytes under this idempotency key. */
  readonly envelope: PendingSubmissionEnvelopeV1;
  readonly startHeld: boolean;
  readonly attempts: number;
  readonly submissionId: string | null;
  readonly postHref: string | null;
  readonly postId: string | null;
  readonly rejection: TextSubmissionRejection | null;
}

export type TextSubmissionEvent =
  /** Send again now instead of waiting for the timer. */
  | { readonly type: "RETRY" }
  /** The account is no longer signed in; hold the request without sending. */
  | { readonly type: "PAUSE" }
  /** The same account is signed in again; send the held request. */
  | { readonly type: "RESUME" };

export interface TextSubmissionInput {
  readonly envelope: PendingSubmissionEnvelopeV1;
  /** Nobody is signed in: start held instead of sending. */
  readonly held?: boolean;
}

/** Attempts before the author is told the post is taking longer than usual. */
export const DELAYED_AFTER_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

/** How long one attempt may stay unanswered before it counts as unconfirmed. */
export const ATTEMPT_TIMEOUT_MS = 15_000;

class AttemptTimedOut extends Error {}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AttemptTimedOut()),
      ATTEMPT_TIMEOUT_MS,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function retryDelayMs(attempts: number): number {
  return (
    RETRY_DELAYS_MS[
      Math.min(Math.max(attempts, 1), RETRY_DELAYS_MS.length) - 1
    ] ?? 15_000
  );
}

type Outcome =
  | {
      readonly kind: "published";
      readonly postHref: string;
      readonly postId: string;
    }
  | { readonly kind: "rejected"; readonly rejection: TextSubmissionRejection }
  | { readonly kind: "sign_in_required" }
  | { readonly kind: "unconfirmed" };

function projectSnapshot(snapshot: TextContentSubmissionV1): Outcome {
  if (snapshot.status === "published") {
    return snapshot.published_resource?.kind === "post"
      ? {
          kind: "published",
          postHref: snapshot.published_resource.href,
          postId: snapshot.published_resource.post_id,
        }
      : { kind: "unconfirmed" };
  }
  return {
    kind: "rejected",
    rejection: snapshot.status === "blocked" ? "blocked" : "held",
  };
}

function rejectionFor(
  error: TextSubmissionServerRejectionError,
): TextSubmissionRejection {
  return error.status === 403 || error.status === 404
    ? "not_allowed"
    : "invalid";
}

/**
 * One text post from the moment it is sent until the server has answered.
 *
 * The author sees the post at once, so this machine has no state that asks
 * them to wait or to check. A response the client could not read is replayed
 * with the same bytes and key until the server answers; the server returns the
 * original result for a key it has already seen, so a replay confirms a post
 * that was published without creating a second one.
 *
 * A request the server refuses for lack of a session is held, not retried on
 * a timer: it cannot succeed until the author signs in again, and resuming it
 * replays the same request, which also settles any earlier attempt that went
 * unanswered.
 */
export function createTextSubmissionMachine(
  transport: TextSubmissionTransport,
) {
  return setup({
    types: {
      // SAFETY: type carrier only.
      context: {} as TextSubmissionContext,
      // SAFETY: type carrier only.
      events: {} as TextSubmissionEvent,
      // SAFETY: type carrier only.
      input: {} as TextSubmissionInput,
    },
    actors: {
      deliver: fromPromise<
        Outcome,
        {
          readonly envelope: PendingSubmissionEnvelopeV1;
          readonly submissionId: string | null;
        }
      >(async ({ input, signal }) => {
        try {
          // A retained ID alone has no binding proof to this envelope. The
          // current transport has no hash-bound read receipt, so reconcile by
          // dispatching only the original bytes/key. Never read/adopt the ID
          // named by a different-request-hash conflict (or a legacy envelope).
          // A stalled connection must not hold the post on its first
          // attempt: an unanswered request is unconfirmed like any other,
          // and the replay is safe because the key is the same.
          const snapshot = await withTimeout(
            transport.dispatch(input.envelope),
          );
          signal.throwIfAborted();
          return projectSnapshot(snapshot);
        } catch (error) {
          if (error instanceof IdempotencyConflictError)
            return { kind: "unconfirmed" };
          if (error instanceof TextSubmissionAuthenticationRequiredError)
            return { kind: "sign_in_required" };
          if (
            error instanceof TextSubmissionServerRejectionError &&
            error.definitive
          ) {
            return { kind: "rejected", rejection: rejectionFor(error) };
          }
          return { kind: "unconfirmed" };
        }
      }),
    },
    delays: {
      retryDelay: ({ context }) => retryDelayMs(context.attempts),
    },
  }).createMachine({
    id: "textSubmission",
    context: ({ input }) => ({
      envelope: input.envelope,
      startHeld: input.held === true,
      attempts: 0,
      submissionId: input.envelope.submission_id,
      postHref: null,
      postId: null,
      rejection: null,
    }),
    initial: "starting",
    states: {
      // Decides once whether the first request may go out at all. A post
      // prepared while nobody is signed in begins held and sends nothing.
      starting: {
        always: [
          {
            guard: ({ context }) => context.startHeld,
            target: "signInRequired",
          },
          { target: "sending" },
        ],
      },
      sending: {
        entry: assign({ attempts: ({ context }) => context.attempts + 1 }),
        invoke: {
          src: "deliver",
          input: ({ context }) => ({
            envelope: context.envelope,
            submissionId: context.submissionId,
          }),
          onDone: [
            {
              guard: ({ event }) => event.output.kind === "published",
              target: "published",
              actions: assign({
                postHref: ({ event }) =>
                  event.output.kind === "published"
                    ? event.output.postHref
                    : null,
                postId: ({ event }) =>
                  event.output.kind === "published"
                    ? event.output.postId
                    : null,
              }),
            },
            {
              guard: ({ event }) => event.output.kind === "rejected",
              target: "rejected",
              actions: assign({
                rejection: ({ event }) =>
                  event.output.kind === "rejected"
                    ? event.output.rejection
                    : null,
              }),
            },
            {
              guard: ({ event }) => event.output.kind === "sign_in_required",
              target: "signInRequired",
            },
            { target: "waiting" },
          ],
          onError: { target: "waiting" },
        },
        on: { PAUSE: { target: "signInRequired" } },
      },
      waiting: {
        after: { retryDelay: { target: "sending" } },
        on: {
          RETRY: { target: "sending" },
          PAUSE: { target: "signInRequired" },
        },
      },
      signInRequired: {
        on: { RESUME: { target: "sending" } },
      },
      published: { type: "final" },
      rejected: { type: "final" },
    },
  });
}

export type TextSubmissionMachine = ReturnType<
  typeof createTextSubmissionMachine
>;
