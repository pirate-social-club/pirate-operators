import {
  STUDY_SCHEMA,
  selectionOf,
  type StudyAttempt,
  type StudyLine,
} from "../../../../packages/study/contracts.ts";

export interface StudyClient {
  history(line: StudyLine): Promise<StudyAttempt[]>;
  open(line: StudyLine, requestId: string): Promise<StudyAttempt>;
  submit(attemptId: string, audio: Blob): Promise<StudyAttempt>;
}
export function createStudyClient(csrf: () => string): StudyClient {
  async function call(path: string, init: RequestInit = {}) {
    const response = await fetch(`/api/study/attempts${path}`, {
      ...init,
      credentials: "same-origin",
      headers: { ...init.headers, "x-csrf-token": csrf() },
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Sign in again to save your answer."
          : "Your answer could not be saved. Try again.",
      );
    return response.json();
  }
  function attempt(value: StudyAttempt) {
    if (value.schema !== STUDY_SCHEMA || value.kind !== "say-it-back")
      throw new Error("This exercise is unavailable.");
    return value;
  }
  return {
    history: async (line) =>
      (
        (await call(
          `?selection=${encodeURIComponent(JSON.stringify(selectionOf(line)))}`,
        )) as StudyAttempt[]
      ).map(attempt),
    open: async (line, requestId) =>
      attempt(
        await call("", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId, selection: selectionOf(line) }),
        }),
      ),
    submit: async (id, audio) =>
      attempt(
        await call(`/${encodeURIComponent(id)}/audio`, {
          method: "PUT",
          headers: { "content-type": audio.type },
          body: audio,
        }),
      ),
  };
}
