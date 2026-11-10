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
  STUDY_LESSON_NO_DEADLINE,
  STUDY_LESSON_SCHEMA,
  STUDY_MAX_TAKES,
  STUDY_OPEN_LESSON_MAX_MS,
  closeStudyLesson,
  consumeLessonGrade,
  newLesson,
  studyCloseBound,
  studyLessonHasDeadline,
  type StudyCloseBound,
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

/**
 * SQL for an open lesson's close bound, matching `studyCloseBound`. It needs
 * `l` for study_lessons and `p` for a LEFT JOIN of study_publications, and
 * takes `studyCloseBoundBinds` in order.
 */
export const STUDY_CLOSE_BOUND_SQL = `(CASE WHEN json_extract(l.state_json,'$.expiresAt')=? THEN
  MIN(json_extract(l.state_json,'$.startedAt')+?,
    COALESCE(MAX(json_extract(l.state_json,'$.startedAt'),json_extract(p.binding_json,'$.enrollment.expiresAt')*1000-1),
      json_extract(l.state_json,'$.startedAt')+?))
  ELSE json_extract(l.state_json,'$.expiresAt') END)`;
export const studyCloseBoundBinds = [
  STUDY_LESSON_NO_DEADLINE,
  STUDY_OPEN_LESSON_MAX_MS,
  STUDY_OPEN_LESSON_MAX_MS,
] as const;
export function makeStudyLessonService(options: {
  db: D1Database;
  attempts: ReturnType<typeof makeStudyService>;
  // Return all eligible published lines in song order. Selection is per owner.
  resolveLines: (song: StudySong) => Promise<StudyLine[]>;
  now?: () => number;
  /**
   * The bound consent's end in seconds, or null for a draft never bound. The
   * community layer reads study_publications; a lesson-only database has no
   * bindings, so every lesson there is a draft.
   */
  consentExpiry?: (owner: StudyPrincipal, id: string) => Promise<number | null>;
}) {
  const store = new StudyLessonStore(options.db),
    attempts = new StudyAttemptStore(options.db),
    now = options.now ?? Date.now,
    consentExpiry = options.consentExpiry ?? (async () => null);
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
    let bound: StudyCloseBound | undefined;
    for (let retry = 0; retry < 12; retry++) {
      const row = await store.row(owner, id),
        state = store.state(row);
      if (state.status !== "active") return row;
      bound ??= studyCloseBound(
        state,
        studyLessonHasDeadline(state)
          ? null
          : await consentExpiry(owner, id),
      );
      // A legacy lesson consumes any saved grade; its speech layer refused to
      // save one after the deadline. A new lesson consumes only a grade that
      // finished inside its bound consent, so a late response stays unmeasured.
      const inside = (at: number) =>
        studyLessonHasDeadline(state) || at < bound!.at;
      let attempt = state.currentAttemptId
        ? await options.attempts.get(owner, state.currentAttemptId)
        : null;
      // Consume a grade durably saved before the close bound, even after restart.
      if (
        attempt?.state === "assessed" &&
        inside(attempt.completedAt!)
      ) {
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
      // A late grade above has completedAt >= bound, so the bound has passed.
      if (now() >= bound.at || attempt?.state === "assessed") {
        await store.close(
          owner,
          row,
          closeStudyLesson(
            state,
            bound.status,
            bound.at,
            await store.submittedLines(owner, id),
            bound.reason === "deadline" ? "left" : bound.reason,
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
          inside(attempt.completedAt ?? now()) &&
          (await store.update(
            owner,
            row,
            consumeLessonGrade(state, attempt, attempt.completedAt ?? now()),
          ))
        )
          continue;
        continue;
      } else if (attempt.state === "unavailable") {
        // The operator refused because the bound consent is no longer live:
        // revoked, replaced or ended. The lesson cannot continue, so it closes
        // privately now, inside the consent's window, as consent ended.
        if (
          !studyLessonHasDeadline(state) &&
          attempt.failure === "enrollment_required"
        ) {
          await store.close(
            owner,
            row,
            closeStudyLesson(
              state,
              "abandoned",
              Math.max(state.startedAt, Math.min(now(), bound.at)),
              await store.submittedLines(owner, id),
              "consent_ended",
            ),
            attempt,
          );
          continue;
        }
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
          previous.history_deleted_at == null,
          "study_history_expired",
          410,
        );
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
    /**
     * Leaving, or `consent_ended` when the learner turns public results off
     * in settings: the open lesson closes now, privately, through the same
     * closure, so the bounded retention and erasure apply.
     */
    async abandon(
      owner: StudyPrincipal,
      id: string,
      reason: "left" | "consent_ended" = "left",
    ) {
      ownerFor(owner);
      for (let retry = 0; retry < 12; retry++) {
        const row = await reconcile(owner, id),
          s = store.state(row);
        if (s.status !== "active") return view(owner, row);
        const current = s.currentAttemptId
          ? await options.attempts.get(owner, s.currentAttemptId)
          : null;
        if (current?.state === "assessed") continue;
        // Leaving after the close bound records the bound, never a time
        // outside the deadline or the bound consent.
        const closedAt = now(),
          bound = studyCloseBound(
            s,
            studyLessonHasDeadline(s)
              ? null
              : await consentExpiry(owner, id),
          ),
          late = closedAt >= bound.at;
        if (
          await store.close(
            owner,
            row,
            closeStudyLesson(
              s,
              late ? bound.status : "abandoned",
              late ? bound.at : closedAt,
              await store.submittedLines(owner, id),
              late && bound.reason !== "deadline" ? bound.reason : reason,
            ),
            current,
          )
        )
          return service.get(owner, id);
      }
      throw new StudyError("study_lesson_busy", 409);
    },
    /** Legacy deadlines only. New lessons close through recovery/retention. */
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
