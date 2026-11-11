import { digest } from "../packages/protocol/index.ts";
import {
  STUDY_POLICY,
  type StudyAttempt,
} from "../packages/study/contracts.ts";
import {
  closeStudyLesson,
  consumeLessonGrade,
  newLesson,
} from "../packages/study/lesson.ts";
import { selectStudyLessonLines } from "../packages/study/line-selection.ts";
import type { TelegramSpeechJob } from "./telegram-speech.ts";
import {
  TELEGRAM_HISTORY_MS,
  TELEGRAM_OPEN_MS,
  actorKey,
  telegramCheck,
  type ChatActor,
} from "../packages/telegram/contracts.ts";
import type {
  TelegramCatalogPort,
  TelegramLessonView,
  TelegramTrialRecord,
} from "../packages/telegram/study-contracts.ts";
import { TelegramGrants } from "./telegram-grants.ts";
import {
  releasedTelegramGrading,
  type TelegramGrade,
  type TelegramTrialGradingPort,
} from "../packages/telegram/grading.ts";
import { trialDebitKey, trialQuotaKey } from "./telegram-trial-quota.ts";

/** Guest lessons have their own table namespace and never call an account,
 * publication, qualification or reward writer. The established queue and
 * published-line selector remain independently owned packages/study imports. */
