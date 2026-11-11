import { assign, fromCallback, fromPromise, sendTo, setup } from "xstate";
import {
  VIDEO_FINALIZATION_TIMEOUT_MS,
  VIDEO_PREPARATION_TIMEOUT_NOTICE,
} from "./video-preparation-deadline.ts";
import type { ExcerptBounds } from "../post-composer/song-excerpt.ts";
import type { SoundtrackSelection } from "../post-composer/song-excerpt-composer.tsx";
import type { SongSourceState } from "../post-composer/song-excerpt-source.ts";
import type { VideoCaptureSession } from "./capture.ts";
import type { PendingVideo } from "./coordinator.ts";
import type { GuideAudio } from "./video-composer-media.ts";
import type { SongChoice, SongPlanState } from "./song-reference.ts";

export type CaptureIssue =
  | "camera_denied"
  | "capability_unavailable"
  | "recording_failed"
  | "orientation_lost"
  | "guide_interrupted";
export type TakeAlignment = "none" | "aligned" | "unaligned";
export type TakeSoundtrack = {
  readonly songPostId: string;
  readonly bounds: ExcerptBounds;
};

export interface ComposerContext {
  readonly record: PendingVideo | null;
  readonly file: File | null;
  readonly rating: "general" | "adult_18";
  readonly selection: SoundtrackSelection | null;
  readonly songPlan: SongPlanState;
  readonly songChoice: SongChoice;
  readonly songSource: SongSourceState["kind"];
  readonly clipDurationMs: number | null;
  readonly takeSoundtrack: TakeSoundtrack | null;
  readonly takeAlignment: TakeAlignment;
  readonly error: string;
  readonly progress: string;
  readonly issue: CaptureIssue | null;
  readonly playbackFailed: boolean;
  readonly submittedFromReview: boolean;
  readonly enteredCapture: boolean;
  readonly confirmRequested: boolean;
  readonly visible: boolean;
  readonly prepared: GuideAudio | null;
  readonly session: VideoCaptureSession | null;
  readonly guideStartDelayMs: number;
  readonly guideStarted: boolean;
}

export type ComposerEvent =
  | { readonly type: "SONG_PLAN"; readonly plan: SongPlanState }
  | { readonly type: "SONG_CHOICE"; readonly choice: SongChoice }
  | { readonly type: "SONG_SOURCE"; readonly source: SongSourceState["kind"] }
  | {
      readonly type: "SELECTION";
      readonly selection: SoundtrackSelection | null;
    }
  | { readonly type: "CONTINUE" }
  | { readonly type: "BACK_FROM_SONG" }
  | { readonly type: "OPEN_SONG" }
  | { readonly type: "RECORD" }
  | { readonly type: "STOP" }
  | { readonly type: "INTERRUPT" }
  | { readonly type: "CAPTURE_LIMIT" }
  | {
      readonly type: "CAPTURE_FAILURE";
      readonly reason: string;
      readonly issue: CaptureIssue | null;
    }
  | { readonly type: "FILE"; readonly file: File }
  | { readonly type: "RETAKE" }
  | { readonly type: "BACK_FROM_REVIEW" }
  | { readonly type: "PUBLISH" }
  | { readonly type: "START_OVER" }
  | { readonly type: "RECORD_CHANGED"; readonly record: PendingVideo | null }
  | { readonly type: "PROGRESS"; readonly progress: string }
  | { readonly type: "VISIBILITY"; readonly visible: boolean }
  | { readonly type: "PREVIEW_CHECK" }
  | { readonly type: "TICK" }
  | { readonly type: "SET_RATING"; readonly rating: "general" | "adult_18" };

interface PreparedTake {
  readonly guide: SoundtrackSelection;
  readonly audio: GuideAudio;
}
interface CaptureStarted {
  readonly session: VideoCaptureSession;
  readonly prepared: PreparedTake;
}
interface GuideStarted {
  readonly started: boolean;
  readonly delayMs: number;
}
interface FinishedTake {
  readonly file: File;
  readonly durationMs: number | null;
  readonly alignment: TakeAlignment;
}
interface RestoredVideo {
  readonly record: PendingVideo | null;
  readonly released: boolean;
  readonly resume: boolean;
}
interface PublishedVideo {
  readonly posted: boolean;
}

