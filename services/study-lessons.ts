import { Effect } from "effect";
import { StudyAttemptStore } from "../packages/study/attempt-store.ts";
import {
  StudyError,
  studyCheck,
  selectionOf,
  type StudyPrincipal,
  type StudyLine,
  type StudyAttempt,
} from "../packages/study/contracts.ts";
import {
  STUDY_LESSON_SCHEMA,
  STUDY_MAX_TAKES,
  closeStudyLesson,
  consumeLessonGrade,
  newLesson,
  studyPresentationCap,
  studySong,
  type StudyLesson,
  type StudySong,
  type StudyLessonSubmission,
} from "../packages/study/lesson.ts";
import {
  StudyLessonStore,
  type LessonRow,
} from "../packages/study/lesson-store.ts";
import type { makeStudyService } from "./study-spoken.ts";
import { selectStudyLessonLines } from "../packages/study/line-selection.ts";

export function makeStudyLessonService(options: {
  db: D1Database;
  attempts: ReturnType<typeof makeStudyService>;
  // Return all eligible published lines in song order. Selection is per owner.
  resolveLines: (song: StudySong) => Promise<StudyLine[]>;
  now?: () => number;
}) {
  const store = new StudyLessonStore(options.db),
    attempts = new StudyAttemptStore(options.db),
    now = options.now ?? Date.now;
  function ownerFor(owner: StudyPrincipal, song?: StudySong) {
    studyCheck(
      typeof owner.accountId === "string" &&
        owner.accountId.length > 0 &&
        owner.accountId.length <= 128 &&
        /^0x[0-9a-f]{64}$/.test(owner.communityId),
      "study_auth_required",
      401,
    );
    studyCheck(
      !song || song.communityId === owner.communityId,
      "study_wrong_community",
      403,
    );
  }
  async function reconcile(
    owner: StudyPrincipal,
    id: string,
  ): Promise<LessonRow> {
    for (let retry = 0; retry < 12; retry++) {
      const row = await store.row(owner, id),
        state = store.state(row);
      if (state.status !== "active") return row;
      let attempt = state.currentAttemptId
        ? await options.attempts.get(owner, state.currentAttemptId)
        : null;
      // Consume a grade durably saved before the deadline, even after restart.
      // A provider response after the deadline cannot save a new grade.
      if (attempt?.state === "assessed") {
        if (
          await store.update(
            owner,
            row,
            consumeLessonGrade(state, attempt, attempt.completedAt!),
          )
        )
          continue;
        continue;
      }
      if (now() >= state.expiresAt) {
        await store.close(
          owner,
          row,
          closeStudyLesson(
            state,
            "expired",
            state.expiresAt,
            await store.submittedLines(owner, id),
          ),
          attempt,
        );
        continue;
      }
      if (!attempt) return row;
      if (attempt.state === "ready" && attempt.startedAt + 300000 < now()) {
        await attempts.expireReady(owner, attempt.attemptId, now());
        attempt = await options.attempts.get(owner, attempt.attemptId);
      }
      if (attempt.state === "assessed") {
        if (
          await store.update(
            owner,
            row,
            consumeLessonGrade(state, attempt, attempt.completedAt ?? now()),
          )
        )
          continue;
      } else if (attempt.state === "unavailable") {
        const next = {
          ...state,
          currentAttemptId: null,
          lastAttemptId: attempt.attemptId,
          takeNumber: state.takeNumber + 1,
        };
        if (await store.update(owner, row, next)) continue;
      } else return row;
    }
    throw new StudyError("study_lesson_busy", 409);
  }
  async function view(
    owner: StudyPrincipal,
    row: LessonRow,
  ): Promise<StudyLesson> {
    const s = store.state(row);
    const current =
      s.currentIndex === null
        ? null
        : {
            line: s.items[s.currentIndex].line,
            presentationNumber: s.presentationCount + 1,
            takeNumber: s.takeNumber,
            attempt: s.currentAttemptId
              ? await options.attempts.get(owner, s.currentAttemptId)
              : null,
          };
    return {
      schema: STUDY_LESSON_SCHEMA,
      kind: "say-it-back",
      lessonId: row.lesson_id,
      song: s.song,
      startedAt: s.startedAt,
      expiresAt: s.expiresAt,
      completedAt: s.completedAt,
      status: s.status,
      completionReason: s.completionReason,
      current,
      lastAttempt: s.lastAttemptId
        ? await options.attempts.get(owner, s.lastAttemptId)
        : null,
      progress: {
        total: s.items.length,
        resolved: s.items.filter((i) => i.resolved).length,
        mastered: s.items.filter((i) => i.mastered).length,
        presentations: s.presentationCount,
        presentationCap: studyPresentationCap(s.items.length),
        firstPassGraded: s.items.filter((i) => i.firstPassOutcome !== null)
          .length,
        firstPassCorrect: s.items.filter(
          (i) => i.firstPassOutcome === "correct",
        ).length,
      },
      qualification: "not_evaluated",
    };
  }
  const service = {
    async start(owner: StudyPrincipal, requestId: string, input: unknown) {
      const song = studySong(input);
      ownerFor(owner, song);
      studyCheck(
        /^[a-zA-Z0-9_-]{16,128}$/.test(requestId),
        "invalid_study_request_id",
      );
      const previous = await store.byRequest(owner, requestId);
      if (previous) {
        studyCheck(
          previous.song_json === JSON.stringify(song),
          "study_request_conflict",
          409,
        );
        return service.get(owner, previous.lesson_id);
      }
      const row = await store.create(
        owner,
        requestId,
        newLesson(
          song,
          selectStudyLessonLines(
            song,
            await options.resolveLines(song),
            await store.practice(owner, song),
          ),
          now(),
        ),
      );
      return service.get(owner, row.lesson_id);
    },
    async get(owner: StudyPrincipal, id: string) {
      ownerFor(owner);
      for (let retry = 0; retry < 12; retry++) {
        const result = await view(owner, await reconcile(owner, id));
        // A provider completion can race the projection read. Reconcile that
        // terminal attempt before returning a card which has already spent it.
        if (
          result.current?.attempt?.state !== "assessed" &&
          result.current?.attempt?.state !== "unavailable"
        )
          return result;
      }
      throw new StudyError("study_lesson_busy", 409);
    },
    async latest(owner: StudyPrincipal, input: unknown) {
      const song = studySong(input);
      ownerFor(owner, song);
      const row = await store.latest(owner, song);
      return row ? service.get(owner, row.lesson_id) : null;
    },
    async abandon(owner: StudyPrincipal, id: string) {
      ownerFor(owner);
      for (let retry = 0; retry < 12; retry++) {
        const row = await reconcile(owner, id),
          s = store.state(row);
        if (s.status !== "active") return view(owner, row);
        const current = s.currentAttemptId
          ? await options.attempts.get(owner, s.currentAttemptId)
          : null;
        if (current?.state === "assessed") continue;
        const closedAt = now(),
          expired = closedAt >= s.expiresAt;
        if (
          await store.close(
            owner,
            row,
            closeStudyLesson(
              s,
              expired ? "expired" : "abandoned",
              expired ? s.expiresAt : closedAt,
              await store.submittedLines(owner, id),
            ),
            current,
          )
        )
          return service.get(owner, id);
      }
      throw new StudyError("study_lesson_busy", 409);
    },
    async expirePending(limit = 50) {
      studyCheck(
        Number.isInteger(limit) && limit > 0 && limit <= 100,
        "invalid_study_scan_limit",
      );
      const rows = await options.db
        .prepare(
          `SELECT lesson_id,account_id,community_id
        FROM study_lessons WHERE json_extract(state_json,'$.status')='active'
        AND json_extract(state_json,'$.expiresAt')<=? ORDER BY started_at,lesson_id LIMIT ?`,
        )
        .bind(now(), limit)
        .all<{ lesson_id: string; account_id: string; community_id: string }>();
      for (const row of rows.results)
        await service.get(
          { accountId: row.account_id, communityId: row.community_id },
          row.lesson_id,
        );
      return rows.results.length;
    },
    async openAttempt(
      owner: StudyPrincipal,
      id: string,
      presentationNumber: number,
      takeNumber: number,
    ) {
      ownerFor(owner);
      for (let retry = 0; retry < 12; retry++) {
        const row = await reconcile(owner, id),
          s = store.state(row);
        studyCheck(
          s.status === "active" &&
            s.currentIndex !== null &&
            presentationNumber === s.presentationCount + 1 &&
            takeNumber === s.takeNumber,
          "study_lesson_changed",
          409,
        );
        studyCheck(s.takeNumber <= STUDY_MAX_TAKES, "study_retry_limit", 409);
        if (s.currentAttemptId)
          return {
            attempt: await options.attempts.get(owner, s.currentAttemptId),
            lesson: await service.get(owner, id),
          };
        const ref = { lessonId: id, presentationNumber, takeNumber };
        const attempt = await options.attempts.open(
          owner,
          `lesson_${id}_${presentationNumber}_${takeNumber}`,
          selectionOf(s.items[s.currentIndex].line),
          ref,
        );
        studyCheck(
          JSON.stringify(attempt.line) ===
            JSON.stringify(s.items[s.currentIndex].line),
          "study_reference_mismatch",
          409,
        );
        if (
          await store.update(owner, row, {
            ...s,
            currentAttemptId: attempt.attemptId,
          })
        )
          return { attempt, lesson: await service.get(owner, id) };
      }
      throw new StudyError("study_lesson_busy", 409);
    },
    submit(
      owner: StudyPrincipal,
      id: string,
      attemptId: string,
      request: Request,
    ) {
      return Effect.tryPromise({
        try: async (): Promise<StudyLessonSubmission> => {
          ownerFor(owner);
          const row = await reconcile(owner, id),
            s = store.state(row),
            attempt = await options.attempts.get(owner, attemptId);
          studyCheck(
            attempt.lesson?.lessonId === id,
            "study_attempt_not_found",
            404,
          );
          if (attempt.state === "ready")
            studyCheck(
              s.status === "active" &&
                s.currentAttemptId === attemptId &&
                attempt.lesson.presentationNumber === s.presentationCount + 1 &&
                attempt.lesson.takeNumber === s.takeNumber,
              "study_lesson_changed",
              409,
            );
          const result = await Effect.runPromise(
            Effect.match(options.attempts.submit(owner, attemptId, request), {
              onSuccess: (value) => ({ ok: true as const, value }),
              onFailure: (error) => ({ ok: false as const, error }),
            }),
          );
          if (!result.ok) throw result.error;
          return {
            attempt: result.value,
            lesson: await service.get(owner, id),
          };
        },
        catch: (error) =>
          error instanceof StudyError
            ? error
            : new StudyError("study_unavailable", 503),
      });
    },
  };
  return service;
}
