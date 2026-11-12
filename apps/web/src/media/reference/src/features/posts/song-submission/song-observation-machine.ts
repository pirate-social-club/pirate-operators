import { assign, fromPromise, setup } from "xstate";

import type { MediaSubmissionSnapshot } from "../media-submission/projection.ts";
import {
  projectMediaSubmission,
  type SongSubmissionView,
} from "../media-submission/projection.ts";

/** The part of the song coordinator the observer needs once a song is submitted. */
export interface SongObservationSource {
  /** Reads the submission's current state from the server. */
  readonly refresh: (
    signal?: AbortSignal,
  ) => Promise<MediaSubmissionSnapshot | null>;
  /** Asks the server to run processing again after a retryable failure. */
  readonly retry: (signal?: AbortSignal) => Promise<MediaSubmissionSnapshot>;
  readonly hasPendingOriginal?: () => boolean;
  readonly retryOriginal?: (
    signal?: AbortSignal,
  ) => Promise<MediaSubmissionSnapshot>;
  readonly bindOriginal?: (
    link: string,
    signal?: AbortSignal,
  ) => Promise<MediaSubmissionSnapshot>;
}

export interface SongObservationContext {
  readonly view: SongSubmissionView;
  /** Consecutive reads that did not return a state. */
  readonly failures: number;
  readonly startHeld: boolean;
  readonly originalLink: string;
  readonly originalRetry: boolean;
  readonly originalError: string | null;
}

export type SongObservationEvent =
  /** Read again now instead of waiting for the timer. */
  | { readonly type: "CHECK" }
  /** Run processing again after it failed. */
  | { readonly type: "RETRY" }
  | { readonly type: "BIND_ORIGINAL"; readonly link: string }
  | { readonly type: "RETRY_ORIGINAL" }
  /** The session ended: stop reading until the same account is back. */
  | { readonly type: "PAUSE" }
  | { readonly type: "RESUME" };

export interface SongObservationInput {
  readonly view: SongSubmissionView;
  readonly held?: boolean;
}

export const OBSERVE_INTERVAL_MS = 3_000;
export const OBSERVE_REQUEST_TIMEOUT_MS = 15_000;
/** Unanswered reads before the author is told checking is taking longer. */
export const SLOW_AFTER_FAILURES = 3;

export function observeDelayMs(
  failures: number,
  intervalMs = OBSERVE_INTERVAL_MS,
): number {
  return failures === 0
    ? intervalMs
    : Math.min(intervalMs * 10, intervalMs * 2 ** Math.min(failures, 4));
}

/** The server will not change this state on its own. */
export function settled(view: SongSubmissionView): boolean {
  return (
    view.status === "published" ||
    view.status === "blocked" ||
    view.status === "abandoned"
  );
}

/** Processing stopped and only the author can move it on. */
function needsAuthor(view: SongSubmissionView): boolean {
  return (
    view.status === "processing_failed" || view.status === "action_required"
  );
}

/**
 * Watches one submitted song until the server publishes or refuses it.
 *
 * The song steps end when the server accepts the submission. From then on the
 * author is free to leave, and this machine is the only thing reading the
 * song's state. A read that fails says nothing about the song, so it is tried
 * again on a slower timer and never turned into a failure of the song itself.
 */
