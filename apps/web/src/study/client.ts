import type { StudyAttempt } from "../../../../packages/study/contracts.ts";
import {
  STUDY_LESSON_SCHEMA,
  type StudyLesson,
  type StudySong,
  type StudyLessonSubmission,
} from "../../../../packages/study/lesson.ts";

export interface StudyClient {
  load(): Promise<StudyLesson>;
  restart(): Promise<StudyLesson>;
  open(
    lesson: StudyLesson,
  ): Promise<{ attempt: StudyAttempt; lesson: StudyLesson }>;
  submit(
    lessonId: string,
    attemptId: string,
    audio: Blob,
    durationMs: number,
  ): Promise<StudyLessonSubmission>;
}
export function createStudyClient(
  song: StudySong,
  csrf: () => string,
  initialLessonId?: string,
  onOpened?: (id: string) => void,
): StudyClient {
  let lessonId = initialLessonId,
    startRequestId = crypto.randomUUID();
  async function call(path: string, init: RequestInit = {}) {
    const response = await fetch("/api/study/lessons" + path, {
      ...init,
      credentials: "same-origin",
      headers: { ...init.headers, "x-csrf-token": csrf() },
    });
    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({ error: "study_unavailable" }));
      throw new Error(
        response.status === 401
          ? "Sign in again to continue Study."
          : body.error === "study_recording_too_short"
            ? "Record for at least one second, then try again."
            : body.error === "study_daily_limit"
              ? "Study is busy. Try again later."
              : "Your answer could not be saved. Try again.",
      );
    }
    return response.json();
  }
  function remember(lesson: StudyLesson) {
    if (
      lesson.schema !== STUDY_LESSON_SCHEMA ||
      lesson.kind !== "say-it-back" ||
      Object.entries(song).some(
        ([key, value]) => lesson.song[key as keyof StudySong] !== value,
      )
    )
      throw new Error("This lesson is unavailable.");
    lessonId = lesson.lessonId;
    onOpened?.(lessonId);
    return lesson;
  }
  async function start() {
    return remember(
      await call("", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: startRequestId, song }),
      }),
    );
  }
  return {
    async load() {
      if (lessonId)
        return remember(await call("/" + encodeURIComponent(lessonId)));
      const latest: StudyLesson | null = await call(
        "?song=" + encodeURIComponent(JSON.stringify(song)),
      );
      return latest ? remember(latest) : start();
    },
    async restart() {
      startRequestId = crypto.randomUUID();
      return start();
    },
    async open(lesson) {
      if (!lesson.current) throw new Error("This lesson has finished.");
      return call("/" + encodeURIComponent(lesson.lessonId) + "/attempts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          presentationNumber: lesson.current.presentationNumber,
          takeNumber: lesson.current.takeNumber,
        }),
      });
    },
    async submit(id, attemptId, audio, durationMs) {
      return call(
        "/" +
          encodeURIComponent(id) +
          "/attempts/" +
          encodeURIComponent(attemptId) +
          "/audio",
        {
          method: "PUT",
          headers: {
            "content-type": audio.type,
            "x-study-duration-ms": String(durationMs),
          },
          body: audio,
        },
      );
    },
  };
}
