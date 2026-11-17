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
export type StudyPublicationChoice = Readonly<{ kind: "private" }>;
export interface StudyStartOwner {
  communityId: string;
  account: string;
  csrf: string;
  postId: string;
}
interface PendingStudyStart {
  readonly requestId: string;
  readonly song: Readonly<StudySong>;
  readonly requestJson: string;
  readonly publication: "private" | "legacy";
  attempted: boolean;
  inFlight?: Promise<StudyLesson>;
  accepted?: StudyLesson;
}
/** Parent-owned memory only, scoped to the existing community/account/session/
 * post. This transfers an original pending request, never authentication or a
 * grant, across presentation-mode remounts. No new journal or transport exists. */
export interface StudyStartHandoff {
  readonly owner: Readonly<StudyStartOwner>;
  pending: PendingStudyStart | null;
}
export function createStudyStartHandoff(owner: StudyStartOwner): StudyStartHandoff {
  return { owner: Object.freeze({ ...owner }), pending: null };
}
export function createStudyClient(
  song: StudySong,
  csrf: () => string,
  initialLessonId?: string,
  onOpened?: (id: string) => void,
  beforeStart?: () => Promise<void>,
  active?: () => boolean,
  account?: string,
  publication?: StudyPublicationChoice,
  pendingStart?: StudyStartHandoff,
): StudyClient {
  if (publication !== undefined &&
    (publication === null || publication.kind !== "private" || Object.keys(publication).join() !== "kind"))
    throw new Error("This Study publication mode is unavailable.");
  // One client owns one original start mode. A retained caller object or later
  // profile/grant cannot mutate an unknown start into a different request.
  const selectedPublication = publication === undefined ? undefined : Object.freeze({ kind: "private" as const });
  const selectedSong = Object.freeze({ ...song });
  const selectedMode = selectedPublication ? "private" : "legacy";
  const handoff = pendingStart ?? createStudyStartHandoff({ communityId: selectedSong.communityId,
    account: account ?? "", csrf: csrf(), postId: selectedSong.postId });
  let lessonId = initialLessonId, startRequestId: string | undefined;
  function assertOwner() {
    if (handoff.owner.communityId !== selectedSong.communityId || handoff.owner.postId !== selectedSong.postId ||
      handoff.owner.account !== (account ?? "") || handoff.owner.csrf !== csrf())
      throw new StudyAccountChangedError();
  }
  assertOwner();
  async function call(path: string, init: RequestInit = {}) {
    if (active?.() === false) throw new Error("Study was closed.");
    assertOwner();
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
  function validate(lesson: StudyLesson) {
    if (
      lesson.schema !== STUDY_LESSON_SCHEMA ||
      lesson.kind !== "say-it-back" ||
      Object.entries(selectedSong).some(
        ([key, value]) => lesson.song[key as keyof StudySong] !== value,
      )
    )
      throw new Error("This lesson is unavailable.");
    return lesson;
  }
  function remember(lesson: StudyLesson) {
    if (active?.() === false) throw new Error("Study was closed.");
    assertOwner(); validate(lesson);
    lessonId = lesson.lessonId;
    onOpened?.(lessonId);
    return lesson;
  }
  const refused = (error: unknown) => {
    const status = (error as { status?: number }).status;
    return status !== undefined && status < 500 && status !== 408 && status !== 401 && status !== 403;
  };
  async function start() {
    assertOwner();
    let original = handoff.pending;
    if (original && Object.entries(original.song).some(([key, value]) => selectedSong[key as keyof StudySong] !== value))
      throw new Error("Your earlier Study start still needs its original song. Return to that lesson to continue.");
    if (!original) {
      startRequestId ??= crypto.randomUUID();
      original = { requestId: startRequestId, song: selectedSong,
        requestJson: JSON.stringify({ requestId: startRequestId, song: selectedSong,
          ...(selectedPublication ? { publication: selectedPublication } : {}),
        }), publication: selectedMode, attempted: false };
      handoff.pending = original;
    }
    const pending = original;
    // A replacement owner can await the SAME in-flight dispatch/accepted reply.
    // It cannot reinterpret an uncertain old-mode request as a new enrollment,
    // ID or body. Restore the original mode for any necessary exact retry.
    if (!pending.inFlight && !pending.accepted && pending.publication !== selectedMode)
      throw new Error("Your earlier Study start is still being checked. Try again when its original Study service is available.");
    if (!pending.inFlight && !pending.accepted) {
      // Install the shared promise before invoking any callback, including a
      // synchronous enrollment adapter that could replace the page owner.
      pending.inFlight = Promise.resolve().then(async () => {
        try {
          if (active?.() === false) throw new Error("Study was closed.");
          assertOwner();
          if (!pending.attempted) await beforeStart?.();
          // The existing bounded authorization wait keeps the same envelope.
          for (let retry = 0; ; retry++) {
            try {
              if (active?.() === false) throw new Error("Study was closed.");
              assertOwner();
              pending.attempted = true;
              const accepted = validate(await call("", { method: "POST",
                headers: { "content-type": "application/json" }, body: pending.requestJson,
              }));
              // Record only the exact original server acknowledgement. This
              // does not publish through the disposed original page's callbacks.
              pending.accepted = accepted;
              return accepted;
            } catch (error) {
              if (!(error instanceof StudyAuthorizationPendingError) || retry + 1 >= AUTHORIZATION_RETRIES) throw error;
              await new Promise(resolve => setTimeout(resolve, AUTHORIZATION_RETRY_MS));
            }
          }
        } catch (error) {
          // No dispatch, or a known refusal, may release this start. Transport,
          // timeout and authority-denial outcomes retain the exact original.
          if ((!pending.attempted || refused(error)) && handoff.pending === pending) handoff.pending = null;
          throw error;
        }
      });
    }
    const work = pending.inFlight;
    try {
      const accepted = pending.accepted ?? await work!;
      const remembered = remember(accepted);
      if (handoff.pending === pending) handoff.pending = null;
      return remembered;
    } finally {
      if (pending.inFlight === work) pending.inFlight = undefined;
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
      // Pending starts take precedence over an eventually-consistent latest
      // projection. A null latest cannot authorize a replacement start.
      if (handoff.pending) return start();
      const latest: StudyLesson | null = await call(
        "?song=" + encodeURIComponent(JSON.stringify(selectedSong)),
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
      if (handoff.pending) return start();
      if (lessonId)
        await call("/" + encodeURIComponent(lessonId) + "/abandon", {
          method: "POST",
        }).catch((error) => {
          // A lesson whose history is already gone has nothing to close.
          if (!(error instanceof StudyLessonNotFoundError)) throw error;
          lessonId = undefined;
        });
      startRequestId = undefined;
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
