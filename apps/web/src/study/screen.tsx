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
import type { StudyClient } from "./client.ts";
import { createStudyFeedbackAudio } from "./feedback-audio.ts";
import "./style.css";

export function StudyScreen(props: { client: StudyClient }) {
  const [lesson, setLesson] = createSignal<StudyLesson | null>(null),
    [miss, setMiss] = createSignal<StudyAttempt | null>(null);
  const [phase, setPhase] = createSignal<
      "loading" | "idle" | "recording" | "saving"
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
    lesson()?.current?.attempt?.state === "uncertain";
  const visibleLine = () => miss()?.line ?? lesson()?.current?.line;
  function cleanup() {
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  }
  onCleanup(() => {
    active = false;
    generation++;
    if (recorder?.state === "recording") recorder.stop();
    cleanup();
    sounds.dispose();
  });
  function install(value: StudyLesson) {
    setLesson(value);
    setMiss(null);
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
      if (!active || version !== generation) return;
      try {
        const restored = await props.client.load();
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
      } catch {
        setError("Your answer could not be saved. Try again.");
        setPhase("idle");
      }
    }
  }
  async function record() {
    const version = ++generation;
    sounds.unlock();
    setError("");
    setPhase("loading");
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error("Audio recording is unavailable in this browser.");
      const captured = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      if (!active || version !== generation) {
        captured.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = captured;
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
        cleanup();
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
        cleanup();
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
  return (
    <main class="study-page">
      <Show
        when={lesson()}
        fallback={
          <>
            <h1>Study</h1>
            <p role="status">Loading your lesson…</p>
          </>
        }
      >
        {(value) => (
          <>
            <Show when={value().status !== "completed" || miss()}>
              <header>
                <span class="study-eyebrow">STUDY</span>
                <p>
                  {value().progress.resolved} of {value().progress.total} lines
                  finished
                </p>
              </header>
              <h1>Say it back</h1>
              <p class="study-intro">
                Read the line, then say it in your own voice.
              </p>
              <Show when={visibleLine()}>
                {(line) => (
                  <blockquote lang={line().language} dir="auto">
                    {line().text}
                  </blockquote>
                )}
              </Show>
              <Show
                when={miss()}
                fallback={
                  <>
                    <Show
                      when={!blocked()}
                      fallback={
                        <p role="status">
                          We couldn't confirm the recording's outcome. Recording
                          is paused for this lesson. Choose Study again to start
                          a new lesson, or leave Study.
                        </p>
                      }
                    >
                      <button
                        disabled={phase() === "loading" || phase() === "saving"}
                        onClick={() =>
                          phase() === "recording"
                            ? recorder?.stop()
                            : void record()
                        }
                      >
                        {phase() === "recording"
                          ? "Stop"
                          : phase() === "saving"
                            ? "Checking…"
                            : "Record"}
                      </button>
                    </Show>
                    <Show when={blocked()}>
                      <button
                        class="study-secondary"
                        onClick={() => void load(true)}
                      >
                        Study again
                      </button>
                    </Show>
                  </>
                }
              >
                {(wrong) => (
                  <>
                    <section
                      class="study-result"
                      data-state="incorrect"
                      role="status"
                    >
                      <h2>Incorrect</h2>
                      <p>
                        You said:{" "}
                        <span dir="auto">
                          {wrong().grade?.heardTranscript || "No words"}
                        </span>
                      </p>
                    </section>
                    <button onClick={() => setMiss(null)}>Continue</button>
                  </>
                )}
              </Show>
            </Show>
            <Show when={value().status === "completed" && !miss()}>
              <h1>Lesson complete</h1>
              <p>
                {value().progress.firstPassCorrect} of {value().progress.total}{" "}
                lines matched on the first try.
              </p>
              <button
                onClick={() => void load(true)}
                disabled={phase() !== "idle"}
              >
                Study again
              </button>
            </Show>
          </>
        )}
      </Show>
      <Show when={error()}>
        <p class="study-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={!lesson() && phase() === "idle"}>
        <button onClick={() => void load()}>Try again</button>
      </Show>
      <Show when={phase() === "recording"}>
        <p role="status">Recording…</p>
      </Show>
      <Show when={phase() === "saving"}>
        <p role="status">Checking your answer…</p>
      </Show>
    </main>
  );
}
