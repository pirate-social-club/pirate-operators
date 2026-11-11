import type { StudyAttempt } from "../../../../packages/study/contracts.ts";
import {
  STUDY_LESSON_SCHEMA,
  type StudyLesson,
  type StudySong,
  type StudyLessonSubmission,
} from "../../../../packages/study/lesson.ts";

export interface StudyClient {
  load(): Promise<StudyLesson>;
  /** The open lesson as stored now, even if it just finished. */
  refresh(): Promise<StudyLesson>;
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
/** The session now belongs to another account; nothing shown may be kept. */
export class StudyAccountChangedError extends Error {
  readonly code = "study_account_changed";
  readonly status = 401;
  constructor() {
    super("You are signed in with a different account. Reload to continue.");
  }
}
/** Header authority loss is sufficient to mask. Body classification is a
 * presentation-only refinement, explicitly deferred until the host has masked.
 * A post-dispatch denial is not proof that a write never committed. */
export class StudyAuthorityLostError extends Error {
  readonly code = "auth_error";
  readonly status: 401 | 403;
  readonly evidence: Readonly<{
    stage: "response_headers";
    path: string;
    method: string;
    writeOutcome: "unknown" | "not_a_write";
  }>;
  readonly afterAuthMask: () => Promise<"study_account_changed" | undefined>;
  constructor(response: Response, path: string, method: string) {
    super("Sign in again to continue Study.");
    this.status = response.status as 401 | 403;
    this.evidence = Object.freeze({
      stage: "response_headers",
      path,
      method,
      writeOutcome: method === "GET" ? "not_a_write" : "unknown",
    });
    let reason: Promise<"study_account_changed" | undefined> | undefined;
    this.afterAuthMask = () =>
      (reason ??= response
        .json()
        .then((body: unknown) =>
          body &&
          typeof body === "object" &&
          (body as { error?: unknown }).error === "study_account_changed"
            ? ("study_account_changed" as const)
            : undefined,
        )
        .catch(() => undefined));
  }
}
class StudyLessonNotFoundError extends Error {}
/** Sign-in permission is still being recorded; starting again shortly works. */
class StudyAuthorizationPendingError extends Error {}
/** A short, bounded wait for a just-made sign-in to be recorded. */
const AUTHORIZATION_RETRIES = 5,
  AUTHORIZATION_RETRY_MS = 2000;
export function createStudyClient(
  song: StudySong,
  csrf: () => string,
  initialLessonId?: string,
  onOpened?: (id: string) => void,
  beforeStart?: () => Promise<void>,
  active?: () => boolean,
  account?: string,
): StudyClient {
  let lessonId = initialLessonId,
    startRequestId = crypto.randomUUID();
  // A transport failure cannot authorize rotation to another start identity.
  // Explicit retries reconcile/replay this request until its outcome is known.
  let unconfirmedStart = false;
  async function call(path: string, init: RequestInit = {}) {
    if (active?.() === false) throw new Error("Study was closed.");
    const response = await fetch("/api/study/lessons" + path, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...init.headers,
        "x-csrf-token": csrf(),
        ...(account ? { "x-study-account": account } : {}),
      },
    });
    if (response.status === 401 || response.status === 403)
      throw new StudyAuthorityLostError(
        response,
        "/api/study/lessons" + path,
        init.method ?? "GET",
      );
    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({ error: "study_unavailable" }));
      if (body.error === "study_account_changed")
        throw new StudyAccountChangedError();
      // A lesson whose private history expired is gone for this account too.
      if (
        body.error === "study_lesson_not_found" ||
        body.error === "study_history_expired"
      )
        throw new StudyLessonNotFoundError("This lesson is unavailable.");
      if (body.error === "study_authorization_pending")
        throw new StudyAuthorizationPendingError(
          "Your answer could not be saved. Try again.",
        );
      throw Object.assign(
        new Error(
          response.status === 401
            ? "Sign in again to continue Study."
            : body.error === "study_authorization_required"
              ? "Sign out, then sign in again to continue."
              : body.error === "study_speech_retry_later"
                ? "Speech is busy. Your answer was not counted. Wait a minute, then try again."
                : body.error === "study_recording_too_short"
                  ? "Record for at least one second, then try again."
                  : "Your answer could not be saved. Try again.",
        ),
        { status: response.status, code: body.error },
      );
    }
    return response.json();
  }
  function remember(lesson: StudyLesson) {
    if (active?.() === false) throw new Error("Study was closed.");
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
    await beforeStart?.();
    // The same request is retried while sign-in permission is recorded; the
    // screen keeps its loading state meanwhile.
    for (let retry = 0; ; retry++) {
      try {
        unconfirmedStart = true;
        const started = remember(
          await call("", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: startRequestId, song }),
          }),
        );
        unconfirmedStart = false;
        return started;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (
          status !== undefined &&
          status < 500 &&
          status !== 408 &&
          status !== 401 &&
          status !== 403
        )
          unconfirmedStart = false;
        if (
          !(error instanceof StudyAuthorizationPendingError) ||
          retry + 1 >= AUTHORIZATION_RETRIES
        )
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, AUTHORIZATION_RETRY_MS),
        );
      }
    }
  }
  return {
    async load() {
      // Opening Study resumes the lesson in progress and otherwise starts a
      // new one. Refreshing the page (its link names the lesson) still shows a
      // just-finished result; a lesson that closed unfinished never reappears.
      if (lessonId)
        try {
          const linked: StudyLesson = await call(
            "/" + encodeURIComponent(lessonId),
          );
          if (linked.status === "active" || linked.status === "completed")
            return remember(linked);
          lessonId = undefined;
        } catch (error) {
          // A link to a lesson this account does not own opens this account's
          // own Study for the song instead of another account's lesson.
          if (!(error instanceof StudyLessonNotFoundError)) throw error;
          lessonId = undefined;
        }
      const latest: StudyLesson | null = await call(
        "?song=" + encodeURIComponent(JSON.stringify(song)),
      );
      return latest?.status === "active" ? remember(latest) : start();
    },
    async refresh() {
      // After a lost response, read back the same lesson whatever its state,
      // so a final answer that completed it still shows its result.
      // With no lesson to read back, report it rather than starting one.
      if (!lessonId) throw new Error("This lesson is unavailable.");
      return remember(await call("/" + encodeURIComponent(lessonId)));
    },
    async restart() {
      if (unconfirmedStart) return start();
      if (lessonId)
        await call("/" + encodeURIComponent(lessonId) + "/abandon", {
          method: "POST",
        }).catch((error) => {
          // A lesson whose history is already gone has nothing to close.
          if (!(error instanceof StudyLessonNotFoundError)) throw error;
          lessonId = undefined;
        });
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
