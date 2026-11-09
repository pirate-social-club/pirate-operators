import { Effect } from "effect";
import type { Address, Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import {
  StudyError,
  studyCheck,
  type StudyPrincipal,
  type StudySelection,
} from "../packages/study/contracts.ts";
import type {
  AnyStudyLessonOffer,
  StudyLessonOfferV4,
} from "../packages/study/operator-contract.ts";
import {
  studySong,
  type StudySong,
  type StudyLesson,
} from "../packages/study/lesson.ts";
import { StudyLessonStore } from "../packages/study/lesson-store.ts";
import {
  studySourceLines,
  studySourceSelection,
} from "../packages/study/public-source.ts";
import type { LyricManifest } from "../packages/community/lyric-manifest.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { PublicReadPorts } from "./community-public.ts";
import type { KaraokeEnv } from "./karaoke-community.ts";
import { publishedLyrics } from "./karaoke-song.ts";
import { makeStudyLessonService } from "./study-lessons.ts";
import { makeStudyService } from "./study-spoken.ts";
import {
  bindManagedStudy,
  managedStudyTranscriber,
  type StudyOperatorPorts,
} from "./study-operator-client.ts";
import type {
  StudyAuthorizationBinding,
  StudyBinding,
  StudyOperatorBinding,
} from "./study-operator.ts";
import type { ResultsTarget } from "./learning-contract.ts";
import { studyPublicationQueue } from "./study-publication-queue.ts";

export interface StudyEnv extends KaraokeEnv {
  STUDY_RESULTS_V3_CONTRACT?: string;
  /** The V4 results contract; must equal the directory's learningRecords. */
  STUDY_RESULTS_V4_CONTRACT?: string;
}
export interface StudyCommunityPorts {
  env: StudyEnv;
  db: D1Database;
  config: CommunityConfig;
  reads: PublicReadPorts;
  now?: () => number;
}
interface BoundRow {
  source_json: string;
  binding_json: string;
  learner: string;
}
/**
 * The results version new lessons use: V4 when its contract is configured
 * and is the directory's learning records, otherwise V3 under the same rule,
 * otherwise none.
 */
export function studyVersion(
  env: StudyEnv,
  config: CommunityConfig,
): 3 | 4 | null {
  const managed = !!(
    env.KARAOKE_SERVICE_MODE === "internal" &&
    env.KARAOKE_OPERATOR &&
    env.KARAOKE_SIGNER_PRIVATE_KEY &&
    env.KARAOKE_OPERATOR_ADDRESS &&
    [31337, 6343].includes(Number(env.KARAOKE_PAYMENT_CHAIN_ID))
  );
  const records = config.learningRecords.toLowerCase();
  if (managed && env.STUDY_RESULTS_V4_CONTRACT?.toLowerCase() === records)
    return 4;
  if (managed && env.STUDY_RESULTS_V3_CONTRACT?.toLowerCase() === records)
    return 3;
  return null;
}
export function studyAvailable(env: StudyEnv, config: CommunityConfig) {
  return studyVersion(env, config) !== null;
}

export function liveStudy(
  ports: StudyCommunityPorts,
  session: { account_id: string; wallet: string },
) {
  const version = studyVersion(ports.env, ports.config);
  studyCheck(version !== null, "study_unavailable", 503);
  const owner: StudyPrincipal = {
    accountId: session.account_id,
    communityId: ports.config.communityId,
  };
  const now = ports.now ?? Date.now,
    store = new StudyLessonStore(ports.db);
  const operatorPorts = (contract: string): StudyOperatorPorts => ({
    binding: ports.env.KARAOKE_OPERATOR!,
    issuerKey: ports.env.KARAOKE_SIGNER_PRIVATE_KEY as Hex,
    now,
    authority: {
      chainId: Number(ports.env.KARAOKE_PAYMENT_CHAIN_ID) as 31337 | 6343,
      communityId: ports.config.communityId,
      operator: ports.env.KARAOKE_OPERATOR_ADDRESS as Address,
      contract: contract as Address,
    },
  });
  // New lessons use the configured version's contract.
  const operator = operatorPorts(
    (version === 4
      ? ports.env.STUDY_RESULTS_V4_CONTRACT
      : ports.env.STUDY_RESULTS_V3_CONTRACT)!,
  );
  /**
   * A bound lesson is served under the contract it was bound to: a V3 lesson
   * keeps its V3 contract after V4 becomes the default for new lessons.
   */
  function operatorFor(target: ResultsTarget) {
    const contract =
      target.version === 4
        ? ports.env.STUDY_RESULTS_V4_CONTRACT
        : target.version === 3
          ? ports.env.STUDY_RESULTS_V3_CONTRACT
          : undefined;
    studyCheck(
      !!contract &&
        target.chainId === operator.authority.chainId &&
        target.contract.toLowerCase() === contract.toLowerCase(),
      "study_contract_changed",
      409,
    );
    return operatorPorts(contract!);
  }
  async function source(song: StudySong) {
    studyCheck(
      song.communityId === owner.communityId &&
        song.chainId === ports.config.chainId &&
        song.postsContract.toLowerCase() ===
          ports.config.postsContract.toLowerCase(),
      "study_wrong_community",
      403,
    );
    const lyrics = await publishedLyrics(
      ports.db,
      ports.config,
      ports.reads,
      song.postId as Hex,
    );
    studyCheck(
      lyrics.revision === song.lyricRevision,
      "study_source_changed",
      409,
    );
    return lyrics;
  }
  async function bound(id: string) {
    store.state(await store.row(owner, id)); // Owner and privacy tombstone precede binding reads.
    const row = await ports.db
      .prepare(
        "SELECT source_json,binding_json,learner FROM study_publications WHERE lesson_id=? AND account_id=? AND community_id=?",
      )
      .bind(id, owner.accountId, owner.communityId)
      .first<BoundRow>();
    studyCheck(
      row && row.learner.toLowerCase() === session.wallet.toLowerCase(),
      "study_lesson_not_bound",
      409,
    );
    const binding = JSON.parse(row.binding_json) as StudyBinding;
    return {
      binding,
      operator: operatorFor(binding.target),
      source: JSON.parse(row.source_json) as LyricManifest,
    };
  }
  /**
   * V4: the account's most recent recorded sign-in authorization issued at or
   * before `atMs`. A sign-in still being recorded is a retryable refusal.
   */
  async function authorizationAt(atMs: number) {
    const row = await ports.db
      .prepare(
        `SELECT
        (SELECT authorization_id FROM learning_authorizations
          WHERE account_id=?1 AND subject=?2 AND state='recorded' AND issued_at<=?3
          ORDER BY issued_at DESC,authorization_id DESC LIMIT 1) AS recorded,
        EXISTS(SELECT 1 FROM learning_authorizations WHERE account_id=?1 AND state='pending') AS pending`,
      )
      .bind(
        owner.accountId,
        session.wallet.toLowerCase(),
        Math.floor(atMs / 1000),
      )
      .first<{ recorded: string | null; pending: number }>();
    if (row?.recorded) return row.recorded as Hex;
    studyCheck(!row?.pending, "study_authorization_pending", 409);
    throw new StudyError("study_authorization_required", 409);
  }
  async function ensureBinding(lesson: StudyLesson) {
    const existing = await ports.db
      .prepare(
        "SELECT 1 AS present FROM study_publications WHERE lesson_id=? AND account_id=? AND community_id=?",
      )
      .bind(lesson.lessonId, owner.accountId, owner.communityId)
      .first();
    if (existing) return bound(lesson.lessonId);
    const state = store.state(await store.row(owner, lesson.lessonId)),
      lyrics = await source(state.song);
    const ordinals = state.items.map(
      (item) =>
        lyrics.lines.findIndex((line) => line.lineId === item.line.lineId) + 1,
    );
    const selected = studySourceSelection(lyrics, ordinals);
    studyCheck(
      canonical(state.items.map((item) => item.line)) ===
        canonical(selected.selected),
      "study_source_changed",
      409,
    );
    const offer = {
      lessonId: lesson.lessonId,
      learner: session.wallet as Address,
      sourceDigest: selected.hash as Hex,
      startedAt: state.startedAt,
      expiresAt: state.expiresAt,
      exercises: selected.selected.map((line, i) => ({
        ordinal: ordinals[i],
        lineId: line.lineId as Hex,
        language: line.language,
      })),
    };
    let binding: StudyBinding, offered: AnyStudyLessonOffer;
    if (version === 4) {
      // The lesson binds the sign-in in force when it started.
      const v4: StudyLessonOfferV4 = {
        ...offer,
        authorizationId: await authorizationAt(state.startedAt),
      };
      const accepted: StudyAuthorizationBinding = await bindManagedStudy(
        operator,
        v4,
      ).catch((error: unknown) => {
        // Permission withdrawn on chain: the same answer as no sign-in.
        if (
          error instanceof Error &&
          error.message === "study_authorization_required"
        )
          throw new StudyError("study_authorization_required", 409);
        throw error;
      });
      check(
        accepted.authorization?.id === v4.authorizationId,
        "study_binding_changed",
      );
      binding = accepted;
      offered = v4;
    } else {
      const accepted: StudyOperatorBinding = await bindManagedStudy(
        operator,
        offer,
      );
      binding = accepted;
      offered = offer;
    }
    check(
      binding.offerHash === digest(offered) &&
        canonical(binding.offer) === canonical(offered) &&
        binding.target.version === version &&
        binding.target.contract.toLowerCase() ===
          operator.authority.contract.toLowerCase(),
      "study_binding_changed",
    );
    await ports.db
      .prepare(
        `INSERT INTO study_publications(lesson_id,account_id,community_id,learner,source_json,binding_json,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,? FROM study_lessons WHERE lesson_id=? AND account_id=? AND community_id=? AND history_deleted_at IS NULL
      ON CONFLICT(lesson_id) DO NOTHING`,
      )
      .bind(
        lesson.lessonId,
        owner.accountId,
        owner.communityId,
        session.wallet.toLowerCase(),
        JSON.stringify(lyrics),
        JSON.stringify(binding),
        now(),
        now(),
        lesson.lessonId,
        owner.accountId,
        owner.communityId,
      )
      .run();
    const saved = await bound(lesson.lessonId);
    studyCheck(
      canonical(saved.binding) === canonical(binding) &&
        canonical(saved.source) === canonical(lyrics),
      "study_binding_changed",
      409,
    );
    return saved;
  }
  // Only this route-owned object can invoke the managed operator. It resolves
  // the context from the account's persisted lesson, never browser grading text.
  const attempts = makeStudyService({
    db: ports.db,
    now,
    resolveLine: async (selected: StudySelection, lesson) => {
      studyCheck(lesson, "study_lesson_not_bound", 409);
      const saved = await bound(lesson.lessonId);
      const lyrics = saved.source;
      const line = studySourceLines(lyrics).lines.find(
        (entry) => entry.line.lineId === selected.lineId,
      )?.line;
      studyCheck(line, "study_line_unavailable", 404);
      return line;
    },
    transcriber: {
      providerRetention: "stored",
      async recover(context, audioDigest) {
        const saved = await bound(context.lessonId);
        return managedStudyTranscriber(saved.operator, saved.binding).recover!(
          context,
          audioDigest,
        );
      },
      async transcribe(audio, contentType, language, context) {
        studyCheck(context, "study_lesson_not_bound", 409);
        const saved = await bound(context.lessonId);
        return managedStudyTranscriber(
          saved.operator,
          saved.binding,
        ).transcribe(audio, contentType, language, context);
      },
    },
  });
  const lessons = makeStudyLessonService({
    db: ports.db,
    attempts,
    now,
    consentExpiry: (owner, id) => store.consentExpiry(owner, id),
    resolveLines: async (song) =>
      studySourceLines(await source(song)).lines.map((entry) => entry.line),
  });
  const publications = studyPublicationQueue(ports.db, operatorFor, owner, now);
  async function reconcilePublication(lesson: StudyLesson) {
    if (lesson.status !== "active")
      await publications.sync(lesson.lessonId).catch(() => undefined);
    return lesson; // Publication outages never hide a saved private result.
  }
  return {
    owner,
    lessons,
    publication: publications.get,
    syncPublication: publications.sync,
    async song(postId: Hex) {
      const lyrics = await publishedLyrics(
        ports.db,
        ports.config,
        ports.reads,
        postId,
      );
      studyCheck(
        studySourceLines(lyrics).lines.length >= 4,
        "insufficient_study_lines",
        409,
      );
      return studySong({
        chainId: lyrics.chainId,
        postsContract: lyrics.postsContract,
        communityId: lyrics.communityId,
        postId: lyrics.postId,
        lyricRevision: lyrics.revision,
      });
    },
    async start(requestId: string, song: unknown) {
      // V4: refuse before creating a lesson while sign-in is being recorded,
      // so the client's retry starts the lesson once it is.
      if (version === 4) await authorizationAt(now());
      const lesson = await lessons.start(owner, requestId, song);
      await ensureBinding(lesson);
      return lesson;
    },
    get: async (id: string) =>
      reconcilePublication(await lessons.get(owner, id)),
    latest: async (song: unknown) => {
      const lesson = await lessons.latest(owner, song);
      return lesson ? reconcilePublication(lesson) : null;
    },
    abandon: async (id: string) =>
      reconcilePublication(await lessons.abandon(owner, id)),
    async open(id: string, presentation: number, take: number) {
      await ensureBinding(await lessons.get(owner, id));
      return lessons.openAttempt(owner, id, presentation, take);
    },
    async submit(id: string, attemptId: string, request: Request) {
      await bound(id);
      const result = await Effect.runPromise(
        Effect.match(lessons.submit(owner, id, attemptId, request), {
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
      );
      if (!result.ok) throw result.error;
      await reconcilePublication(result.value.lesson);
      return result.value;
    },
  };
}
