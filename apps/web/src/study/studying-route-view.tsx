// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/studying/studying-route-view.tsx.
import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, Show } from "solid-js";

import { Button, Type } from "./ui.ts";

import {
  applyServerLesson,
  completeSurface,
  exerciseSurface,
  isStudyAttemptDivergence,
  lockedSurface,
  makeAttemptIdempotencyKey,
  STUDY_ATTEMPT_DIVERGENCE_RECOVERY_LIMIT,
  type StudyingLessonState,
  type StudyingSurfaceState,
} from "./presentation/studying-model.ts";
import {
  attemptErrorStatus,
  errorMessage,
  isStudyingAuthError,
  lessonProgressOf,
  type StudyingAttemptRejection,
  type StudyingClient,
  type StudyingLessonPayload,
  type StudyingRecorder,
} from "./studying-route-model";
import { StudyingSurface } from "./presentation/studying-surface.tsx";
import {
  STUDY_MIN_RECORDING_DURATION_MS,
  STUDY_PROVIDER_REVIEW_MESSAGE,
  STUDY_SHORT_RECORDING_MESSAGE,
  studyingRecordingFailure,
} from "./studying-recording-policy.ts";
import {
  StudyAuthRequiredState,
  StudyRouteLoadFailureState,
  StudyRouteLoadingState,
} from "./presentation/studying-route-states.tsx";
import { createStudyFeedbackAudio } from "./feedback-audio.ts";

// Route-level view for the studying activity. All effectful work (payload
// load, attempt submission, mic capture, the multiple-choice auto-advance
// delay) is injected; the view only sequences the surface state machine.
// Mirrors the legacy `study-route.tsx` controller minus Telegram handoff.

export interface StudyingRouteViewProps {
  rewardSlot?: JSX.Element;
  feedback?: ReturnType<typeof createStudyFeedbackAudio>;
  loadingSlot?: JSX.Element;
  renderComplete?: (
    state: Extract<StudyingSurfaceState, { kind: "complete" }>,
    actions: { studyAgain(): void; restartError?: string },
  ) => JSX.Element;
  postId: string;
  client: StudyingClient;
  /** Mic seam. Absent recorder => the say-it-back card explains it cannot record. */
  recorder?: StudyingRecorder;
  /** Auto-advance scheduler after a correct multiple-choice answer (legacy: 700 ms). */
  scheduleAdvance?: (run: () => void) => void;
  onExit?: () => void;
  onKaraoke?: () => void;
  onStudyAgain?: () => void;
  onConnect?: () => void;
  /** Invalidate the host's private actions before showing an auth hold. */
  onAuthRequired?: () => void;
}

type SayItBackSurfaceState = Extract<
  StudyingSurfaceState,
  { kind: "say_it_back" }
>;
type MultipleChoiceSurfaceState = Extract<
  StudyingSurfaceState,
  { kind: "multiple_choice" }
>;

function defaultScheduleAdvance(run: () => void): void {
  if (typeof window === "undefined") return;
  window.setTimeout(run, 700);
}

function initialSurface(payload: StudyingLessonPayload): StudyingSurfaceState {
  const first = payload.exercises[0];
  if (first === undefined)
    return completeSurface({
      correctCount: payload.correct_count ?? 0,
      totalCount: payload.served_count ?? 0,
    });
  const surface = exerciseSurface(first);
  const blocked = payload.spoken_submission;
  return surface.kind === "say_it_back" &&
    blocked?.state === "provider_outcome_unknown" &&
    blocked.session_item_id === surface.exercise.id &&
    blocked.attempt_number === surface.attemptNumber
    ? {
        ...surface,
        phase: "blocked",
        submitError: STUDY_PROVIDER_REVIEW_MESSAGE,
      }
    : surface;
}