export class TelegramTrialLessons {
  readonly grants: TelegramGrants;
  readonly catalog: TelegramCatalogPort;
  readonly limits: { perUserDailySpeech: number; maxOpenLessons: number };
  readonly grading: TelegramTrialGradingPort;
  constructor(
    grants: TelegramGrants,
    catalog: TelegramCatalogPort,
    limits: { perUserDailySpeech: number; maxOpenLessons: number },
    grading = releasedTelegramGrading,
  ) {
    this.grants = grants;
    this.catalog = catalog;
    this.limits = limits;
    this.grading = grading;
    telegramCheck(
      Number.isSafeInteger(limits.perUserDailySpeech) &&
        limits.perUserDailySpeech > 0 &&
        limits.perUserDailySpeech <= 100 &&
        Number.isSafeInteger(limits.maxOpenLessons) &&
        limits.maxOpenLessons > 0 &&
        limits.maxOpenLessons <= 10,
      "telegram_trial_limits_required",
    );
  }
  private key(actor: ChatActor, id: string) {
    return `trial:${actorKey(actor)}:${id}`;
  }
  record(actor: ChatActor, id: string) {
    this.grants.binding(actor);
    const record = this.grants.store.get<TelegramTrialRecord>(
      this.key(actor, id),
    );
    telegramCheck(record, "telegram_lesson_not_found", 404);
    telegramCheck(
      record.historyDeletedAt === null,
      "telegram_history_expired",
      410,
    );
    telegramCheck(
      record.actor.communityId === actor.communityId &&
        record.actor.botId === actor.botId &&
        record.actor.userId === actor.userId,
      "telegram_lesson_not_found",
      404,
    );
    return record;
  }
  view(record: TelegramTrialRecord): TelegramLessonView {
    const state = record.state,
      current =
        state.currentIndex === null ? null : state.items[state.currentIndex];
    return {
      id: record.id,
      mode: "trial",
      songKey: record.songKey,
      status: state.status,
      revision: record.revision,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      prompt: current
        ? {
            key: digest([
              record.id,
              record.revision,
              current.line.lineId,
              state.presentationCount + 1,
              state.takeNumber,
            ]),
            line: current.line,
            presentation: state.presentationCount + 1,
            take: state.takeNumber,
          }
        : null,
      progress: {
        total: state.items.length,
        resolved: state.items.filter((i) => i.resolved).length,
      },
      score:
        state.status === "completed"
          ? Math.round(
              (100 *
                state.items.filter((i) => i.firstPassOutcome === "correct")
                  .length) /
                state.items.length,
            )
          : null,
    };
  }
  reconcile(record: TelegramTrialRecord): TelegramTrialRecord {
    return this.grants.store.transaction(() => {
      const actor = record.actor,
        id = record.id;
      if (record.state.currentAttemptId) {
        const pending = this.grants.store.get<TelegramSpeechJob>(
          `speech-job:${record.state.currentAttemptId}`,
        );
        if (pending?.state === "cancelled") {
          record = {
            ...record,
            state: { ...record.state, currentAttemptId: null },
          };
          this.grants.store.set(this.key(actor, id), record);
        }
      }
      if (
        record.state.status === "active" &&
        this.grants.now() >= record.state.startedAt + TELEGRAM_OPEN_MS
      ) {
        record = {
          ...record,
          revision: record.revision + 1,
          state: closeStudyLesson(
            record.state,
            "abandoned",
            record.state.startedAt + TELEGRAM_OPEN_MS,
            new Set(
              record.state.currentAttemptId
                ? [record.state.items[record.state.currentIndex!].line.lineId]
                : [],
            ),
            "open_limit",
          ),
        };
        this.grants.store.set(this.key(actor, id), record);
      }
      return record;
    });
  }
  get(actor: ChatActor, id: string) {
    return this.view(this.reconcile(this.record(actor, id)));
  }
  async start(actor: ChatActor, songKey: string, requestId: string) {
    this.grants.binding(actor);
    const song = await this.catalog.song(actor, songKey, null);
    telegramCheck(
      song.song.communityId === actor.communityId,
      "telegram_wrong_community",
      403,
    );
    const lines = selectStudyLessonLines(
      song.song,
      await this.catalog.lines(song.song),
      [],
    );
    const requestKey = `trial-request:${actorKey(actor)}:${requestId}`;
    return this.grants.store.transaction(() => {
      this.grants.binding(actor);
      telegramCheck(
        this.grants.read(actor)?.revokedAt !== null,
        "telegram_use_connected_study",
        409,
      );
      const previousId = this.grants.store.get<string>(requestKey);
      if (previousId) {
        const previous = this.record(actor, previousId);
        telegramCheck(
          previous.songKey === songKey,
          "telegram_request_conflict",
          409,
        );
        return this.get(actor, previousId);
      }
      const rows = this.grants.store.entries<TelegramTrialRecord>(
        `trial:${actorKey(actor)}:`,
      );
      for (const row of rows) {
        if (
          row.value.historyDeletedAt === null &&
          row.value.state.status === "active"
        ) {
          const existing = this.get(actor, row.value.id);
          if (existing.songKey === songKey && existing.status === "active")
            return existing;
        }
      }
      const open = rows.filter(
        (row) =>
          row.value.historyDeletedAt === null &&
          this.grants.store.get<TelegramTrialRecord>(row.key)?.state.status ===
            "active",
      );
      telegramCheck(
        open.length < this.limits.maxOpenLessons,
        "telegram_trial_open_limit",
        429,
      );
      const id = "trial_" + crypto.randomUUID();
      const record: TelegramTrialRecord = {
        id,
        actor,
        songKey,
        state: newLesson(song.song, lines, this.grants.now()),
        revision: 1,
        policy: this.grading.policyAt(this.grants.now()),
        historyDeletedAt: null,
      };
      this.grants.store.set(this.key(actor, id), record);
      this.grants.store.set(requestKey, id);
      return this.view(record);
    });
  }
  reserve(actor: ChatActor, id: string, promptKey: string, attemptId: string) {
    return this.grants.store.transaction(() => {
      const view = this.get(actor, id),
        record = this.record(actor, id);
      telegramCheck(
        view.status === "active" && view.prompt?.key === promptKey,
        "telegram_prompt_changed",
        409,
      );
      telegramCheck(
        record.state.currentAttemptId === null,
        "telegram_answer_pending",
        409,
      );
      const day = Math.floor(this.grants.now() / 86400_000),
        quotaKey = trialQuotaKey(actor, day);
      const used = this.grants.store.get<number>(quotaKey) ?? 0;
      telegramCheck(
        used < this.limits.perUserDailySpeech,
        "telegram_trial_budget_exhausted",
        429,
      );
      this.grants.store.set(quotaKey, used + 1);
      this.grants.store.set(trialDebitKey(attemptId), {
        actor,
        lessonId: id,
        day,
      });
      const next = {
        ...record,
        state: { ...record.state, currentAttemptId: attemptId },
      };
      this.grants.store.set(this.key(actor, id), next);
      return day;
    });
  }
  refuse(job: TelegramSpeechJob) {
    const { actor, lessonId: id, id: attemptId } = job;
    return this.grants.store.transaction(() => {
      const record = this.record(actor, id);
      if (record.state.currentAttemptId !== attemptId)
        return this.get(actor, id);
      this.grants.store.set(this.key(actor, id), {
        ...record,
        state: { ...record.state, currentAttemptId: null },
      });
      return this.get(actor, id);
    });
  }
  apply(job: TelegramSpeechJob) {
    const {
      actor,
      lessonId: id,
      id: attemptId,
      grade,
      durationMs,
      finishedAt,
    } = job;
    return this.grants.store.transaction(() => {
      const record = this.record(actor, id),
        view = this.view(record);
      if (record.state.lastAttemptId === attemptId) return view;
      telegramCheck(
        view.status === "active" &&
          view.prompt?.key === job.promptKey &&
          record.state.currentAttemptId === attemptId &&
          grade &&
          finishedAt !== null &&
          finishedAt < record.state.startedAt + TELEGRAM_OPEN_MS,
        "telegram_lesson_closed",
        410,
      );
      const next = this.consume(
        record,
        attemptId,
        grade,
        durationMs,
        finishedAt,
      );
      this.grants.store.set(this.key(actor, id), next);
      return this.view(this.reconcile(next));
    });
  }
  history(actor: ChatActor, id: string) {
    const view = this.get(actor, id),
      record = this.record(actor, id);
    telegramCheck(
      view.completedAt === null ||
        this.grants.now() <= view.completedAt + TELEGRAM_HISTORY_MS,
      "telegram_history_expired",
      410,
    );
    return {
      schema: "pirate.telegram.private-trial-history/1",
      lesson: view,
      lines: record.state.items.map((item) => ({
        lineId: item.line.lineId,
        text: item.line.text,
        firstPassOutcome: item.firstPassOutcome,
        presentations: item.presentations,
      })),
      publication: "never",
      rewards: "none",
    };
  }
  private consume(
    record: TelegramTrialRecord,
    attemptId: string,
    grade: TelegramGrade,
    durationMs: number,
    finishedAt: number,
  ) {
    const view = this.view(record),
      line = view.prompt!.line;
    telegramCheck(
      grade.policyRevision === record.policy,
      "telegram_grading_policy_changed",
      409,
    );
    const attempt: StudyAttempt = {
      schema: "pirate.study.attempt/1",
      kind: "say-it-back",
      attemptId,
      line,
      policy: record.policy as typeof STUDY_POLICY,
      startedAt: finishedAt,
      completedAt: finishedAt,
      state: "assessed",
      // The shared queue consumes the verdict and policy only.
      grade: {
        ...grade,
        heardTranscript: "",
        matched: [],
        missing: [],
        extra: [],
        substituted: [],
      },
      failure: null,
      lesson: {
        lessonId: record.id,
        presentationNumber: view.prompt!.presentation,
        takeNumber: view.prompt!.take,
      },
      recordingDurationMs: durationMs,
      qualification: "not_evaluated",
    };
    return {
      ...record,
      revision: record.revision + 1,
      state: consumeLessonGrade(record.state, attempt, finishedAt),
    };
  }
}
