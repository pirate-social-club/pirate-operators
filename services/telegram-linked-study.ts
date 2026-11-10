import { digest } from "../packages/protocol/index.ts";
import {
  StudyAttemptStore,
  attemptView,
} from "../packages/study/attempt-store.ts";
import type { StudyLesson } from "../packages/study/lesson.ts";
import {
  telegramCheck,
  type ChatActor,
  type TelegramGrant,
} from "../packages/telegram/contracts.ts";
import type {
  TelegramLessonView,
  TelegramLinkedStudyPort,
} from "../packages/telegram/study-contracts.ts";
import type { liveStudy } from "./study-community.ts";
import type { TelegramGrants } from "./telegram-grants.ts";
import {
  scrubLinkedGrades,
  telegramLinkedDatabase,
} from "./telegram-linked-privacy.ts";

/** Exact structural contract from lane6 community-setup/connected-learning.ts.
 * Its implementation is injected at the coordinator mount, never replaced by
 * a permissive Telegram-local authorization service. */
export interface TelegramConnectedContext {
  communityId: string;
  botId: string;
  generation: number;
  startedAtMs: number;
}
export interface TelegramConnectedLink extends TelegramConnectedContext {
  version: 1;
  accountId: string;
  wallet: string;
  linkedAtMs: number;
  revokedAtMs: number | null;
}
export interface TelegramPublicationFence {
  version: 1;
  grantId: string;
  actor: ChatActor;
  accountId: string;
  authorityVersion: string;
  check(): Promise<void>;
}
export function linkedLessonView(
  lesson: StudyLesson,
  songKey: string,
): TelegramLessonView {
  return {
    id: lesson.lessonId,
    mode: "linked",
    songKey,
    status: lesson.status,
    revision: lesson.progress.presentations + 1,
    startedAt: lesson.startedAt,
    completedAt: lesson.completedAt,
    prompt: lesson.current
      ? {
          key: digest([
            lesson.lessonId,
            lesson.current.line.lineId,
            lesson.current.presentationNumber,
            lesson.current.takeNumber,
          ]),
          line: lesson.current.line,
          presentation: lesson.current.presentationNumber,
          take: lesson.current.takeNumber,
        }
      : null,
    progress: {
      total: lesson.progress.total,
      resolved: lesson.progress.resolved,
    },
    score:
      lesson.status === "completed"
        ? Math.round(
            (100 * lesson.progress.firstPassCorrect) / lesson.progress.total,
          )
        : null,
  };
}
export function telegramLinkedStudy(options: {
  grants: TelegramGrants;
  db: D1Database;
  /** Coordinator/lane5 factory binds the trusted channel into the frozen offer. */
  /** Shared publisher must persist the fence metadata and recheck it at
   * queue acceptance and unsent dispatch, including recovery after restart. */
  createStudy(
    session: { account_id: string; wallet: string },
    channel: "telegram-linked",
    fence: TelegramPublicationFence,
    db: D1Database,
  ): ReturnType<typeof liveStudy> & { telegramGrantFenceVersion: 1 };
  authorize(
    context: TelegramConnectedContext,
    resolve: () => Promise<TelegramConnectedLink | null>,
  ): Promise<{ id: string | null; pending?: boolean }>;
  personal: TelegramLinkedStudyPort["personal"];
}): TelegramLinkedStudyPort {
  const linkedDb = telegramLinkedDatabase(options.db);
  async function authority(
    actor: ChatActor,
    expected: TelegramGrant,
    startedAtMs: number,
  ) {
    const current = await options.grants.assert(actor, expected.id);
    telegramCheck(
      current.accountId === expected.accountId &&
        current.wallet === expected.wallet &&
        current.authorityVersion === expected.authorityVersion &&
        startedAtMs >= current.linkedAt,
      "telegram_authority_changed",
      403,
    );
    const context = {
      communityId: actor.communityId,
      botId: actor.botId,
      generation: actor.generation,
      startedAtMs,
    };
    const admitted = await options.authorize(context, async () => {
      const grant = await options.grants.assert(actor, expected.id);
      return {
        ...context,
        version: 1,
        accountId: grant.accountId,
        wallet: grant.wallet,
        linkedAtMs: grant.linkedAt,
        revokedAtMs: grant.revokedAt,
      };
    });
    telegramCheck(
      admitted.id,
      admitted.pending
        ? "telegram_authorization_pending"
        : "telegram_authorization_required",
      admitted.pending ? 409 : 403,
    );
    const after = await options.grants.assert(actor, expected.id);
    telegramCheck(
      after.authorityVersion === expected.authorityVersion,
      "telegram_authority_changed",
      403,
    );
    const fence: TelegramPublicationFence = {
      version: 1,
      grantId: expected.id,
      actor,
      accountId: expected.accountId,
      authorityVersion: expected.authorityVersion,
      async check() {
        const grant = await options.grants.assert(actor, expected.id);
        telegramCheck(
          grant.authorityVersion === expected.authorityVersion,
          "telegram_authority_changed",
          403,
        );
        const accepted = await options.authorize(context, async () => {
          const latest = await options.grants.assert(actor, expected.id);
          return {
            ...context,
            version: 1,
            accountId: latest.accountId,
            wallet: latest.wallet,
            linkedAtMs: latest.linkedAt,
            revokedAtMs: latest.revokedAt,
          };
        });
        telegramCheck(accepted.id, "telegram_authorization_required", 403);
        const after = await options.grants.assert(actor, expected.id);
        telegramCheck(
          after.authorityVersion === expected.authorityVersion,
          "telegram_authority_changed",
          403,
        );
      },
    };
    const api = options.createStudy(
      { account_id: current.accountId, wallet: current.wallet },
      "telegram-linked",
      fence,
      linkedDb,
    );
    telegramCheck(
      api.telegramGrantFenceVersion === 1,
      "telegram_publication_fence_required",
      503,
    );
    return api;
  }
  async function channel(
    actor: ChatActor,
    grant: TelegramGrant,
    lesson: StudyLesson,
  ) {
    const row = await options.db
      .prepare(
        "SELECT binding_json FROM study_publications WHERE lesson_id=? AND account_id=? AND community_id=?",
      )
      .bind(lesson.lessonId, grant.accountId, actor.communityId)
      .first<{ binding_json: string }>();
    const offer = row ? JSON.parse(row.binding_json)?.offer : null;
    telegramCheck(
      offer?.speechChannel === "telegram-linked",
      "telegram_linked_channel_not_bound",
      503,
    );
  }
  async function existing(actor: ChatActor, grant: TelegramGrant, id: string) {
    const row = await options.db
      .prepare(
        "SELECT started_at FROM study_lessons WHERE lesson_id=? AND account_id=? AND community_id=? AND history_deleted_at IS NULL",
      )
      .bind(id, grant.accountId, actor.communityId)
      .first<{ started_at: number }>();
    telegramCheck(row, "telegram_lesson_not_found", 404);
    const api = await authority(actor, grant, row.started_at);
    await channel(actor, grant, { lessonId: id } as StudyLesson);
    await scrubLinkedGrades(options.db, id, grant.accountId, actor.communityId);
    return api;
  }
  return {
    async start(actor, grant, song, requestId) {
      const api = await authority(actor, grant, options.grants.now());
      const previous = await options.db
        .prepare(
          `SELECT l.lesson_id FROM study_lessons l JOIN study_publications p ON p.lesson_id=l.lesson_id
        AND p.account_id=l.account_id AND p.community_id=l.community_id WHERE l.account_id=? AND l.community_id=? AND l.song_json=?
        AND l.started_at>=? AND l.history_deleted_at IS NULL AND json_extract(l.state_json,'$.status')='active'
        AND json_extract(p.binding_json,'$.offer.speechChannel')='telegram-linked' ORDER BY l.started_at DESC LIMIT 1`,
        )
        .bind(
          grant.accountId,
          actor.communityId,
          JSON.stringify(song.song),
          grant.linkedAt,
        )
        .first<{ lesson_id: string }>();
      if (previous)
        return (await existing(actor, grant, previous.lesson_id)).get(
          previous.lesson_id,
        );
      const lesson = await api.start(requestId, song.song);
      await channel(actor, grant, lesson);
      await authority(actor, grant, lesson.startedAt);
      return lesson;
    },
    async get(actor, grant, id) {
      const api = await existing(actor, grant, id),
        lesson = await api.get(id);
      await authority(actor, grant, lesson.startedAt);
      await channel(actor, grant, lesson);
      return lesson;
    },
    async answer(actor, grant, id, expected, request) {
      const api = await existing(actor, grant, id),
        lesson = await api.get(id);
      await authority(actor, grant, lesson.startedAt);
      await channel(actor, grant, lesson);
      telegramCheck(
        expected && linkedLessonView(lesson, "").prompt?.key === expected.key,
        "telegram_prompt_changed",
        409,
      );
      const opened = await api.open(id, expected.presentation, expected.take);
      await authority(actor, grant, lesson.startedAt);
      const result = await api.submit(id, opened.attempt.attemptId, request);
      await authority(actor, grant, lesson.startedAt);
      return result;
    },
    async recover(actor, grant, id, expected, audioDigest) {
      const api = await existing(actor, grant, id),
        lesson = await api.get(id);
      await authority(actor, grant, lesson.startedAt);
      await channel(actor, grant, lesson);
      telegramCheck(expected, "telegram_prompt_changed", 409);
      const row = await options.db
        .prepare(
          "SELECT attempt_id,audio_digest FROM study_attempts WHERE lesson_id=? AND account_id=? AND community_id=? AND presentation_number=? AND take_number=? ORDER BY started_at DESC LIMIT 1",
        )
        .bind(
          id,
          grant.accountId,
          actor.communityId,
          expected.presentation,
          expected.take,
        )
        .first<{ attempt_id: string; audio_digest: string | null }>();
      if (!row) return { lesson, attempt: null };
      telegramCheck(
        row.audio_digest === audioDigest,
        "telegram_audio_changed",
        409,
      );
      const attempt = attemptView(
        await new StudyAttemptStore(options.db).get(
          { accountId: grant.accountId, communityId: actor.communityId },
          row.attempt_id,
        ),
      );
      telegramCheck(
        attempt.line.lineId === expected.line.lineId,
        "telegram_prompt_changed",
        409,
      );
      return { lesson, attempt };
    },
    async personal(actor, grant, song) {
      await authority(actor, grant, options.grants.now());
      const status = await options.personal(actor, grant, song);
      await authority(actor, grant, options.grants.now());
      return status;
    },
  };
}
