import { createSignal, onCleanup, Show } from "solid-js";
import {
  MAX_STUDY_AUDIO_BYTES,
  MAX_STUDY_RECORDING_MS,
  MIN_STUDY_RECORDING_MS,
  STUDY_SHORT_RECORDING_MESSAGE,
  type StudyAttempt,
} from "../../../../packages/study/contracts.ts";
import type {
  StudyLesson,
  StudyLessonSubmission,
} from "../../../../packages/study/lesson.ts";
import { STUDY_MAX_TAKES } from "../../../../packages/study/lesson.ts";
import { StudyAccountChangedError, type StudyClient } from "./client.ts";
import { createStudyFeedbackAudio } from "./feedback-audio.ts";
import { StudyingSurface } from "./presentation/studying-surface.tsx";
import type { StudyingSurfaceState } from "./presentation/studying-model.ts";
import {
  StudyRouteLoadingState,
  StudyRouteLoadFailureState,
} from "./presentation/studying-route-states.tsx";
import { ActivityProgressHeader } from "../karaoke/activity-progress-header.tsx";

export function StudyScreen(props: {
  client: StudyClient;
  onLesson?: (lesson: StudyLesson) => void;
  onExit?: () => void;
}) {
  const [lesson, setLesson] = createSignal<StudyLesson | null>(null),
    [miss, setMiss] = createSignal<StudyAttempt | null>(null);
  const [phase, setPhase] = createSignal<
      "loading" | "idle" | "acquiring" | "recording" | "saving"
    >("loading"),
    [error, setError] = createSignal("");
  const sounds = createStudyFeedbackAudio();
  let stream: MediaStream | undefined,
    recorder: MediaRecorder | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let active = true,
    generation = 0;
  const blocked = () =>
    lesson()?.current?.attempt?.state === "assessing" ||
    lesson()?.current?.attempt?.state === "uncertain" ||
    (lesson()?.current?.takeNumber ?? 0) > STUDY_MAX_TAKES;
  const visibleLine = () => miss()?.line ?? lesson()?.current?.line;
  /** Ends one take. The microphone stays open for the next one. */
  function endTake() {
    clearTimeout(timer);
  }
  /** Releases the microphone: on exit, account change or a capture failure. */
  function cleanup() {
    endTake();
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  }
  const liveStream = () =>
    stream?.getAudioTracks().some((track) => track.readyState === "live")
      ? stream
      : undefined;
  onCleanup(() => {
    active = false;
    generation++;
    if (recorder?.state === "recording") recorder.stop();
    cleanup();
    sounds.dispose();
  });
  function install(value: StudyLesson) {
    setLesson(value);
    props.onLesson?.(value);
    setMiss(null);
  }
  /** Never keep showing a lesson that belongs to the previous account. */
  function forgetAccount(e: unknown) {
    if (!(e instanceof StudyAccountChangedError)) return false;
    generation++;
    cleanup();
    setLesson(null);
    setMiss(null);
    setError(e.message);
    setPhase("idle");
    return true;
  }
  async function load(restart = false) {
    const version = ++generation;
    setPhase("loading");
    setError("");
    setMiss(null);
    try {
      const value = await (restart
        ? props.client.restart()
        : props.client.load());
      if (active && version === generation) install(value);
    } catch (e) {
      if (forgetAccount(e)) return;
      if (restart && active && version === generation) {
        // Abandon may have succeeded before enrollment or the next start failed.
        let changed = false;
        const saved = await props.client.load().catch((error) => {
          changed = forgetAccount(error);
          return null;
        });
        if (changed) return;
        if (saved && active && version === generation) install(saved);
      }
      if (active && version === generation)
        setError(
          e instanceof Error
            ? e.message
            : "Study is unavailable. Try again later.",
        );
    } finally {
      if (active && version === generation) setPhase("idle");
    }
  }
  void load();
  function apply(result: StudyLessonSubmission) {
    if (!active) return;
    setLesson(result.lesson);
    props.onLesson?.(result.lesson);
    if (result.attempt.state === "assessed" && result.attempt.grade) {
      sounds.play(result.attempt.grade.correct ? "correct" : "incorrect");
      // The queue has already advanced server-side. Hold only the just-spent
      // miss until Continue; reload resumes the authoritative next card.
      setMiss(
        !result.attempt.grade.correct &&
          result.lesson.lastAttempt?.attemptId === result.attempt.attemptId
          ? result.attempt
          : null,
      );
      setError("");
    } else if (result.attempt.state === "unavailable")
      setError("Speech is unavailable. Try again later.");
    else if (
      result.attempt.state === "uncertain" ||
      result.attempt.state === "assessing"
    )
      setError("");
    setPhase("idle");
  }
  async function submit(audio: Blob, durationMs: number, version: number) {
    const current = lesson();
    if (!current || !current.current) return;
    setPhase("saving");
    setError("");
    let attemptId: string | undefined;
    try {
      attemptId = (await props.client.open(current)).attempt.attemptId;
      const response = await props.client.submit(
        current.lessonId,
        attemptId,
        audio,
        durationMs,
      );
      if (active && version === generation) apply(response);
    } catch (e) {
      if (!active || version !== generation || forgetAccount(e)) return;
      try {
        const restored = await props.client.refresh();
        if (!active || version !== generation) return;
        if (attemptId && restored.lastAttempt?.attemptId === attemptId)
          apply({ attempt: restored.lastAttempt, lesson: restored });
        else {
          install(restored);
          setError(
            blocked()
              ? ""
              : e instanceof Error
                ? e.message
                : "Your answer could not be saved. Try again.",
          );
          setPhase("idle");
        }
      } catch (restoreError) {
        if (forgetAccount(restoreError)) return;
        setError("Your answer could not be saved. Try again.");
        setPhase("idle");
      }
    }
  }
  async function record() {
    const version = ++generation;
    sounds.unlock();
    setError("");
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error("Audio recording is unavailable in this browser.");
      // Only the first take of a visit waits for the microphone; later takes
      // reuse the open stream, so the button goes straight to Stop.
      let captured = liveStream();
      if (!captured) {
        setPhase("acquiring");
        captured = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        if (!active || version !== generation) {
          captured.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = captured;
      }
      const type = ["audio/webm", "audio/mp4", "audio/ogg"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      if (!type)
        throw new Error("This browser's recording format is unsupported.");
      const capture = new MediaRecorder(captured, { mimeType: type });
      recorder = capture;
      const chunks: Blob[] = [];
      let size = 0,
        failed = false;
      const startedAt = performance.now();
      capture.ondataavailable = (event) => {
        size += event.data.size;
        if (size > MAX_STUDY_AUDIO_BYTES) {
          failed = true;
          if (capture.state === "recording") capture.stop();
          if (active)
            setError("That recording is too large. Try a shorter answer.");
        } else chunks.push(event.data);
      };
      capture.onerror = () => {
        failed = true;
        cleanup();
        if (active) {
          setPhase("idle");
          setError("Recording failed. Check microphone access and try again.");
        }
      };
      capture.onstop = () => {
        const durationMs = Math.round(performance.now() - startedAt);
        endTake();
        if (!active || version !== generation) return;
        if (failed) {
          setPhase("idle");
          return;
        }
        if (durationMs < MIN_STUDY_RECORDING_MS) {
          setError(STUDY_SHORT_RECORDING_MESSAGE);
          setPhase("idle");
          return;
        }
        if (durationMs > MAX_STUDY_RECORDING_MS || size === 0) {
          setError("The recording is empty or too long. Try again.");
          setPhase("idle");
          return;
        }
        void submit(new Blob(chunks, { type }), durationMs, version);
      };
      capture.start(250);
      setPhase("recording");
      timer = setTimeout(() => {
        failed = true;
        endTake();
        if (capture.state === "recording") capture.stop();
        if (active) {
          setPhase("idle");
          setError("The recording is too long. Try a shorter answer.");
        }
      }, MAX_STUDY_RECORDING_MS);
    } catch (e) {
      if (active && version === generation) {
        cleanup();
        setError(
          e instanceof Error ? e.message : "Microphone access was refused.",
        );
        setPhase("idle");
      }
    }
  }
  function surfaceState(): StudyingSurfaceState {
    const value = lesson()!;
    if (value.status === "completed" && !miss()) {
      return {
        kind: "complete",
        correctCount: value.progress.firstPassCorrect,
        totalCount: value.progress.total,
        scorePercent: value.progress.total
          ? (100 * value.progress.firstPassCorrect) / value.progress.total
          : 0,
      };
    }
    const line = visibleLine()!;
    return {
      kind: "say_it_back",
      exercise: {
        id: line.lineId,
        // This surface never renders a line ordinal. Durable identity is lineId;
        // the lesson response does not claim a source ordinal.
        lineNumber: 0,
        maxAttempts: 3,
        prompt: line.text,
        expected: line.text,
      },
      attemptNumber:
        miss()?.lesson?.presentationNumber ??
        value.current?.presentationNumber ??
        1,
      phase: miss()
        ? "wrong"
        : blocked()
          ? "blocked"
          : phase() === "acquiring"
            ? "acquiring"
            : phase() === "recording"
              ? "listening"
              : phase() === "saving"
                ? "checking"
                : "idle",
      revealReference: Boolean(miss()),
      heardTranscript: miss()?.grade?.heardTranscript,
      submitError: error() || undefined,
      guidance: blocked()
        ? "Recording is paused for this lesson. Choose Study again to start a new lesson, or leave Study."
        : undefined,
    };
  }
  function primaryAction() {
    if (miss()) setMiss(null);
    else if (phase() === "recording") recorder?.stop();
    else if (phase() === "idle" && !blocked()) void record();
  }
  function terminalError() {
    return (
      <p class="text-sm text-destructive-text" role="alert">
        {error()}
      </p>
    );
  }
  const ended = () =>
    lesson()?.status === "expired" || lesson()?.status === "abandoned";
  return (
    <Show
      when={lesson() && phase() !== "loading"}
      fallback={
        <Show
          when={error() && !lesson()}
          fallback={<StudyLoading onExit={props.onExit} />}
        >
          <StudyRouteLoadFailureState
            title="Study is unavailable"
            description={error()}
            onRetry={() => void load()}
            onGoHome={props.onExit}
          />
        </Show>
      }
    >
      <Show
        when={!ended() || miss()}
        fallback={
          <div class="flex min-h-dvh flex-col overflow-y-auto bg-background text-foreground [&>section]:h-auto [&>section]:min-h-0 [&>section]:flex-1">
            {/* One state, one message: a failed restart replaces the text
                rather than stacking a second error under it. */}
            <StudyRouteLoadFailureState
              title="Lesson ended"
              description={
                error() ||
                "Your saved answers are kept. Unfinished lines do not count as wrong answers."
              }
              onRetry={() => void load(true)}
              onGoHome={props.onExit}
            />
          </div>
        }
      >
        <StudyingSurface
          class="study-surface"
          state={surfaceState()}
          lessonProgress={{
            resolvedCount: lesson()!.progress.resolved,
            totalCount: lesson()!.progress.total,
          }}
          onExit={props.onExit}
          onPrimaryAction={primaryAction}
          onStudyAgain={() => void load(true)}
          rewardSlot={error() ? terminalError() : undefined}
        />
      </Show>
    </Show>
  );
}

// Preserve an exit while enrollment/load is pending. The spinner and header are
// the same owned centralized components used by the loaded Study surface.
export function StudyLoading(props: { onExit?: () => void }) {
  return (
    <div class="relative h-dvh w-full">
      <Show when={props.onExit}>
        <div class="absolute inset-x-0 top-0 z-10 mx-auto w-full max-w-[640px]">
          <ActivityProgressHeader
            progressMax={0}
            progressValue={0}
            progressTone="success"
            exitIcon="close"
            exitLabel="Exit study"
            onExit={props.onExit}
          />
        </div>
      </Show>
      <StudyRouteLoadingState label="Loading Study" />
    </div>
  );
}
