import {
  assign,
  createActor,
  fromPromise,
  setup,
  type ActorRefFrom,
} from "xstate";
import type {
  createDanceRecorder,
  DanceRecorderStage,
  DanceRecorderView,
} from "./dance-recorder.ts";
import type { DanceReviewView } from "./dance-review-controller.ts";
import { danceReviewPending } from "./dance-review-api.ts";
import { privateAccessLost } from "../client.ts";

type Recorder = ReturnType<typeof createDanceRecorder>;
interface JourneyContext {
  readonly view: DanceRecorderView | null;
  readonly review: DanceReviewView | null;
  readonly error: unknown;
  readonly stage: DanceRecorderStage;
  readonly elapsed: number;
  readonly observations: number;
}
type JourneyEvent =
  | {
      readonly type:
        | "ACCEPT"
        | "RECORD"
        | "RESUME"
        | "RETRY"
        | "NEW_ATTEMPT"
        | "BACKGROUND"
        | "FOREGROUND"
        | "REVIEW_WRITE"
        | "ACCESS_LOST";
    }
  | { readonly type: "STAGE"; readonly stage: DanceRecorderStage }
  | { readonly type: "PROGRESS"; readonly elapsed: number }
  | { readonly type: "REVIEW_FACT"; readonly view: DanceReviewView }
  | { readonly type: "REVIEW_ERROR"; readonly error: unknown };
interface Operations {
  readonly recorder?: Recorder;
  readonly termsHash?: string;
  readonly initialReview?: boolean;
  readonly preview?: (blob: Blob, expiresAtMs: number) => void;
  readonly pause?: () => void;
}
const session = (view: DanceRecorderView | null) =>
  view?.kind === "camera"
    ? view.ready.session
    : view?.kind === "upload"
      ? view.upload.session
      : view?.session;
const processing = (view: DanceRecorderView | null) =>
  view?.kind === "upload" &&
  (view.upload.kind === "processing" || view.upload.kind === "reconciling");
const authorityChanged = (error: unknown) =>
  privateAccessLost(error) ||
  (error instanceof Error &&
    /scope_changed|account_changed|session_changed|target_changed/u.test(
      error.message,
    ));

/** One owner for camera -> retained preview -> processing -> human review.
 * Only deliberate events can invoke command recovery or submission. Timed
 * observation receives the recorder's separate read-only capability. */
