import { Effect } from "effect";
import type { Address, Hex } from "viem";
import { canonical, check, digest } from "../packages/protocol/index.ts";
import {
  studyCheck,
  type StudyPrincipal,
  type StudySelection,
} from "../packages/study/contracts.ts";
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
import type { StudyOperatorBinding } from "./study-operator.ts";
import { studyPublicationQueue } from "./study-publication-queue.ts";

export interface StudyEnv extends KaraokeEnv {
  STUDY_RESULTS_V3_CONTRACT?: string;
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
export function studyAvailable(env: StudyEnv, config: CommunityConfig) {
  return !!(
    env.STUDY_RESULTS_V3_CONTRACT &&
    env.KARAOKE_SERVICE_MODE === "internal" &&
    env.KARAOKE_OPERATOR &&
    env.KARAOKE_SIGNER_PRIVATE_KEY &&
    env.KARAOKE_OPERATOR_ADDRESS &&
    [31337, 6343].includes(Number(env.KARAOKE_PAYMENT_CHAIN_ID)) &&
    env.STUDY_RESULTS_V3_CONTRACT.toLowerCase() ===
      config.learningRecords.toLowerCase()
  );
}

export function liveStudy(
  ports: StudyCommunityPorts,
  session: { account_id: string; wallet: string },
) {
  studyCheck(studyAvailable(ports.env, ports.config), "study_unavailable", 503);
  const owner: StudyPrincipal = {
    accountId: session.account_id,
    communityId: ports.config.communityId,
  };
  const now = ports.now ?? Date.now,
    store = new StudyLessonStore(ports.db);
  const operator: StudyOperatorPorts = {
    binding: ports.env.KARAOKE_OPERATOR!,
    issuerKey: ports.env.KARAOKE_SIGNER_PRIVATE_KEY as Hex,
    now,
    authority: {
      chainId: Number(ports.env.KARAOKE_PAYMENT_CHAIN_ID) as 31337 | 6343,
      communityId: ports.config.communityId,
      operator: ports.env.KARAOKE_OPERATOR_ADDRESS as Address,
      contract: ports.env.STUDY_RESULTS_V3_CONTRACT as Address,
    },
  };
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
    await store.row(owner, id); // Never inspect another account's publication binding.
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
    const binding = JSON.parse(row.binding_json) as StudyOperatorBinding;
    studyCheck(
      binding.target.version === 3 &&
        binding.target.chainId === operator.authority.chainId &&
        binding.target.contract.toLowerCase() ===
          operator.authority.contract.toLowerCase(),
      "study_contract_changed",
      409,
    );
    return { binding, source: JSON.parse(row.source_json) as LyricManifest };
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
    const binding = await bindManagedStudy(operator, offer);
    check(
      binding.offerHash === digest(offer) &&
        canonical(binding.offer) === canonical(offer) &&
        binding.target.version === 3 &&
        binding.target.contract.toLowerCase() ===
          operator.authority.contract.toLowerCase(),
      "study_binding_changed",
    );
    await ports.db
      .prepare(
        `INSERT INTO study_publications(lesson_id,account_id,community_id,learner,source_json,binding_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(lesson_id) DO NOTHING`,
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
        return managedStudyTranscriber(operator, saved.binding).recover!(
          context,
          audioDigest,
        );
      },
      async transcribe(audio, contentType, language, context) {
        studyCheck(context, "study_lesson_not_bound", 409);
        const saved = await bound(context.lessonId);
        return managedStudyTranscriber(operator, saved.binding).transcribe(
          audio,
          contentType,
          language,
          context,
        );
      },
    },
  });
  const lessons = makeStudyLessonService({
    db: ports.db,
    attempts,
    now,
    resolveLines: async (song) =>
      studySourceLines(await source(song)).lines.map((entry) => entry.line),
  });
  const publications = studyPublicationQueue(ports.db, operator, owner, now);
  async function reconcilePublication(lesson: StudyLesson) {
    if (lesson.status !== "active")
      await publications.sync(lesson.lessonId).catch(() => undefined);
    return lesson; // Publication outages never hide a saved private result.
  }
  return {
    owner,
    lessons,
    publication: publications.get,
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
