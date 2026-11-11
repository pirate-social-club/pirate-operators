import { bytes32 } from "../packages/community/common.ts";
import {
  telegramStudyFacts,
  telegramStudyFence,
} from "../packages/study/telegram-publication.ts";
import type { Hex } from "viem";
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
  authorizationId?: string;
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
  startedAt: number;
  authorizationId: Hex;
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
    capturedId?: Hex,
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
      ...(capturedId ? { authorizationId: capturedId } : {}),
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
    telegramCheck(
      capturedId === undefined || admitted.id === capturedId,
      "telegram_authorization_changed",
      403,
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
      startedAt: startedAtMs,
      authorizationId: bytes32(admitted.id),
      async check() {
        const grant = await options.grants.assert(actor, expected.id);
        telegramCheck(
          grant.authorityVersion === expected.authorityVersion,
          "telegram_authority_changed",
          403,
        );
        const accepted = await options.authorize(
          { ...context, authorizationId: admitted.id! },
          async () => {
            const latest = await options.grants.assert(actor, expected.id);
            return {
              ...context,
              version: 1,
              accountId: latest.accountId,
              wallet: latest.wallet,
              linkedAtMs: latest.linkedAt,
              revokedAtMs: latest.revokedAt,
            };
          },
        );
        telegramCheck(
          accepted.id === admitted.id,
          "telegram_authorization_changed",
          403,
        );
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
        `SELECT p.binding_json,
          json_extract(l.state_json,'$.telegram.fenceHash') AS fence_hash,
          json_extract(l.state_json,'$.telegram.authorizationId') AS authorization_id
          FROM study_publications p JOIN study_lessons l ON l.lesson_id=p.lesson_id
            AND l.account_id=p.account_id AND l.community_id=p.community_id
          WHERE p.lesson_id=? AND p.account_id=? AND p.community_id=? AND l.history_deleted_at IS NULL`,
      )
      .bind(lesson.lessonId, grant.accountId, actor.communityId)
      .first<{
        binding_json: string;
        fence_hash: string | null;
        authorization_id: string | null;
      }>();
    const offer = row ? JSON.parse(row.binding_json)?.offer : null;
    telegramCheck(
      row && offer?.speechChannel === "telegram-linked",
      "telegram_linked_channel_not_bound",
      503,
    );
    const expected = telegramStudyFacts({
      schema: "pirate.study.telegram-publication-fence/1",
      version: 1,
      grantId: grant.id,
      actor,
      accountId: grant.accountId,
      authorityVersion: grant.authorityVersion,
    });
    const fence = telegramStudyFence(offer.telegramFence);
    telegramCheck(
      row.fence_hash === fence.hash &&
        fence.hash === digest(expected) &&
        row.authorization_id === offer.authorizationId,
      "telegram_saved_provenance_required",
      409,
    );
  }
  async function savedAuthorization(
    actor: ChatActor,
    grant: TelegramGrant,
    id: string,
  ) {
    const row = await options.db
      .prepare(
        "SELECT json_extract(state_json,'$.telegram.authorizationId') AS id FROM study_lessons WHERE lesson_id=? AND account_id=? AND community_id=? AND history_deleted_at IS NULL",
      )
      .bind(id, grant.accountId, actor.communityId)
      .first<{ id: string | null }>();
    telegramCheck(row?.id, "telegram_saved_authorization_required", 409);
    return bytes32(row.id);
  }
  async function existing(actor: ChatActor, grant: TelegramGrant, id: string) {
    const row = await options.db
      .prepare(
        "SELECT started_at,json_extract(state_json,'$.telegram.authorizationId') AS authorization_id FROM study_lessons WHERE lesson_id=? AND account_id=? AND community_id=? AND history_deleted_at IS NULL",
      )
      .bind(id, grant.accountId, actor.communityId)
      .first<{ started_at: number; authorization_id: Hex | null }>();
    telegramCheck(row, "telegram_lesson_not_found", 404);
    telegramCheck(
      row.authorization_id,
      "telegram_saved_authorization_required",
      409,
    );
    const api = await authority(
      actor,
      grant,
      row.started_at,
      bytes32(row.authorization_id),
    );
    await channel(actor, grant, { lessonId: id } as StudyLesson);
    await scrubLinkedGrades(options.db, id, grant.accountId, actor.communityId);
    return api;
  }
  return {
    async start(actor, grant, song, requestId) {
      const expectedFacts = telegramStudyFacts({
        schema: "pirate.study.telegram-publication-fence/1",
        version: 1,
        grantId: grant.id,
        actor,
        accountId: grant.accountId,
        authorityVersion: grant.authorityVersion,
      });
      // An exact retry must keep the original time and authorization even
      // if the operator accepted its binding before the response was lost.
      const original = await options.db
        .prepare(
          `SELECT lesson_id,started_at,json_extract(state_json,'$.telegram.authorizationId') AS authorization_id FROM study_lessons WHERE account_id=?
          AND community_id=? AND request_id=? AND history_deleted_at IS NULL`,
        )
        .bind(grant.accountId, actor.communityId, requestId)
        .first<{
          lesson_id: string;
          started_at: number;
          authorization_id: Hex | null;
        }>();
      if (original)
        telegramCheck(
          original.authorization_id,
          "telegram_saved_authorization_required",
          409,
        );
      const previous = original
        ? null
        : await options.db
            .prepare(
              `SELECT l.lesson_id FROM study_lessons l JOIN study_publications p ON p.lesson_id=l.lesson_id
        AND p.account_id=l.account_id AND p.community_id=l.community_id WHERE l.account_id=? AND l.community_id=? AND l.song_json=?
        AND l.started_at>=? AND l.history_deleted_at IS NULL AND json_extract(l.state_json,'$.status')='active'
        AND json_extract(p.binding_json,'$.offer.speechChannel')='telegram-linked'
        AND json_extract(p.binding_json,'$.offer.telegramFence.hash')=?
        ORDER BY l.started_at DESC LIMIT 1`,
            )
            .bind(
              grant.accountId,
              actor.communityId,
              JSON.stringify(song.song),
              grant.linkedAt,
              digest(expectedFacts),
            )
            .first<{ lesson_id: string }>();
      if (previous)
        return (await existing(actor, grant, previous.lesson_id)).get(
          previous.lesson_id,
        );
      const api = await authority(
        actor,
        grant,
        original?.started_at ?? options.grants.now(),
        original?.authorization_id
          ? bytes32(original.authorization_id)
          : undefined,
      );
      const lesson = await api.start(requestId, song.song);
      await channel(actor, grant, lesson);
      await authority(
        actor,
        grant,
        lesson.startedAt,
        await savedAuthorization(actor, grant, lesson.lessonId),
      );
      return lesson;
    },
    async get(actor, grant, id) {
      const api = await existing(actor, grant, id),
        lesson = await api.get(id);
      await authority(
        actor,
        grant,
        lesson.startedAt,
        await savedAuthorization(actor, grant, lesson.lessonId),
      );
      await channel(actor, grant, lesson);
      return lesson;
    },
    async answer(actor, grant, id, expected, request) {
      const api = await existing(actor, grant, id),
        lesson = await api.get(id);
      await authority(
        actor,
        grant,
        lesson.startedAt,
        await savedAuthorization(actor, grant, lesson.lessonId),
      );
      await channel(actor, grant, lesson);
      telegramCheck(
        expected && linkedLessonView(lesson, "").prompt?.key === expected.key,
        "telegram_prompt_changed",
        409,
      );
      const opened = await api.open(id, expected.presentation, expected.take);
      await authority(
        actor,
        grant,
        lesson.startedAt,
        await savedAuthorization(actor, grant, lesson.lessonId),
      );
      const result = await api.submit(id, opened.attempt.attemptId, request);
      await authority(
        actor,
        grant,
        lesson.startedAt,
        await savedAuthorization(actor, grant, lesson.lessonId),
      );
      return result;
    },
    async recover(actor, grant, id, expected, audioDigest) {
      const api = await existing(actor, grant, id),
        lesson = await api.get(id);
      await authority(
        actor,
        grant,
        lesson.startedAt,
        await savedAuthorization(actor, grant, lesson.lessonId),
      );
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