function LoadedStudyingLesson(
  props: StudyingRouteViewProps & {
    onAuthHold: (rejection: StudyingAttemptRejection) => void;
    onReload: () => void;
    restartError?: string;
    payload: StudyingLessonPayload;
  },
) {
  const sounds = props.feedback ?? createStudyFeedbackAudio();
  const [lesson, setLesson] = createSignal<StudyingLessonState>({
    correctCount: props.payload.correct_count ?? 0,
    exercises: props.payload.exercises,
    previousStreak: props.payload.previous_streak,
    resolvedCount: props.payload.resolved_count,
    servedCount: props.payload.served_count,
    surface: initialSurface(props.payload),
  });
  let active = true;
  let divergenceRecoveries = 0;
  const idempotencyKeys = new Map<string, string>();

  const attemptIdempotencyKey = (
    exerciseId: string,
    attemptNumber: number,
  ): string => {
    const logical = `${props.payload.session_id}:${exerciseId}:${attemptNumber}`;
    const existing = idempotencyKeys.get(logical);
    if (existing) return existing;
    const created = makeAttemptIdempotencyKey(
      props.payload.session_id ?? "",
      exerciseId,
      attemptNumber,
    );
    idempotencyKeys.set(logical, created);
    return created;
  };

  /**
   * A new recording is a new payload. The cached key belongs to the audio it
   * was minted with, so rotating it here keeps a replay of one submission on
   * one key while ensuring different audio never reuses a key bound to
   * another digest. The server reclaims the same logical attempt on retry.
   */
  const rotateAttemptIdempotencyKey = (
    exerciseId: string,
    attemptNumber: number,
  ): void => {
    idempotencyKeys.delete(
      `${props.payload.session_id}:${exerciseId}:${attemptNumber}`,
    );
  };

  const recoverFromDivergence = (): boolean => {
    if (divergenceRecoveries >= STUDY_ATTEMPT_DIVERGENCE_RECOVERY_LIMIT)
      return false;
    divergenceRecoveries += 1;
    props.onReload();
    return true;
  };

  /** Narrowed surface updaters: the guard runs once, the update sees a typed card. */
  const updateSayItBack = (
    exerciseId: string,
    update: (
      surface: SayItBackSurfaceState,
      current: StudyingLessonState,
    ) => StudyingLessonState,
  ) => {
    setLesson((current) =>
      current.surface.kind === "say_it_back" &&
      current.surface.exercise.id === exerciseId
        ? update(current.surface, current)
        : current,
    );
  };

  const updateMultipleChoice = (
    exerciseId: string,
    update: (
      surface: MultipleChoiceSurfaceState,
      current: StudyingLessonState,
    ) => StudyingLessonState,
  ) => {
    setLesson((current) =>
      current.surface.kind === "multiple_choice" &&
      current.surface.exercise.id === exerciseId
        ? update(current.surface, current)
        : current,
    );
  };

  const submitAttempt = (
    input: Parameters<StudyingClient["submitAttempt"]>[0],
  ) => {
    const exerciseId = input.exercise_id;
    void props.client
      .submitAttempt(input)
      .then((result) => {
        if (!active) return;
        if (result.next_lesson?.expired) {
          props.onReload();
          return;
        }
        // A landed attempt proves we are back in step with the server; spend the
        // recovery budget again only if we drift a second time.
        divergenceRecoveries = 0;
        if (result.outcome === "correct" || result.outcome === "incorrect") {
          sounds.play(result.outcome === "correct" ? "correct" : "incorrect");
        }
        if (result.outcome === "ungraded_rerecord") {
          if (input.type !== "say_it_back") {
            props.onReload();
            return;
          }
          updateSayItBack(exerciseId, (surface, current) => ({
            ...current,
            lastAttemptResult: result,
            surface: {
              ...surface,
              phase: "idle" as const,
              submitError:
                "That recording could not be graded. Record it again.",
            },
          }));
          return;
        }
        if (input.type === "translation_choice") {
          updateMultipleChoice(exerciseId, (surface, current) => {
            if (result.outcome === "correct") {
              // The green highlight stays on the selected option briefly, then
              // the lesson moves to the server's next card without a "correct"
              // banner.
              (props.scheduleAdvance ?? defaultScheduleAdvance)(() => {
                updateMultipleChoice(exerciseId, (latest, state) =>
                  latest.result === "correct"
                    ? applyServerLesson(state, result)
                    : state,
                );
              });
            }
            // A retryable miss keeps the server-selected current card — the same
            // item at its next attempt number; only its queue ordinal moved.
            const retryExercise = result.next_lesson?.exercises[0];
            const retryable =
              result.outcome === "incorrect" &&
              (result.attempts_remaining ?? 0) > 0 &&
              retryExercise?.id === exerciseId;
            return {
              ...current,
              lastAttemptResult: result,
              surface: {
                ...surface,
                exercise: {
                  ...surface.exercise,
                  correctOptionId:
                    result.correct_option_id ??
                    surface.exercise.correctOptionId,
                },
                attemptNumber: retryable
                  ? Number(
                      retryExercise?.presentation_count ??
                        surface.attemptNumber - 1,
                    ) + 1
                  : surface.attemptNumber,
                canRetry: retryable,
                result:
                  result.outcome === "correct"
                    ? ("correct" as const)
                    : ("wrong" as const),
                submitting: false,
              },
            };
          });
          return;
        }
        updateSayItBack(exerciseId, (surface, current) => {
          if (result.outcome === "correct") {
            return applyServerLesson(current, result);
          }
          // Every graded spoken presentation is spent server-side: the miss is
          // final for this appearance, the diff explains it, and an unresolved
          // card returns later in the lesson at the server's choosing.
          const resolved =
            result.next_lesson?.resolved_count ?? current.resolvedCount ?? 0;
          const total = current.servedCount ?? current.exercises.length;
          return {
            ...current,
            lastAttemptResult: result,
            surface: {
              ...surface,
              diff: result.diff,
              heardTranscript: result.heard_transcript,
              phase: "wrong" as const,
              revealReference: true,
              willReturn: resolved < total,
            },
          };
        });
      })
      .catch((rejection: StudyingAttemptRejection) => {
        if (!active) return;
        if (isStudyingAuthError(rejection)) {
          props.onAuthHold(rejection);
          return;
        }
        const recordingFailure =
          input.type === "say_it_back"
            ? studyingRecordingFailure(rejection)
            : undefined;
        if (recordingFailure !== undefined) {
          updateSayItBack(exerciseId, (surface, current) => ({
            ...current,
            surface: {
              ...surface,
              phase:
                recordingFailure === "provider_unknown" ? "blocked" : "idle",
              submitError:
                recordingFailure === "provider_unknown"
                  ? STUDY_PROVIDER_REVIEW_MESSAGE
                  : recordingFailure === "too_short"
                    ? STUDY_SHORT_RECORDING_MESSAGE
                    : errorMessage(
                        rejection,
                        "The speech service declined that recording. Record a new answer.",
                      ),
            },
          }));
          return;
        }
        if (
          isStudyAttemptDivergence(attemptErrorStatus(rejection)) &&
          recoverFromDivergence()
        ) {
          return;
        }
        if (input.type === "translation_choice") {
          updateMultipleChoice(exerciseId, (surface, current) => ({
            ...current,
            surface: {
              ...surface,
              selectedOptionId: undefined,
              submitError: errorMessage(
                rejection,
                "Could not record this answer. Try again.",
              ),
              submitting: false,
            },
          }));
          return;
        }
        updateSayItBack(exerciseId, (surface, current) => ({
          ...current,
          surface: {
            ...surface,
            phase: "idle" as const,
            submitError: errorMessage(
              rejection,
              "Could not check this attempt. Try again.",
            ),
          },
        }));
      });
  };

  const submitMultipleChoice = (
    surface: MultipleChoiceSurfaceState,
    selectedOptionId: string,
  ) => {
    updateMultipleChoice(surface.exercise.id, (latest, current) => ({
      ...current,
      surface: { ...latest, submitError: undefined, submitting: true },
    }));
    submitAttempt({
      attempt_number: surface.attemptNumber,
      exercise_id: surface.exercise.id,
      idempotency_key: attemptIdempotencyKey(
        surface.exercise.id,
        surface.attemptNumber,
      ),
      selected_option_id: selectedOptionId,
      session_id: props.payload.session_id,
      type: "translation_choice",
    });
  };

  const beginCapture = (card: SayItBackSurfaceState) => {
    sounds.unlock();
    rotateAttemptIdempotencyKey(card.exercise.id, card.attemptNumber);
    const recorder = props.recorder;
    if (!recorder) {
      updateSayItBack(card.exercise.id, (latest, current) => ({
        ...current,
        surface: {
          ...latest,
          phase: "idle" as const,
          submitError: "Voice recording is not available in this browser.",
        },
      }));
      return;
    }
    updateSayItBack(card.exercise.id, (latest, current) => ({
      ...current,
      surface: {
        ...latest,
        diff: undefined,
        heardTranscript: undefined,
        phase: "acquiring" as const,
        submitError: undefined,
        willReturn: undefined,
      },
    }));
    void recorder
      .start()
      .then(() => {
        if (!active) return;
        updateSayItBack(card.exercise.id, (latest, current) =>
          latest.phase === "acquiring"
            ? { ...current, surface: { ...latest, phase: "listening" } }
            : current,
        );
      })
      .catch((rejection: StudyingAttemptRejection) => {
        if (!active) return;
        updateSayItBack(card.exercise.id, (latest, current) => ({
          ...current,
          surface: {
            ...latest,
            phase: "idle" as const,
            submitError: errorMessage(
              rejection,
              "Voice recording is not available in this browser.",
            ),
          },
        }));
      });
  };

  const handlePrimaryAction = () => {
    const surface = lesson().surface;
    if (surface.kind === "multiple_choice") {
      if (surface.result) {
        if (surface.result === "wrong" && surface.canRetry) {
          updateMultipleChoice(surface.exercise.id, (latest, current) => ({
            ...current,
            surface: {
              ...latest,
              canRetry: false,
              result: undefined,
              selectedOptionId: undefined,
            },
          }));
          return;
        }
        setLesson((current) =>
          applyServerLesson(current, current.lastAttemptResult ?? {}),
        );
        return;
      }
      if (surface.selectedOptionId && !surface.submitting) {
        submitMultipleChoice(surface, surface.selectedOptionId);
      }
      return;
    }

    if (surface.kind !== "say_it_back") return;
    const card = surface;

    if (card.phase === "wrong" && card.revealReference) {
      // The spent miss is final for this appearance: continue to the
      // server's next card (or completion) from the stored server lesson.
      setLesson((current) =>
        applyServerLesson(current, current.lastAttemptResult ?? {}),
      );
      return;
    }

    if (
      card.phase === "idle" ||
      (card.phase === "wrong" && !card.revealReference)
    ) {
      // A retryable miss behaves exactly like idle: the footer already reads
      // "Record", so pressing it starts the recording rather than costing the
      // learner an extra tap to clear the banner first. Recording terms live
      // in the Privacy Policy accepted at sign-in, so capture starts at once.
      beginCapture(card);
      return;
    }

    if (card.phase === "listening" && props.recorder) {
      const recorder = props.recorder;
      updateSayItBack(card.exercise.id, (latest, current) => ({
        ...current,
        surface: { ...latest, phase: "checking" as const },
      }));
      void recorder
        .stop()
        .then(({ audio, contentType, durationMs }) => {
          if (!active) return;
          if (
            !Number.isSafeInteger(durationMs) ||
            durationMs < STUDY_MIN_RECORDING_DURATION_MS
          ) {
            updateSayItBack(card.exercise.id, (latest, current) => ({
              ...current,
              surface: {
                ...latest,
                phase: "idle",
                submitError: STUDY_SHORT_RECORDING_MESSAGE,
              },
            }));
            return;
          }
          submitAttempt({
            audio,
            audio_duration_ms: durationMs,
            attempt_number: card.attemptNumber,
            content_type: contentType,
            exercise_id: card.exercise.id,
            idempotency_key: attemptIdempotencyKey(
              card.exercise.id,
              card.attemptNumber,
            ),
            session_id: props.payload.session_id,
            type: "say_it_back",
          });
        })
        .catch((rejection: StudyingAttemptRejection) => {
          if (!active) return;
          updateSayItBack(card.exercise.id, (latest, current) => ({
            ...current,
            surface: {
              ...latest,
              phase: "idle" as const,
              submitError: errorMessage(
                rejection,
                "Could not check this attempt. Try again.",
              ),
            },
          }));
        });
    }
  };

  const handleOptionSelect = (optionId: string) => {
    const surface = lesson().surface;
    if (
      surface.kind !== "multiple_choice" ||
      surface.result ||
      surface.submitting
    )
      return;
    // Selecting an answer submits immediately, matching the legacy flow where
    // the tap unlocks feedback and records the attempt in one gesture.
    sounds.unlock();
    updateMultipleChoice(surface.exercise.id, (latest, current) => ({
      ...current,
      surface: {
        ...latest,
        selectedOptionId: optionId,
        submitError: undefined,
      },
    }));
    submitMultipleChoice({ ...surface, selectedOptionId: optionId }, optionId);
  };

  // Capture cannot outlive this surface: disposal stops any live recording
  // and invalidates permission still being granted.
  onCleanup(() => {
    active = false;
    void props.recorder?.cancel?.();
    if (!props.feedback) sounds.dispose();
  });

  const completed = () => {
    const surface = lesson().surface;
    return props.renderComplete && surface.kind === "complete"
      ? surface
      : undefined;
  };

  return (
    <>
      <Show
        when={completed()}
        fallback={
          <StudyingSurface
            lessonProgress={lessonProgressOf(lesson())}
            onExit={props.onExit}
            onKaraoke={props.onKaraoke}
            onOptionSelect={handleOptionSelect}
            onPrimaryAction={handlePrimaryAction}
            onStudyAgain={props.onStudyAgain}
            rewardLabel={props.payload.reward_label}
            rewardSlot={
              <>
                <Show when={props.restartError}>
                  <Type
                    as="p"
                    class="text-destructive-text"
                    role="alert"
                    variant="caption"
                  >
                    {props.restartError}
                  </Type>
                </Show>
                {props.rewardSlot}
              </>
            }
            state={lesson().surface}
          />
        }
      >
        {(result) =>
          props.renderComplete!(result(), {
            studyAgain: () => props.onStudyAgain?.(),
            get restartError() {
              return props.restartError;
            },
          })
        }
      </Show>
    </>
  );
}