export function createSongObservationMachine(
  source: SongObservationSource,
  intervalMs = OBSERVE_INTERVAL_MS,
  requestTimeoutMs = OBSERVE_REQUEST_TIMEOUT_MS,
) {
  return setup({
    types: {
      // SAFETY: type carrier only.
      context: {} as SongObservationContext,
      // SAFETY: type carrier only.
      events: {} as SongObservationEvent,
      // SAFETY: type carrier only.
      input: {} as SongObservationInput,
    },
    actors: {
      read: fromPromise<SongSubmissionView | null>(async ({ signal }) => {
        const snapshot = await source.refresh(signal);
        return snapshot === null ? null : projectMediaSubmission(snapshot);
      }),
      bindOriginal: fromPromise<
        SongSubmissionView,
        { link: string; retry: boolean }
      >(async ({ input, signal }) => {
        if (input.retry && source.retryOriginal !== undefined)
          return projectMediaSubmission(await source.retryOriginal(signal));
        if (source.bindOriginal === undefined)
          throw new Error("Original song selection is unavailable here.");
        return projectMediaSubmission(
          await source.bindOriginal(input.link, signal),
        );
      }),
      rerun: fromPromise<SongSubmissionView>(async ({ signal }) =>
        projectMediaSubmission(await source.retry(signal)),
      ),
    },
    delays: {
      observeDelay: ({ context }) =>
        observeDelayMs(context.failures, intervalMs),
      idleDelay: intervalMs * 10,
      requestTimeout: requestTimeoutMs,
    },
    guards: {
      isSettled: ({ context }) => settled(context.view),
      needsAuthor: ({ context }) => needsAuthor(context.view),
    },
  }).createMachine({
    id: "songObservation",
    context: ({ input }) => ({
      view: input.view,
      failures: 0,
      startHeld: input.held === true,
      originalLink: "",
      originalRetry: false,
      originalError: null,
    }),
    initial: "starting",
    states: {
      starting: {
        always: [
          {
            guard: ({ context }) => context.startHeld && !settled(context.view),
            target: "held",
          },
          { target: "routing" },
        ],
      },
      // Where a known state belongs. Entered at the start and after every read.
      routing: {
        always: [
          { guard: "isSettled", target: "settled" },
          { guard: "needsAuthor", target: "waitingForAuthor" },
          { target: "waiting" },
        ],
      },
      waiting: {
        after: { observeDelay: { target: "reading" } },
        on: {
          CHECK: { target: "reading" },
          PAUSE: { target: "held" },
          RETRY_ORIGINAL: {
            guard: () =>
              source.hasPendingOriginal?.() === true &&
              source.retryOriginal !== undefined,
            target: "bindingOriginal",
            actions: assign({ originalRetry: true, originalError: null }),
          },
          BIND_ORIGINAL: {
            guard: ({ context }) =>
              context.view.status === "action_required" &&
              source.bindOriginal !== undefined &&
              !source.hasPendingOriginal?.(),
            target: "bindingOriginal",
            actions: assign({
              originalLink: ({ event }) => event.link,
              originalRetry: false,
              originalError: null,
            }),
          },
          RETRY: {
            guard: ({ context }) =>
              context.view.status === "processing_failed" &&
              context.view.retryable,
            target: "rerunning",
          },
        },
      },
      reading: {
        after: {
          requestTimeout: {
            target: "waiting",
            actions: assign({
              failures: ({ context }) => context.failures + 1,
            }),
          },
        },
        invoke: {
          src: "read",
          onDone: [
            {
              guard: ({ event }) => event.output !== null,
              target: "routing",
              actions: assign({
                view: ({ event, context }) => event.output ?? context.view,
                failures: 0,
              }),
            },
            {
              target: "waiting",
              actions: assign({
                failures: ({ context }) => context.failures + 1,
              }),
            },
          ],
          onError: {
            target: "waiting",
            actions: assign({
              failures: ({ context }) => context.failures + 1,
            }),
          },
        },
        on: {
          PAUSE: { target: "held" },
          RETRY_ORIGINAL: {
            guard: () =>
              source.hasPendingOriginal?.() === true &&
              source.retryOriginal !== undefined,
            target: "bindingOriginal",
            actions: assign({ originalRetry: true, originalError: null }),
          },
          BIND_ORIGINAL: {
            guard: ({ context }) =>
              context.view.status === "action_required" &&
              source.bindOriginal !== undefined &&
              !source.hasPendingOriginal?.(),
            target: "bindingOriginal",
            actions: assign({
              originalLink: ({ event }) => event.link,
              originalRetry: false,
              originalError: null,
            }),
          },
          RETRY: {
            guard: ({ context }) =>
              context.view.status === "processing_failed" &&
              context.view.retryable,
            target: "rerunning",
          },
        },
      },
      waitingForAuthor: {
        // Nothing moves until the author acts, but the server can still end
        // the wait on its own, for instance when a request for the original
        // song expires. Keep reading, slowly.
        after: { idleDelay: { target: "reading" } },
        on: {
          RETRY_ORIGINAL: {
            guard: () =>
              source.hasPendingOriginal?.() === true &&
              source.retryOriginal !== undefined,
            target: "bindingOriginal",
            actions: assign({ originalRetry: true, originalError: null }),
          },
          BIND_ORIGINAL: {
            guard: ({ context }) =>
              context.view.status === "action_required" &&
              source.bindOriginal !== undefined &&
              !source.hasPendingOriginal?.(),
            target: "bindingOriginal",
            actions: assign({
              originalLink: ({ event }) => event.link,
              originalRetry: false,
              originalError: null,
            }),
          },
          RETRY: {
            guard: ({ context }) =>
              context.view.status === "processing_failed" &&
              context.view.retryable,
            target: "rerunning",
          },
          CHECK: { target: "reading" },
          PAUSE: { target: "held" },
        },
      },
      bindingOriginal: {
        after: {
          requestTimeout: {
            target: "reading",
            actions: assign({
              originalError:
                "The request went unanswered. Checking whether the original was saved.",
            }),
          },
        },
        invoke: {
          src: "bindOriginal",
          input: ({ context }) => ({
            link: context.originalLink,
            retry: context.originalRetry,
          }),
          onDone: {
            target: "routing",
            actions: assign({
              view: ({ event }) => event.output,
              failures: 0,
              originalError: null,
            }),
          },
          onError: {
            target: "reading",
            actions: assign({
              originalError:
                "We couldn't confirm that original song. Check its link and whether this song can use it, then try again.",
            }),
          },
        },
        on: { PAUSE: { target: "held" } },
      },
      rerunning: {
        after: { requestTimeout: { target: "reading" } },
        invoke: {
          src: "rerun",
          onDone: {
            target: "routing",
            actions: assign({ view: ({ event }) => event.output, failures: 0 }),
          },
          // The request went unanswered, which says nothing about whether the
          // server took it. Read the song's state instead of assuming it is
          // unchanged: it may already be processing again.
          onError: { target: "reading" },
        },
        on: { PAUSE: { target: "held" } },
      },
      held: {
        on: { RESUME: { target: "reading" } },
      },
      settled: { type: "final" },
    },
  });
}

export type SongObservationMachine = ReturnType<
  typeof createSongObservationMachine
>;