/** Device calls live in the component-owned media adapter. Each async call is
 * invoked only for the state that needs it; leaving that state aborts its
 * signal, and the adapter releases any result that arrives late. */
export interface ComposerOperations {
  readonly restore: (signal: AbortSignal) => Promise<RestoredVideo>;
  readonly checkPlayback: (
    selection: SoundtrackSelection,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly inspectFile: (
    file: File,
    signal: AbortSignal,
  ) => Promise<FinishedTake>;
  readonly prepareGuide: (
    selection: SoundtrackSelection,
    signal: AbortSignal,
  ) => Promise<PreparedTake>;
  readonly startCapture: (
    prepared: PreparedTake,
    signal: AbortSignal,
  ) => Promise<CaptureStarted>;
  readonly startGuide: (
    started: CaptureStarted,
    signal: AbortSignal,
  ) => Promise<GuideStarted>;
  readonly finishCapture: (
    context: ComposerContext,
    signal: AbortSignal,
  ) => Promise<FinishedTake>;
  readonly cancelCapture: (
    context: ComposerContext,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly publish: (
    context: ComposerContext,
    signal: AbortSignal,
  ) => Promise<PublishedVideo>;
  readonly startOver: (
    context: ComposerContext,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly refresh: (
    context: ComposerContext,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly canCapture: (context: ComposerContext) => boolean;
  readonly canPublish: (context: ComposerContext) => boolean;
  readonly shouldRefresh: (context: ComposerContext) => boolean;
  readonly onPosted: () => void;
  readonly onExit: () => void;
  readonly onReset: () => void;
  readonly syncPreview: () => void;
  readonly closePreview: () => void;
  readonly discardPrepared: () => void;
}

const message = (failure: unknown, fallback: string) =>
  failure instanceof Error ? failure.message : fallback;

export function createVideoComposerMachine(
  operations: ComposerOperations,
  initiallyVisible: boolean,
) {
  return setup({
    types: {
      // SAFETY: XState's setup types use these empty values only to infer the
      // declared context and event contracts; runtime context is set below.
      context: {} as ComposerContext,
      // SAFETY: Event values are supplied by send, never by this type witness.
      events: {} as ComposerEvent,
    },
    actors: {
      restore: fromPromise<RestoredVideo, void>(({ signal }) =>
        operations.restore(signal),
      ),
      checkPlayback: fromPromise<void, SoundtrackSelection>(
        ({ input, signal }) => operations.checkPlayback(input, signal),
      ),
      inspectFile: fromPromise<FinishedTake, File>(({ input, signal }) =>
        operations.inspectFile(input, signal),
      ),
      prepareGuide: fromPromise<PreparedTake, SoundtrackSelection>(
        ({ input, signal }) => operations.prepareGuide(input, signal),
      ),
      startCapture: fromPromise<CaptureStarted, PreparedTake>(
        ({ input, signal }) => operations.startCapture(input, signal),
      ),
      startGuide: fromPromise<GuideStarted, CaptureStarted>(
        ({ input, signal }) => operations.startGuide(input, signal),
      ),
      finishCapture: fromPromise<FinishedTake, ComposerContext>(
        ({ input, signal }) => operations.finishCapture(input, signal),
      ),
      cancelCapture: fromPromise<void, ComposerContext>(({ input, signal }) =>
        operations.cancelCapture(input, signal),
      ),
      publish: fromPromise<PublishedVideo, ComposerContext>(
        ({ input, signal }) => operations.publish(input, signal),
      ),
      startOver: fromPromise<void, ComposerContext>(({ input, signal }) =>
        operations.startOver(input, signal),
      ),
      refresh: fromPromise<boolean, ComposerContext>(({ input, signal }) =>
        operations.refresh(input, signal),
      ),
      poll: fromCallback<Extract<ComposerEvent, { type: "TICK" }>>(
        ({ sendBack }) => {
          const timer = setInterval(() => sendBack({ type: "TICK" }), 3_000);
          return () => clearInterval(timer);
        },
      ),
      preview: fromCallback<{ type: "CHECK" }>(({ receive }) => {
        let active = true;
        receive(() => {
          if (active) operations.syncPreview();
        });
        queueMicrotask(() => {
          if (active) operations.syncPreview();
        });
        return () => {
          active = false;
          operations.closePreview();
        };
      }),
    },
    guards: {
      canCapture: ({ context }) => operations.canCapture(context),
      canPublish: ({ context }) => operations.canPublish(context),
      shouldRefresh: ({ context }) => operations.shouldRefresh(context),
      wantsCapture: ({ context }) =>
        context.confirmRequested && operations.canCapture(context),
      wantsReview: ({ context }) =>
        context.confirmRequested &&
        context.file !== null &&
        operations.canCapture(context),
      canReview: ({ context }) =>
        context.file !== null && operations.canCapture(context),
      captureBlocked: ({ context }) => !operations.canCapture(context),
      hasFile: ({ context }) => context.file !== null,
    },
  }).createMachine({
    id: "videoComposer",
    initial: "restoring",
    context: {
      record: null,
      file: null,
      rating: "general",
      selection: null,
      songPlan: { kind: "none" },
      songChoice: { kind: "none" },
      songSource: "idle",
      clipDurationMs: null,
      takeSoundtrack: null,
      takeAlignment: "none",
      error: "",
      progress: "",
      issue: null,
      playbackFailed: false,
      submittedFromReview: false,
      enteredCapture: false,
      confirmRequested: false,
      visible: initiallyVisible,
      prepared: null,
      session: null,
      guideStartDelayMs: 0,
      guideStarted: false,
    },
    on: {
      RECORD_CHANGED: {
        actions: assign({ record: ({ event }) => event.record }),
      },
      PROGRESS: {
        actions: assign({ progress: ({ event }) => event.progress }),
      },
      SONG_PLAN: {
        actions: assign({
          songPlan: ({ event }) => event.plan,
          confirmRequested: ({ context, event }) =>
            [
              "refused",
              "failed",
              "ineligible",
              "not_available",
              "timing_unavailable",
            ].includes(event.plan.kind)
              ? false
              : context.confirmRequested,
        }),
      },
      SONG_CHOICE: {
        actions: assign({
          songChoice: ({ event }) => event.choice,
          playbackFailed: false,
          error: "",
        }),
      },
      SONG_SOURCE: {
        actions: assign({ songSource: ({ event }) => event.source }),
      },
      SELECTION: {
        actions: assign({ selection: ({ event }) => event.selection }),
      },
      SET_RATING: { actions: assign({ rating: ({ event }) => event.rating }) },
      VISIBILITY: {
        actions: assign({ visible: ({ event }) => event.visible }),
      },
    },
    states: {
      restoring: {
        invoke: {
          src: "restore",
          onDone: [
            {
              guard: ({ event }) => event.output.resume,
              target: "submitting",
              actions: assign({
                record: ({ event }) => event.output.record,
                file: ({ event }) => event.output.record?.file ?? null,
                rating: ({ event }) => event.output.record?.rating ?? "general",
              }),
            },
            {
              guard: ({ event }) => event.output.record !== null,
              target: "retained",
              actions: assign({
                record: ({ event }) => event.output.record,
                file: ({ event }) => event.output.record?.file ?? null,
                rating: ({ event }) => event.output.record?.rating ?? "general",
              }),
            },
            { target: "choosingSong" },
          ],
          onError: {
            target: "choosingSong",
            actions: assign({
              error: ({ event }) =>
                message(event.error, "Video restore failed"),
            }),
          },
        },
      },
      choosingSong: {
        always: [
          {
            guard: "wantsReview",
            target: "review",
            actions: assign({
              confirmRequested: false,
              playbackFailed: false,
              error: "",
            }),
          },
          { guard: "wantsCapture", target: "checkingPlayback" },
        ],
        on: {
          CONTINUE: [
            {
              guard: "canReview",
              target: "review",
              actions: assign({
                confirmRequested: false,
                playbackFailed: false,
                error: "",
              }),
            },
            { guard: "canCapture", target: "checkingPlayback" },
            {
              guard: ({ context }) =>
                context.songPlan.kind === "checking" ||
                context.songPlan.kind === "measuring",
              actions: assign({ confirmRequested: true }),
            },
          ],
          BACK_FROM_SONG: [
            {
              guard: "hasFile",
              target: "review",
              actions: assign({ confirmRequested: false }),
            },
            {
              guard: ({ context }) => context.enteredCapture,
              target: "capture",
              actions: assign({ confirmRequested: false }),
            },
            {
              actions: [
                assign({ confirmRequested: false }),
                () => operations.onExit(),
              ],
            },
          ],
        },
      },
      checkingPlayback: {
        entry: assign({
          confirmRequested: false,
          playbackFailed: false,
          error: "",
        }),
        invoke: {
          src: "checkPlayback",
          input: ({ context }) => context.selection!,
          onDone: [
            {
              guard: "canCapture",
              target: "capture",
              actions: assign({
                enteredCapture: true,
                confirmRequested: false,
                playbackFailed: false,
                error: "",
              }),
            },
            { target: "choosingSong" },
          ],
          onError: {
            target: "choosingSong",
            actions: assign({
              confirmRequested: false,
              playbackFailed: true,
              error: ({ event }) =>
                message(
                  event.error,
                  "This song won’t play. Try again or choose another song.",
                ),
            }),
          },
        },
        on: {
          SELECTION: {
            target: "choosingSong",
            actions: assign({ selection: ({ event }) => event.selection }),
          },
          SONG_CHOICE: {
            target: "choosingSong",
            actions: assign({ songChoice: ({ event }) => event.choice }),
          },
          BACK_FROM_SONG: [
            { guard: "hasFile", target: "review" },
            {
              guard: ({ context }) => context.enteredCapture,
              target: "capture",
            },
            { target: "choosingSong", actions: () => operations.onExit() },
          ],
        },
      },
      capture: {
        initial: "idle",
        invoke: { id: "preview", src: "preview" },
        on: {
          PREVIEW_CHECK: { actions: sendTo("preview", { type: "CHECK" }) },
          VISIBILITY: {
            actions: assign({ visible: ({ event }) => event.visible }),
          },
          CAPTURE_FAILURE: {
            target: ".idle",
            actions: assign({
              error: ({ event }) => event.reason,
              issue: ({ event }) => event.issue,
              session: null,
              prepared: null,
            }),
          },
        },
        states: {
          idle: {
            on: {
              OPEN_SONG: "#videoComposer.choosingSong",
              RECORD: {
                guard: "canCapture",
                target: "preparingGuide",
                actions: assign({
                  error: "",
                  progress: "Loading the song…",
                  issue: null,
                  takeAlignment: "none",
                  guideStarted: false,
                  guideStartDelayMs: 0,
                }),
              },
              FILE: {
                guard: "canCapture",
                target: "inspecting",
                actions: assign({
                  file: ({ event }) => event.file,
                  error: "",
                  issue: null,
                }),
              },
              RETAKE: { actions: assign({ error: "", issue: null }) },
            },
          },
          inspecting: {
            invoke: {
              src: "inspectFile",
              input: ({ context }) => context.file!,
              onDone: {
                target: "#videoComposer.review",
                actions: assign({
                  file: ({ event }) => event.output.file,
                  clipDurationMs: ({ event }) => event.output.durationMs,
                  takeSoundtrack: null,
                  takeAlignment: "none",
                  progress: "",
                }),
              },
              onError: {
                target: "idle",
                actions: assign({
                  file: null,
                  error: ({ event }) =>
                    message(event.error, "The video could not be opened"),
                  progress: "",
                }),
              },
            },
          },
          preparingGuide: {
            always: {
              guard: "captureBlocked",
              target: "idle",
              actions: [
                () => operations.discardPrepared(),
                assign({ prepared: null, progress: "" }),
              ],
            },
            invoke: {
              src: "prepareGuide",
              input: ({ context }) => context.selection!,
              onDone: {
                target: "startingCapture",
                actions: assign({
                  prepared: ({ event }) => event.output.audio,
                  progress: "",
                }),
              },
              onError: {
                target: "idle",
                actions: assign({
                  error: ({ event }) =>
                    message(
                      event.error,
                      "The song didn't finish loading, so recording didn't start. Check your connection and try again.",
                    ),
                  progress: "",
                }),
              },
            },
            on: {
              SELECTION: {
                target: "idle",
                actions: [
                  () => operations.discardPrepared(),
                  assign({
                    selection: ({ event }) => event.selection,
                    progress: "",
                  }),
                ],
              },
              VISIBILITY: {
                target: "idle",
                actions: [
                  () => operations.discardPrepared(),
                  assign({
                    visible: ({ event }) => event.visible,
                    progress: "",
                  }),
                ],
              },
            },
          },
          startingCapture: {
            always: {
              guard: "captureBlocked",
              target: "idle",
              actions: [
                () => operations.discardPrepared(),
                assign({ prepared: null, progress: "" }),
              ],
            },
            invoke: {
              src: "startCapture",
              input: ({ context }) => ({
                guide: context.selection!,
                audio: context.prepared!,
              }),
              onDone: {
                target: "startingGuide",
                actions: assign({
                  session: ({ event }) => event.output.session,
                  takeSoundtrack: ({ context }) => ({
                    songPostId: context.selection!.songPostId,
                    bounds: context.selection!.bounds,
                  }),
                }),
              },
              onError: {
                target: "idle",
                actions: assign({
                  error: ({ event }) =>
                    message(event.error, "The camera could not start"),
                  prepared: null,
                }),
              },
            },
            on: {
              SELECTION: {
                target: "idle",
                actions: assign({ selection: ({ event }) => event.selection }),
              },
              VISIBILITY: {
                target: "idle",
                actions: assign({ visible: ({ event }) => event.visible }),
              },
            },
          },
          startingGuide: {
            invoke: {
              src: "startGuide",
              input: ({ context }) => ({
                session: context.session!,
                prepared: {
                  guide: context.selection!,
                  audio: context.prepared!,
                },
              }),
              onDone: [
                {
                  guard: ({ event }) => event.output.started,
                  target: "recording",
                  actions: assign({
                    guideStarted: true,
                    guideStartDelayMs: ({ event }) => event.output.delayMs,
                    prepared: null,
                  }),
                },
                {
                  target: "interrupting",
                  actions: assign({
                    error:
                      "This song won’t play. Try again or choose another song.",
                    playbackFailed: true,
                  }),
                },
              ],
              onError: {
                target: "interrupting",
                actions: assign({
                  error: ({ event }) =>
                    message(
                      event.error,
                      "This song won’t play. Try again or choose another song.",
                    ),
                  playbackFailed: true,
                }),
              },
            },
            on: {
              STOP: "finalizing",
              INTERRUPT: "interrupting",
              CAPTURE_LIMIT: "finalizing",
              VISIBILITY: {
                target: "interrupting",
                actions: assign({ visible: ({ event }) => event.visible }),
              },
            },
          },
          recording: {
            always: {
              guard: ({ context }) => context.guideStartDelayMs > 750,
              target: "finalizing",
              actions: assign({
                error: "The song started too late. Record again.",
              }),
            },
            on: {
              STOP: "finalizing",
              CAPTURE_LIMIT: "finalizing",
              INTERRUPT: "interrupting",
              VISIBILITY: [
                {
                  guard: ({ event }) => !event.visible,
                  target: "interrupting",
                  actions: assign({ visible: false }),
                },
                { actions: assign({ visible: true }) },
              ],
            },
          },
          interrupting: {
            invoke: {
              src: "cancelCapture",
              input: ({ context }) => context,
              onDone: [
                {
                  guard: ({ context }) => context.playbackFailed,
                  target: "#videoComposer.choosingSong",
                  actions: assign({
                    session: null,
                    prepared: null,
                    takeSoundtrack: null,
                    takeAlignment: "none",
                    progress: "",
                  }),
                },
                {
                  target: "idle",
                  actions: assign({
                    session: null,
                    prepared: null,
                    takeSoundtrack: null,
                    takeAlignment: "none",
                    issue: "guide_interrupted",
                    progress: "",
                  }),
                },
              ],
              onError: {
                target: "idle",
                actions: assign({
                  session: null,
                  prepared: null,
                  issue: "guide_interrupted",
                }),
              },
            },
          },
          finalizing: {
            // One budget covers stop, alignment, inspection and measurement.
            // Leaving this state aborts the invoked media operation immediately.
            after: {
              [VIDEO_FINALIZATION_TIMEOUT_MS]: {
                target: "idle",
                actions: assign({
                  error: VIDEO_PREPARATION_TIMEOUT_NOTICE,
                  file: null,
                  clipDurationMs: null,
                  session: null,
                  prepared: null,
                  takeSoundtrack: null,
                  takeAlignment: "none",
                  progress: "",
                }),
              },
            },
            invoke: {
              src: "finishCapture",
              input: ({ context }) => context,
              onDone: {
                target: "#videoComposer.review",
                actions: assign({
                  file: ({ event }) => event.output.file,
                  clipDurationMs: ({ event }) => event.output.durationMs,
                  takeAlignment: ({ event }) => event.output.alignment,
                  session: null,
                  prepared: null,
                  issue: null,
                }),
              },
              onError: {
                target: "idle",
                actions: assign({
                  error: ({ event }) =>
                    message(
                      event.error,
                      "The recording couldn’t finish. Record again.",
                    ),
                  file: null,
                  clipDurationMs: null,
                  takeSoundtrack: null,
                  takeAlignment: "none",
                  session: null,
                  prepared: null,
                }),
              },
            },
          },
        },
      },
      review: {
        on: {
          PUBLISH: {
            guard: "canPublish",
            target: "submitting",
            actions: assign({
              submittedFromReview: true,
              error: "",
              progress: "",
            }),
          },
          OPEN_SONG: "choosingSong",
          BACK_FROM_REVIEW: {
            target: "capture",
            actions: assign({
              file: null,
              clipDurationMs: null,
              takeSoundtrack: null,
              takeAlignment: "none",
            }),
          },
        },
      },
      submitting: {
        invoke: {
          src: "publish",
          input: ({ context }) => context,
          onDone: [
            {
              guard: ({ event }) => event.output.posted,
              target: "retained",
              actions: () => operations.onPosted(),
            },
            { target: "retained" },
          ],
          onError: [
            {
              guard: ({ context }) => context.record === null,
              target: "review",
              actions: assign({
                error: ({ event }) =>
                  message(
                    event.error,
                    "The video attempt could not be completed safely",
                  ),
                progress: "",
              }),
            },
            {
              target: "retained",
              actions: assign({
                error: ({ event }) =>
                  message(
                    event.error,
                    "The video attempt could not be completed safely",
                  ),
                progress: "",
              }),
            },
          ],
        },
      },
      retained: {
        invoke: { src: "poll" },
        on: {
          PUBLISH: {
            target: "submitting",
            actions: assign({ error: "", progress: "" }),
          },
          TICK: { guard: "shouldRefresh", target: "refreshing" },
          START_OVER: "startingOver",
        },
      },
      refreshing: {
        invoke: {
          src: "refresh",
          input: ({ context }) => context,
          onDone: {
            target: "retained",
            actions: ({ event }) => {
              if (event.output) operations.onPosted();
            },
          },
          onError: { target: "retained" },
        },
      },
      startingOver: {
        invoke: {
          src: "startOver",
          input: ({ context }) => context,
          onDone: {
            target: "choosingSong",
            actions: [
              () => operations.onReset(),
              assign({
                record: null,
                file: null,
                clipDurationMs: null,
                submittedFromReview: false,
                rating: "general",
                takeSoundtrack: null,
                takeAlignment: "none",
                issue: null,
                enteredCapture: false,
                error: "",
              }),
            ],
          },
          onError: {
            target: "retained",
            actions: assign({
              error: ({ event }) =>
                message(event.error, "Couldn’t start over. Try again."),
            }),
          },
        },
      },
    },
  });
}