export function StudyingRouteView(props: StudyingRouteViewProps) {
  let active = true;
  let generation = 0;
  onCleanup(() => {
    active = false;
    generation += 1;
  });
  const [payload, setPayload] = createSignal<StudyingLessonPayload>();
  const [loadError, setLoadError] =
    createSignal<StudyingAttemptRejection | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [authRequired, setAuthRequired] = createSignal(false);
  const [authDescription, setAuthDescription] = createSignal(
    "Study packs follow the song's community. Sign in to pick up your lesson and streak.",
  );
  const holdForAuth = (rejection: StudyingAttemptRejection) => {
    // Carry only an allowlisted nonprivate reason across the authority mask.
    // Never preserve a response message, lesson body or disposed page action.
    setAuthDescription(
      rejection.code === "study_account_changed"
        ? "You are signed in with a different account. Reload to continue."
        : "Study packs follow the song's community. Sign in to pick up your lesson and streak.",
    );
    setAuthRequired(true);
    setPayload(undefined);
    setLoadError(null);
    void props.recorder?.cancel?.();
    props.onAuthRequired?.();
  };
  let requestPending = false;
  const load = (restart = false) => {
    if (requestPending) return;
    requestPending = true;
    if (restart) props.onStudyAgain?.();
    const revision = ++generation;
    setLoading(true);
    setLoadError(null);
    // Keep the original completed/expired surface while an explicit restart
    // is pending. Only an accepted replacement may replace its identity.
    if (!restart) setPayload(undefined);
    void (
      restart && props.client.restartLesson
        ? props.client.restartLesson()
        : props.client.loadLesson(props.postId)
    )
      .then((next) => {
        if (active && revision === generation) setPayload(next);
      })
      .catch((rejection: StudyingAttemptRejection) => {
        if (!active || revision !== generation) return;
        if (isStudyingAuthError(rejection)) {
          holdForAuth(rejection);
          return;
        }
        setLoadError(rejection);
      })
      .finally(() => {
        if (active && revision === generation) {
          requestPending = false;
          setLoading(false);
        }
      });
  };
  if (typeof window !== "undefined")
    queueMicrotask(() => {
      if (active) load();
    });

  return (
    <Show
      when={!authRequired()}
      fallback={
        <StudyAuthRequiredState
          ctaLabel="Sign in"
          description={authDescription()}
          onConnect={props.onConnect}
          onExit={props.onExit}
          title="Sign in to study"
        />
      }
    >
      <Show
        when={payload()}
        keyed
        fallback={
          <Show
            when={!loading()}
            fallback={
              props.loadingSlot ?? (
                <StudyRouteLoadingState label="Loading study" />
              )
            }
          >
            <StudyRouteLoadFailureState
              description={errorMessage(
                loadError(),
                "We couldn't load this study session.",
              )}
              onGoHome={props.onExit}
              onRetry={() => load()}
              title="Study unavailable"
            />
          </Show>
        }
      >
        {(loaded) => (
          <Show
            when={!loaded.locked}
            fallback={
              <StudyingSurface
                onExit={props.onExit}
                onPrimaryAction={props.onExit}
                rewardLabel={loaded.reward_label}
                state={lockedSurface(loaded.price_label)}
              />
            }
          >
            <Show
              when={!loaded.expired}
              fallback={
                <section
                  class="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-5 py-8"
                  aria-label="Expired Study session"
                >
                  <Type as="h1" variant="h1">
                    Study session expired
                  </Type>
                  <Type as="p" variant="body">
                    Your progress is saved. Start a new lesson when you're
                    ready.
                  </Type>
                  <Type as="p" variant="body">
                    {loaded.resolved_count ?? 0} of {loaded.served_count ?? 0}{" "}
                    cards resolved.
                  </Type>
                  <div class="mt-auto flex gap-3">
                    <Button
                      class="flex-1"
                      onClick={props.onExit}
                      variant="secondary"
                    >
                      Exit
                    </Button>
                    <Button class="flex-1" onClick={() => load(true)}>
                      Start new lesson
                    </Button>
                  </div>
                </section>
              }
            >
              <LoadedStudyingLesson
                {...props}
                onAuthHold={holdForAuth}
                restartError={
                  loadError() && !loading()
                    ? "A new lesson could not start. Try again."
                    : undefined
                }
                onStudyAgain={() => load(true)}
                onReload={() => load()}
                payload={loaded}
              />
            </Show>
          </Show>
        )}
      </Show>
    </Show>
  );
}