export function createDanceRecorderMachine(operations: Operations) {
  const recorder = () => {
    if (!operations.recorder) throw new Error("dance_recorder_unavailable");
    return operations.recorder;
  };
  return setup({
    // SAFETY: These empty values declare XState’s phantom schema; actual context and events are constructed below.
    types: { context: {} as JourneyContext, events: {} as JourneyEvent },
    actors: {
      prepare: fromPromise<DanceRecorderView>(({ signal }) =>
        recorder().prepare(operations.termsHash!, signal),
      ),
      enter: fromPromise<DanceRecorderView, JourneyContext>(
        ({ input, signal }) => {
          const selected = input.view;
          if (!selected) throw new Error("dance_recorder_unavailable");
          return recorder().enter(
            selected.kind === "objectives"
              ? selected.context.consent.termsHash
              : session(selected)!.terms_hash,
            signal,
          );
        },
      ),
      record: fromPromise<
        DanceRecorderView,
        { readonly report: (event: JourneyEvent) => void }
      >(({ signal, input }) =>
        recorder().record(
          signal,
          (stage) => input.report({ type: "STAGE", stage }),
          (elapsed) => input.report({ type: "PROGRESS", elapsed }),
          (take, expires) => operations.preview?.(take.file, expires),
        ),
      ),
      observe: fromPromise<DanceRecorderView, JourneyContext>(
        ({ input, signal }) => {
          const selected = session(input.view);
          if (!selected) throw new Error("dance_recorder_unavailable");
          return recorder().observe(selected, signal);
        },
      ),
      recover: fromPromise<DanceRecorderView>(({ signal }) =>
        recorder().recover(operations.termsHash!, signal, () => {}),
      ),
      resume: fromPromise<DanceRecorderView, JourneyContext>(
        async ({ input, signal }) => {
          const selected = session(input.view);
          if (!selected) throw new Error("dance_recorder_unavailable");
          const saved = await recorder().localPreview(
            selected.session_id,
            signal,
          );
          if (saved) operations.preview?.(saved.blob, saved.expiresAtMs);
          return recorder().resume(selected.session_id, signal);
        },
      ),
      newAttempt: fromPromise<DanceRecorderView>(({ signal }) =>
        recorder().newAttempt(operations.termsHash!, signal),
      ),
    },
    actions: {
      // SAFETY: Only the typed promise actors below dispatch done events to this action; every actor returns DanceRecorderView.
      saveView: assign(({ event }) => ({
        view: "output" in event ? (event.output as DanceRecorderView) : null,
        error: null,
      })),
      failure: assign(({ event }) => ({
        error:
          "error" in event
            ? event.error
            : new Error("dance_recorder_unavailable"),
      })),
      pause: () => operations.pause?.(),
      clearPrivate: assign({ view: null, review: null, error: null }),
      resetReads: assign({ observations: 0 }),
      incrementReads: assign(({ context }) => ({
        observations: context.observations + 1,
      })),
    },
  }).createMachine({
    id: "danceJourney",
    initial: "initializing",
    context: {
      view: null,
      review: null,
      error: null,
      stage: "preparing_audio",
      elapsed: 0,
      observations: 0,
    },
    on: {
      BACKGROUND: { target: ".paused", actions: "pause" },
      ACCESS_LOST: { target: ".recovery", actions: ["pause", "clearPrivate"] },
    },
    states: {
      initializing: {
        always: [
          { guard: () => !!operations.initialReview, target: "review" },
          { target: "preparing" },
        ],
      },
      preparing: {
        invoke: {
          src: "prepare",
          onDone: { actions: "saveView", target: "route" },
          onError: { actions: "failure", target: "recovery" },
        },
      },
      route: {
        always: [
          {
            guard: ({ context }) =>
              context.view?.kind === "objectives" &&
              !!context.view.consentRequested,
            target: "entering",
          },
          {
            guard: ({ context }) => context.view?.kind === "objectives",
            target: "objectives",
          },
          {
            guard: ({ context }) => context.view?.kind === "camera",
            target: "camera",
          },
          {
            guard: ({ context }) => processing(context.view),
            target: "processing",
            actions: "resetReads",
          },
          {
            guard: ({ context }) =>
              context.view?.kind === "upload" &&
              ["review", "terminal"].includes(context.view.upload.kind),
            target: "review",
          },
          { target: "recovery" },
        ],
      },
      objectives: { on: { ACCEPT: "entering" } },
      entering: {
        invoke: {
          src: "enter",
          input: ({ context }) => context,
          onDone: { actions: "saveView", target: "route" },
          onError: { actions: "failure", target: "recovery" },
        },
      },
      camera: { on: { RECORD: "capturing" } },
      capturing: {
        entry: assign({ elapsed: 0, stage: "preparing_audio" }),
        invoke: {
          src: "record",
          input: ({ self }) => ({ report: (event) => self.send(event) }),
          onDone: { actions: "saveView", target: "route" },
          onError: { actions: "failure", target: "recovery" },
        },
        on: {
          STAGE: { actions: assign(({ event }) => ({ stage: event.stage })) },
          PROGRESS: {
            actions: assign(({ event }) => ({ elapsed: event.elapsed })),
          },
        },
      },
      processing: {
        initial: "reading",
        states: {
          reading: {
            entry: "incrementReads",
            invoke: {
              src: "observe",
              input: ({ context }) => context,
              onDone: [
                {
                  guard: ({ event }) => processing(event.output),
                  actions: "saveView",
                  target: "waiting",
                },
                { actions: "saveView", target: "#danceJourney.route" },
              ],
              onError: [
                {
                  guard: ({ event }) => authorityChanged(event.error),
                  actions: ["failure", "pause"],
                  target: "#danceJourney.recovery",
                },
                { actions: "failure", target: "interrupted" },
              ],
            },
            after: { 15000: "interrupted" },
          },
          waiting: {
            after: {
              2000: [
                {
                  guard: ({ context }) => context.observations < 90,
                  target: "reading",
                },
                { target: "resting" },
              ],
            },
          },
          interrupted: {},
          resting: {},
        },
        on: {
          FOREGROUND: { target: ".reading", actions: "resetReads" },
          RETRY: { target: ".reading", actions: "resetReads" },
        },
      },
      recovery: {
        on: {
          RETRY: "recovering",
          RESUME: "resuming",
          NEW_ATTEMPT: "newAttempt",
        },
      },
      recovering: {
        invoke: {
          src: "recover",
          onDone: { actions: "saveView", target: "route" },
          onError: { actions: "failure", target: "recovery" },
        },
      },
      resuming: {
        invoke: {
          src: "resume",
          input: ({ context }) => context,
          onDone: { actions: "saveView", target: "route" },
          onError: { actions: "failure", target: "recovery" },
        },
      },
      newAttempt: {
        invoke: {
          src: "newAttempt",
          onDone: { actions: "saveView", target: "route" },
          onError: { actions: "failure", target: "recovery" },
        },
      },
      paused: {
        on: {
          FOREGROUND: [
            {
              guard: ({ context }) => processing(context.view),
              target: "processing",
              actions: "resetReads",
            },
            {
              guard: ({ context }) =>
                !!context.review ||
                (context.view?.kind === "upload" &&
                  ["review", "terminal"].includes(context.view.upload.kind)),
              target: "review",
            },
            { target: "recovery" },
          ],
        },
      },
      review: {
        initial: "loading",
        on: {
          REVIEW_FACT: {
            actions: assign(({ event }) => ({
              review: event.view,
              error: null,
            })),
            target: ".routing",
          },
          REVIEW_ERROR: { actions: "failure", target: ".error" },
        },
        states: {
          loading: {},
          routing: {
            always: [
              {
                guard: ({ context }) =>
                  context.review?.result.state === "uploaded",
                target: "ready",
              },
              {
                guard: ({ context }) =>
                  !!context.review && danceReviewPending(context.review.result),
                target: "pending",
              },
              { target: "result" },
            ],
          },
          ready: { on: { REVIEW_WRITE: "submitting" } },
          pending: { on: { REVIEW_WRITE: "submitting" } },
          submitting: {},
          result: {},
          error: {},
        },
      },
    },
  });
}
export type DanceJourneyActor = ActorRefFrom<
  ReturnType<typeof createDanceRecorderMachine>
>;
export const createDanceJourneyActor = (operations: Operations) =>
  createActor(createDanceRecorderMachine(operations));
