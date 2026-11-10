// Independently adapted from pirate-web-solid 667a6f2 studying-feedback-audio.ts.
import correctUrl from "./sounds/correct.mp3?url";
import incorrectUrl from "./sounds/incorrect.mp3?url";
export type StudyFeedbackOutcome = "correct" | "incorrect";
export function createStudyFeedbackAudio() {
  let context: AudioContext | undefined;
  const buffers: Partial<Record<StudyFeedbackOutcome, AudioBuffer>> = {};
  const loading: Partial<Record<StudyFeedbackOutcome, Promise<AudioBuffer>>> =
    {};
  const urls = { correct: correctUrl, incorrect: incorrectUrl };
  function load(outcome: StudyFeedbackOutcome) {
    if (!context) return null;
    if (buffers[outcome]) return Promise.resolve(buffers[outcome]);
    const target = context;
    return (loading[outcome] ??= fetch(urls[outcome])
      .then((response) => {
        if (!response.ok) throw new Error("feedback_unavailable");
        return response.arrayBuffer();
      })
      .then((bytes) => target.decodeAudioData(bytes))
      .then((buffer) => {
        buffers[outcome] = buffer;
        return buffer;
      }));
  }
  function fallback(outcome: StudyFeedbackOutcome) {
    if (typeof Audio === "undefined") return;
    const audio = new Audio(urls[outcome]);
    audio.volume = 0.7;
    void audio.play().catch(() => {});
  }
  return {
    unlock() {
      try {
        const Constructor =
          window.AudioContext ??
          (
            window as typeof window & {
              webkitAudioContext?: typeof AudioContext;
            }
          ).webkitAudioContext;
        if (Constructor) context ??= new Constructor();
        if (context?.state === "suspended")
          void context.resume().catch(() => {});
        for (const outcome of ["correct", "incorrect"] as const)
          void load(outcome)?.catch(() => {});
      } catch {
        // Feedback must never prevent microphone capture or progression.
      }
    },
    play(outcome: StudyFeedbackOutcome) {
      const pending = load(outcome);
      if (!pending) {
        fallback(outcome);
        return;
      }
      void pending
        .then((buffer) => {
          if (!context || context.state === "closed") return;
          const source = context.createBufferSource(),
            gain = context.createGain();
          gain.gain.value = 0.7;
          source.buffer = buffer;
          source.connect(gain).connect(context.destination);
          source.start();
        })
        .catch(() => fallback(outcome));
    },
    dispose() {
      void context?.close().catch(() => {});
      context = undefined;
    },
  };
}
