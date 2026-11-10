import { digest } from "../packages/protocol/index.ts";
import {
  actorKey,
  telegramCheck,
  type ChatActor,
} from "../packages/telegram/contracts.ts";
import type {
  TelegramCatalogPort,
  TelegramLessonView,
  TelegramLinkedStudyPort,
  TelegramVoiceInput,
} from "../packages/telegram/study-contracts.ts";
import type {
  TelegramStudySession,
  TelegramStudyWork,
} from "../packages/telegram/work.ts";
import type { TelegramGrants } from "./telegram-grants.ts";
import type { TelegramTrialLessons } from "./telegram-trial.ts";
import type {
  TelegramTrialSpeech,
  TelegramVoiceFiles,
} from "./telegram-speech.ts";
import { linkedLessonView } from "./telegram-linked-study.ts";
import { workTelegramLinked } from "./telegram-linked-jobs.ts";
import { STUDY_POLICY } from "../packages/study/contracts.ts";

export interface TelegramStudyOptions {
  grants: TelegramGrants;
  trial: TelegramTrialLessons;
  speech: TelegramTrialSpeech;
  linked: TelegramLinkedStudyPort;
  files: TelegramVoiceFiles;
  catalog: TelegramCatalogPort;
}
export class TelegramStudyService {
  readonly options: TelegramStudyOptions;
  constructor(options: TelegramStudyOptions) {
    this.options = options;
  }
  private sessionKey(actor: ChatActor, id: string) {
    return `session:${actorKey(actor)}:${id}`;
  }
  session(actor: ChatActor, id?: string) {
    this.options.grants.binding(actor);
    id ??= this.options.grants.store.get<string>(
      `active-session:${actorKey(actor)}`,
    );
    const session = id
      ? this.options.grants.store.get<TelegramStudySession>(
          this.sessionKey(actor, id),
        )
      : undefined;
    telegramCheck(session, "telegram_choose_song", 409);
    return session;
  }
  private save(actor: ChatActor, session: TelegramStudySession) {
    telegramCheck(
      !this.options.grants.store.get(
        `linked-history-expired:${actorKey(actor)}:${session.view.id}`,
      ),
      "telegram_history_expired",
      410,
    );
    this.options.grants.store.set(
      this.sessionKey(actor, session.view.id),
      session,
    );
    return session.view;
  }
  async start(
    actor: ChatActor,
    songKey: string,
    requestId: string,
    controlId?: number,
  ): Promise<TelegramLessonView> {
    const grants = this.options.grants;
    grants.binding(actor);
    const remembered = grants.read(actor),
      grant =
        remembered?.revokedAt === null
          ? await grants.assert(actor, remembered.id)
          : null;
    let view: TelegramLessonView;
    if (grant) {
      const song = await this.options.catalog.song(actor, songKey, grant);
      const lesson = await this.options.linked.start(
        actor,
        grant,
        song,
        `telegram_${digest([actorKey(actor), requestId]).slice(2)}`,
      );
      view = linkedLessonView(lesson, songKey);
      await grants.assert(actor, grant.id);
    } else view = await this.options.trial.start(actor, songKey, requestId);
    return grants.store.transaction(() => {
      grants.binding(actor);
      if (controlId !== undefined)
        telegramCheck(
          grants.store.get<number>(`control:${actorKey(actor)}`) === controlId,
          "telegram_control_stale",
          409,
        );
      if (grant)
        telegramCheck(
          grants.read(actor)?.id === grant.id &&
            grants.read(actor)?.revokedAt === null,
          "telegram_authority_changed",
          403,
        );
      this.save(actor, { actor, mode: view.mode, grant, view });
      grants.store.set(`active-session:${actorKey(actor)}`, view.id);
      grants.store.set(`active-song:${actorKey(actor)}`, songKey);
      return view;
    });
  }
  async resume(actor: ChatActor) {
    const session = this.session(actor);
    const view =
      session.mode === "trial"
        ? this.options.trial.get(actor, session.view.id)
        : linkedLessonView(
            await this.options.linked.get(
              actor,
              await this.options.grants.assert(actor, session.grant!.id),
              session.view.id,
            ),
            session.view.songKey,
          );
    this.save(actor, { ...session, actor, view });
    return view;
  }
  async accept(
    actor: ChatActor,
    voice: TelegramVoiceInput,
    replyMessageId: number,
    updateId: number,
  ) {
    const grants = this.options.grants,
      session = this.session(actor),
      view = session.view;
    telegramCheck(
      view.status === "active" &&
        view.prompt &&
        grants.store.get<string>(
          `prompt-delivery:${actorKey(actor)}:${replyMessageId}`,
        ) === view.prompt.key,
      "telegram_reply_to_current_prompt",
      409,
    );
    const grant = session.grant
      ? await grants.assert(actor, session.grant.id)
      : null;
    const id = "tg_" + digest([actor, updateId]).slice(2),
      key = `speech-job:${id}`;
    return grants.store.transaction(() => {
      grants.binding(actor);
      const previous = grants.store.get<TelegramStudyWork>(key);
      if (previous) {
        telegramCheck(
          previous.voiceFingerprint === digest(voice),
          "telegram_update_conflict",
          409,
        );
        return previous;
      }
      const current = this.session(actor);
      telegramCheck(
        current.view.prompt?.key === view.prompt!.key,
        "telegram_prompt_changed",
        409,
      );
      const pendingKey = `lesson-pending:${actorKey(actor)}:${view.id}`,
        pendingId = grants.store.get<string>(pendingKey);
      const pending = pendingId
        ? grants.store.get<TelegramStudyWork>(`speech-job:${pendingId}`)
        : null;
      telegramCheck(
        !pending || ["applied", "cancelled"].includes(pending.state),
        "telegram_answer_pending",
        409,
      );
      if (grant)
        telegramCheck(
          grants.read(actor)?.id === grant.id &&
            grants.read(actor)?.revokedAt === null,
          "telegram_authority_changed",
          403,
        );
      else {
        telegramCheck(
          grants.read(actor)?.revokedAt !== null,
          "telegram_use_connected_study",
          409,
        );
        this.options.trial.reserve(actor, view.id, view.prompt!.key, id);
      }
      const trialPolicy = grant
        ? null
        : this.options.trial.record(actor, view.id).policy;
      const job: TelegramStudyWork = {
        id,
        actor,
        mode: view.mode,
        grant,
        lessonId: view.id,
        songKey: view.songKey,
        expected: view.prompt!,
        promptKey: view.prompt!.key,
        line: view.prompt!.line,
        policy: trialPolicy ?? STUDY_POLICY,
        presentation: view.prompt!.presentation,
        take: view.prompt!.take,
        voice,
        audioDigest: null,
        reservedDay: Math.floor(grants.now() / 86400_000),
        acceptedAt: grants.now(),
        durationMs: voice.durationMs,
        state: "queued",
        retry: 0,
        nextAt: grants.now(),
        finishedAt: null,
        grade: null,
        failure: null,
        resultView: null,
        rendered: false,
        voiceFingerprint: digest(voice),
      };
      grants.store.set(key, job);
      grants.store.set(pendingKey, id);
      grants.store.set(`lesson-job:${actorKey(actor)}:${view.id}:${id}`, id);
      return job;
    });
  }
  async permit(job: TelegramStudyWork) {
    const grants = this.options.grants;
    grants.binding(job.actor);
    if (job.grant) {
      const current = await grants.assert(job.actor, job.grant.id);
      telegramCheck(
        current.authorityVersion === job.grant.authorityVersion,
        "telegram_authority_changed",
        403,
      );
    }
    telegramCheck(
      grants.store.get<string>(`active-session:${actorKey(job.actor)}`) ===
        job.lessonId,
      "telegram_lesson_changed",
      409,
    );
  }
  async work(id: string): Promise<TelegramStudyWork> {
    const grants = this.options.grants,
      key = `speech-job:${id}`;
    let job = grants.store.get<TelegramStudyWork>(key);
    telegramCheck(job, "telegram_job_not_found", 404);
    if (["applied", "cancelled"].includes(job.state)) return job;
    const initial = job;
    try {
      await this.permit(job);
      if (job.mode === "trial") await this.options.speech.work(id);
      else if (!["assessed", "refused"].includes(job.state))
        await workTelegramLinked(
          {
            store: grants.store,
            linked: this.options.linked,
            files: this.options.files,
            permit: (job) => this.permit(job),
            now: grants.now,
          },
          job,
        );
      job = grants.store.get<TelegramStudyWork>(key)!;
      telegramCheck(job, "telegram_history_expired", 410);
      if (!["assessed", "refused"].includes(job.state)) return job;
      await this.permit(job);
      return grants.store.transaction(() => {
        const current = grants.store.get<TelegramStudyWork>(key);
        telegramCheck(current, "telegram_history_expired", 410);
        if (current.state === "applied") return current;
        let view = current.resultView;
        if (current.mode === "trial") {
          view =
            current.state === "assessed"
              ? this.options.trial.apply(
                  current.actor,
                  current.lessonId,
                  current.id,
                  current.grade!,
                  current.durationMs,
                  current.finishedAt!,
                )
              : this.options.trial.refuse(
                  current.actor,
                  current.lessonId,
                  current.id,
                  current.reservedDay,
                );
        }
        telegramCheck(view, "telegram_result_pending", 409);
        const next: TelegramStudyWork = {
          ...current,
          state: "applied",
          resultView: view,
          voice: null,
        };
        this.save(current.actor, {
          ...this.session(current.actor, current.lessonId),
          view,
        });
        grants.store.set(key, next);
        return next;
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        ([403, 410].includes(Number(error.status)) ||
          ("code" in error &&
            [
              "telegram_bot_changed",
              "telegram_lesson_changed",
              "telegram_prompt_changed",
            ].includes(String(error.code))))
      ) {
        const existing = grants.store.get<TelegramStudyWork>(key);
        if (!existing)
          return {
            ...initial,
            state: "cancelled",
            voice: null,
            grade: null,
            resultView: null,
            failure: "telegram_history_expired",
          };
        const cancelled: TelegramStudyWork = {
          ...existing,
          state: "cancelled",
          voice: null,
          failure: "telegram_authority_changed",
        };
        grants.store.set(key, cancelled);
        return cancelled;
      }
      throw error;
    }
  }
}
