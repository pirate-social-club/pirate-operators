import { createSignal, onCleanup, Show } from "solid-js";
import {
  MAX_STUDY_AUDIO_BYTES,
  type StudyAttempt,
  type StudyLine,
} from "../../../../packages/study/contracts.ts";
import type { StudyClient } from "./client.ts";
import "./style.css";

export function StudyScreen(props: {
  lines: StudyLine[];
  client: StudyClient;
}) {
  const [index, setIndex] = createSignal(0);
  const [phase, setPhase] = createSignal<
    "loading" | "idle" | "recording" | "recorded" | "saving"
  >("loading");
  const [error, setError] = createSignal(""),
    [result, setResult] = createSignal<StudyAttempt | null>(null);
  let stream: MediaStream | undefined, recorder: MediaRecorder | undefined;
  let recording: Blob | undefined,
    requestId: string | undefined,
    attemptId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined,
    active = true,
    generation = 0;
  const line = () => props.lines[index()];
  const cleanup = () => {
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  };
  onCleanup(() => {
    active = false;
    generation++;
    if (recorder?.state === "recording") recorder.stop();
    cleanup();
  });
  async function restore(current = line()) {
    const version = ++generation;
    setPhase("loading");
    setResult(null);
    setError("");
    try {
      if (!current) return;
      const history = await props.client.history(current);
      if (!active || version !== generation) return;
      setResult(
        history.find(
          (row) =>
            row.line.lineId === current?.lineId &&
            row.line.manifestDigest === current.manifestDigest &&
            row.line.postId === current.postId &&
            row.line.communityId === current.communityId &&
            row.line.postsContract === current.postsContract &&
            row.line.chainId === current.chainId &&
            row.line.lyricRevision === current.lyricRevision,
        ) ?? null,
      );
    } catch (e) {
      if (active && version === generation)
        setError(
          e instanceof Error ? e.message : "Saved results are unavailable.",
        );
    } finally {
      if (active && version === generation) setPhase("idle");
    }
  }
  void restore();
  async function record() {
    const version = ++generation;
    setError("");
    setResult(null);
    setPhase("loading");
    recording = undefined;
    requestId = undefined;
    attemptId = undefined;
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
      const type = ["audio/webm", "audio/ogg", "audio/mp4"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      if (!type)
        throw new Error("This browser's recording format is unsupported.");
      const capture = new MediaRecorder(captured, { mimeType: type });
      recorder = capture;
      const chunks: Blob[] = [];
      let size = 0,
        failed = false;
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
        cleanup();
        if (!active || version !== generation) return;
        if (failed || size === 0) {
          setPhase("idle");
          if (!failed) setError("No audio was recorded. Try again.");
          return;
        }
        recording = new Blob(chunks, { type });
        requestId = crypto.randomUUID();
        setPhase("recorded");
      };
      capture.start(250);
      setResult(null);
      setPhase("recording");
      timer = setTimeout(() => {
        if (capture.state === "recording") capture.stop();
      }, 30000);
    } catch (e) {
      cleanup();
      if (active && version === generation) {
        setPhase("idle");
        setError(
          e instanceof Error ? e.message : "Microphone access was refused.",
        );
      }
    }
  }
  async function submit() {
    const current = line();
    if (!recording || !requestId || !current) return;
    setPhase("saving");
    setError("");
    try {
      // A lost response keeps the same request/attempt and recording for replay.
      if (!attemptId)
        attemptId = (await props.client.open(current, requestId)).attemptId;
      const saved = await props.client.submit(attemptId, recording);
      if (!active) return;
      setResult(saved);
      recording = undefined;
      setPhase("idle");
    } catch (e) {
      if (active) {
        setPhase("recorded");
        setError(
          e instanceof Error ? e.message : "Your answer could not be saved.",
        );
      }
    }
  }
  function next() {
    if (index() + 1 < props.lines.length) {
      const nextIndex = index() + 1;
      setIndex(nextIndex);
      recording = undefined;
      requestId = undefined;
      attemptId = undefined;
      void restore(props.lines[nextIndex]);
    }
  }
  return (
    <main class="study-page">
      <header>
        <span class="study-eyebrow">STUDY</span>
        <p>
          Line {index() + 1} of {props.lines.length}
        </p>
      </header>
      <h1>Say it back</h1>
      <p class="study-intro">Read the line, then say it in your own voice.</p>
      <Show
        when={line()}
        fallback={<p>No Study lines are available for this song.</p>}
      >
        {(current) => (
          <>
            <blockquote lang={current().language} dir="auto">
              {current().text}
            </blockquote>
            <div class="study-actions">
              <Show
                when={phase() === "recording"}
                fallback={
                  <button
                    disabled={phase() === "loading" || phase() === "saving"}
                    onClick={record}
                  >
                    {result() || phase() === "recorded"
                      ? "Record again"
                      : "Record answer"}
                  </button>
                }
              >
                <button class="study-stop" onClick={() => recorder?.stop()}>
                  Stop recording
                </button>
              </Show>
              <Show when={phase() === "recorded"}>
                <button class="study-secondary" onClick={submit}>
                  Check my answer
                </button>
              </Show>
            </div>
            <div role="status" aria-live="polite">
              <Show when={phase() === "recording"}>
                <p>Recording… up to 30 seconds.</p>
              </Show>
              <Show when={phase() === "saving"}>
                <p>Checking your answer…</p>
              </Show>
              <Show when={error()}>
                <p class="study-error" role="alert">
                  {error()}
                </p>
              </Show>
              <Show when={result()}>
                {(saved) => (
                  <section class="study-result" data-state={saved().state}>
                    <Show
                      when={saved().state === "assessed"}
                      fallback={
                        <p>
                          {saved().state === "ready"
                            ? "This answer has not been assessed. Record another answer to continue."
                            : saved().state === "assessing"
                              ? "Your assessment is pending. Refresh to check your saved result."
                              : "This answer could not be assessed. You can record another answer."}
                        </p>
                      }
                    >
                      <h2>
                        {saved().grade?.correct ? "Matched" : "Try again"}
                      </h2>
                      <p>
                        We heard:{" "}
                        <span dir="auto">
                          {saved().grade?.heardTranscript || "No words"}
                        </span>
                      </p>
                      <Show when={!saved().grade?.correct}>
                        <p>You can try another recording or move on.</p>
                      </Show>
                    </Show>
                  </section>
                )}
              </Show>
            </div>
            <Show
              when={
                result()?.state === "assessed" &&
                index() + 1 < props.lines.length
              }
            >
              <button class="study-secondary" onClick={next}>
                Next line
              </button>
            </Show>
            <Show
              when={
                result()?.state === "assessed" &&
                index() + 1 === props.lines.length
              }
            >
              <p class="study-complete">
                You've reached the last line. Your result is saved.
              </p>
            </Show>
          </>
        )}
      </Show>
    </main>
  );
}
