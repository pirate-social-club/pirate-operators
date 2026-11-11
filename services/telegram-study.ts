import { digest } from "../packages/protocol/index.ts";
import {
  TELEGRAM_OPEN_MS,
  accountMatches,
  actorKey,
  sameActor,
  telegramCheck,
  type ChatActor,
  type TelegramGrant,
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
import { telegramWorkAuthorityLost } from "./telegram-work-claim.ts";
import { readTelegramSpeechJob } from "./telegram-job-privacy.ts";

/** The durable link identifies the association. Its version is from linking. */
function sameLinkedGrant(
  stored: TelegramGrant | null | undefined,
  expected: TelegramGrant,
) {
  return (
    stored?.revokedAt === null &&
    stored.id === expected.id &&
    stored.accountId === expected.accountId &&
    stored.wallet.toLowerCase() === expected.wallet.toLowerCase()
  );
}

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
  private assertHistory(actor: ChatActor, id: string) {
    telegramCheck(
      !this.options.grants.store.get(
        `linked-history-expired:${actorKey(actor)}:${id}`,
      ),
      "telegram_history_expired",
      410,
    );
  }
  private save(actor: ChatActor, session: TelegramStudySession) {
    this.assertHistory(actor, session.view.id);
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
      await this.assertCurrentAuthority(actor, grant);
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
          sameLinkedGrant(grants.read(actor), grant),
          "telegram_authority_changed",
          403,
        );
      this.save(actor, { actor, mode: view.mode, grant, view });
      grants.store.set(`active-session:${actorKey(actor)}`, view.id);
      grants.store.set(`active-song:${actorKey(actor)}`, songKey);
      return view;
    });
  }
  async resume(actor: ChatActor, controlId?: number) {
    const grants = this.options.grants,
      session = this.session(actor);
    if (session.mode === "trial")
      return this.save(actor, {
        ...session,
        actor,
        view: this.options.trial.get(actor, session.view.id),
      });
    const grant = await grants.assert(actor, session.grant!.id);
    this.assertHistory(actor, session.view.id);
    if (grant.authorityVersion !== session.grant!.authorityVersion)
      return this.start(
        actor,
        session.view.songKey,
        "authority_resume_" +
          digest([session.view.id, grant.id, grant.authorityVersion]).slice(2),
        controlId,
      );
    const view = linkedLessonView(
      await this.options.linked.get(actor, grant, session.view.id),
      session.view.songKey,
    );
    await this.assertCurrentAuthority(actor, grant);
    return grants.store.transaction(() => {
      grants.binding(actor);
      // Retention wins before checking the now-removed active pointer.
      this.assertHistory(actor, session.view.id);
      telegramCheck(
        (controlId === undefined ||
          grants.store.get<number>(`control:${actorKey(actor)}`) ===
            controlId) &&
          grants.store.get<string>(`active-session:${actorKey(actor)}`) ===
            session.view.id,
        "telegram_control_stale",
        409,
      );
      telegramCheck(
        sameLinkedGrant(grants.read(actor), grant),
        "telegram_authority_changed",
        403,
      );
      return this.save(actor, { ...session, actor, grant, view });
    });
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
      let reservedDay = Math.floor(grants.now() / 86400_000);
      if (grant) {
        telegramCheck(
          sameLinkedGrant(grants.read(actor), grant) &&
            sameLinkedGrant(current.grant, grant),
          "telegram_authority_changed",
          403,
        );
        telegramCheck(
          current.grant?.authorityVersion === grant.authorityVersion,
          "telegram_authority_changed",
          403,
        );
      } else {
        telegramCheck(
          grants.read(actor)?.revokedAt !== null,
          "telegram_use_connected_study",
          409,
        );
        reservedDay = this.options.trial.reserve(
          actor,
          view.id,
          view.prompt!.key,
          id,
        );
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
        reservedDay,
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
        ...(view.mode === "trial"
          ? {
              reservation: {
                keyGeneration: this.options.speech.config.keyGeneration,
                started: false,
              },
            }
          : {}),
      };
      grants.store.set(key, job);
      grants.store.set(pendingKey, id);
      grants.store.set(`lesson-job:${actorKey(actor)}:${view.id}:${id}`, id);
      return job;
    });
  }
  private async assertCurrentAuthority(
    actor: ChatActor,
    expected: TelegramGrant,
  ) {
    const current = await this.options.grants.assert(actor, expected.id);
    telegramCheck(
      accountMatches(current, expected),
      "telegram_authority_changed",
      403,
    );
  }
  async permit(job: TelegramStudyWork) {
    const grants = this.options.grants;
    grants.binding(job.actor);
    if (job.grant) await this.assertCurrentAuthority(job.actor, job.grant);
    telegramCheck(
      grants.store.get<string>(`active-session:${actorKey(job.actor)}`) ===
        job.lessonId,
      "telegram_lesson_changed",
      409,
    );
  }
  /** After permit checks the live version, fence local identity at commit. */
  private currentWorkSession(job: TelegramStudyWork) {
    const grants = this.options.grants;
    grants.binding(job.actor);
    const active = grants.store.get<string>(
      `active-session:${actorKey(job.actor)}`,
    );
    const session = grants.store.get<TelegramStudySession>(
      this.sessionKey(job.actor, job.lessonId),
    );
    telegramCheck(
      active === job.lessonId &&
        session?.mode === job.mode &&
        sameActor(session.actor, job.actor),
      "telegram_lesson_changed",
      409,
    );
    telegramCheck(
      session.view.status === "active",
      "telegram_lesson_closed",
      410,
    );
    telegramCheck(
      session.view.prompt?.key === job.promptKey,
      "telegram_prompt_changed",
      409,
    );
    const current = grants.read(job.actor);
    if (job.grant) {
      telegramCheck(
        sameLinkedGrant(current, job.grant) &&
          sameLinkedGrant(session.grant, job.grant),
        "telegram_authority_changed",
        403,
      );
    } else
      telegramCheck(
        session.grant === null && current?.revokedAt !== null,
        "telegram_authority_changed",
        403,
      );
    return session;
  }
  beforeSubmission(job: TelegramStudyWork) {
    const session = this.currentWorkSession(job);
    telegramCheck(
      this.options.grants.now() < session.view.startedAt + TELEGRAM_OPEN_MS,
      "telegram_lesson_closed",
      410,
    );
  }
  async work(id: string): Promise<TelegramStudyWork> {
    const grants = this.options.grants,
      key = `speech-job:${id}`;
    let job = readTelegramSpeechJob<TelegramStudyWork>(grants.store, key);
    telegramCheck(job, "telegram_job_not_found", 404);
    if (["applied", "cancelled"].includes(job.state)) return job;
    const initial = job;
    try {
      if (job.mode === "trial") await this.options.speech.work(id);
      else if (!["assessed", "refused"].includes(job.state)) {
        await this.permit(job);
        await workTelegramLinked(
          {
            store: grants.store,
            linked: this.options.linked,
            files: this.options.files,
            permit: (job) => this.permit(job),
            beforeSubmission: (job) => this.beforeSubmission(job),
            now: grants.now,
          },
          job,
        );
      }
      job = readTelegramSpeechJob<TelegramStudyWork>(grants.store, key)!;
      telegramCheck(job, "telegram_history_expired", 410);
      if (!["assessed", "refused"].includes(job.state)) return job;
      const authorized = job;
      await this.permit(authorized);
      return grants.store.transaction(() => {
        const current = readTelegramSpeechJob<TelegramStudyWork>(
          grants.store,
          key,
        );
        telegramCheck(current, "telegram_history_expired", 410);
        if (
          current.state !== authorized.state ||
          current.dispatchToken !== authorized.dispatchToken ||
          current.retry !== authorized.retry
        )
          return current;
        const session = this.currentWorkSession(current);
        let view = current.resultView;
        if (current.mode === "trial") {
          view =
            current.state === "assessed"
              ? this.options.trial.apply(current)
              : this.options.trial.refuse(current);
        }
        telegramCheck(view, "telegram_result_pending", 409);
        const next: TelegramStudyWork = {
          ...current,
          state: "applied",
          resultView: view,
          voice: null,
        };
        this.save(current.actor, {
          ...session,
          view,
        });
        grants.store.set(key, next);
        return next;
      });
    } catch (error) {
      if (telegramWorkAuthorityLost(error)) {
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
        if (existing.mode === "trial") {
          return (await this.options.speech.cancel(id)) as TelegramStudyWork;
        }
        if (
          ["dispatching", "uncertain"].includes(existing.state) &&
          existing.submissionStarted !== false
        ) {
          const pending = {
            ...existing,
            state: "uncertain" as const,
            voice: null,
          };
          grants.store.set(key, pending);
          return pending;
        }
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
