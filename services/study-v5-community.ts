import { Effect } from "effect";
import type { Address, Hex } from "viem";
import { canonical, digest } from "../packages/protocol/index.ts";
import { studyCheck, type StudyPrincipal } from "../packages/study/contracts.ts";
import { newLesson, studySong, type LessonState } from "../packages/study/lesson.ts";
import { StudyLessonStore } from "../packages/study/lesson-store.ts";
import { selectStudyLessonLines } from "../packages/study/line-selection.ts";
import { studyGraderAt, type StudyGraderActivation } from "../packages/study/grader-revision.ts";
import { studySourceLines, studySourceSelection } from "../packages/study/public-source.ts";
import { validatePrivateV5Offer, type StudyPrivateV5Offer } from "../packages/study/private-v5.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import type { DancePrivateRequestSession } from "./dance-private-session.ts";
import type { StudyCommunityPorts } from "./study-community.ts";
import { privateStudyV5Profile } from "./study-v5-profile.ts";
import { publicSongs, publicLyricManifest } from "./community-public.ts";
import { makeStudyService } from "./study-spoken.ts";
import { makeStudyLessonService } from "./study-lessons.ts";
import { bindManagedPrivateStudyV5, managedPrivateStudyV5Transcriber, type StudyOperatorPorts } from "./study-operator-client.ts";

/** Constructed by the real HTTP/session adapter, never from browser JSON. */
export interface StudyV5Request {
  session: DancePrivateRequestSession;
  check(): Promise<void>;
  accept(fence: DanceFence): void;
}
export function livePrivateStudyV5(ports: StudyCommunityPorts, session: { account_id: string; wallet: string }, request: StudyV5Request) {
  const profile = privateStudyV5Profile(ports.env, ports.config.communityId);
  const now = ports.now ?? Date.now, store = new StudyLessonStore(ports.db);
  const owner: StudyPrincipal = { accountId: session.account_id, communityId: ports.config.communityId };
  studyCheck(request.session.actor.accountId === owner.accountId && request.session.actor.wallet === session.wallet.toLowerCase(), "study_account_changed", 409);
  const operator: StudyOperatorPorts = {
    binding: ports.env.KARAOKE_OPERATOR!, issuerKey: ports.env.KARAOKE_SIGNER_PRIVATE_KEY as Hex, now,
    authority: { chainId: profile.chainId, communityId: profile.communityId,
      contract: profile.contract, operator: ports.env.KARAOKE_OPERATOR_ADDRESS as Address },
  };
  async function check() {
    await request.check();
    studyCheck(canonical(privateStudyV5Profile(ports.env, owner.communityId)) === canonical(profile), "study_private_v5_runtime_changed", 409);
  }
  async function source(postId: Hex) {
    const records = await publicSongs(ports.db, ports.config, ports.reads, postId); await check();
    studyCheck(records.length === 1, "public_song_not_found", 404);
    const record = records[0];
    const indexed = await ports.db.prepare(`SELECT rowid,revision,manifest_json,manifest_sha256,block_hash,transaction_hash
      FROM public_post_revisions WHERE community_id=? AND post_id=? ORDER BY revision DESC LIMIT 1`)
      .bind(owner.communityId, postId).first<{ rowid: number; revision: number; manifest_json: string; manifest_sha256: string; block_hash: string; transaction_hash: string }>();
    await check();
    studyCheck(indexed && indexed.transaction_hash === record.transactionHash &&
      canonical(JSON.parse(indexed.manifest_json)) === canonical(record.post), "study_source_changed", 409);
    // The exact indexed incarnation must still hold in the lesson's accepting
    // D1 transaction; a content change between network reads cannot be adopted.
    request.accept({ sql: `EXISTS(SELECT 1 FROM public_post_revisions p WHERE p.rowid=? AND p.community_id=? AND p.post_id=?
      AND p.revision=? AND p.manifest_json=? AND p.manifest_sha256=? AND p.block_hash=? AND p.transaction_hash=?
      AND p.revision=(SELECT MAX(r.revision) FROM public_post_revisions r WHERE r.community_id=p.community_id AND r.post_id=p.post_id))`,
      values: [indexed.rowid, owner.communityId, postId, indexed.revision, indexed.manifest_json, indexed.manifest_sha256, indexed.block_hash, indexed.transaction_hash] });
    const lyrics = await publicLyricManifest(record.post, ports.reads.transport, ports.reads.contentCache); await check();
    studyCheck(lyrics, "karaoke_lyrics_unavailable", 404);
    studyCheck(lyrics.communityId === owner.communityId && lyrics.chainId === ports.config.chainId &&
      lyrics.postsContract === ports.config.postsContract, "study_wrong_community", 403);
    return lyrics;
  }
  function entry(state: LessonState) {
    studyCheck(state.privateV5?.schema === "pirate.study-private-entry/5" && state.privateV5.version === 5 &&
      canonical(state.privateV5.publication) === canonical({ kind: "private" }) && state.privateV5.profileHash === digest(profile) &&
      state.telegram === undefined, "study_private_v5_entry_changed", 409);
    return state.privateV5;
  }
  async function original(id: string) {
    const row = await store.row(owner, id), state = store.state(row); await check(); entry(state); return { row, state };
  }
  async function bound(id: string) {
    const { state } = await original(id), saved = entry(state), source = saved.source;
    const ordinals = state.items.map(item => source.lines.findIndex(line => line.lineId === item.line.lineId) + 1);
    const selected = studySourceSelection(source, ordinals);
    studyCheck(canonical(selected.selected) === canonical(state.items.map(item => item.line)), "study_source_changed", 409);
    const offer: StudyPrivateV5Offer = {
      schema: "pirate.study-private-offer/5", version: 5, publication: { kind: "private" }, profileHash: saved.profileHash,
      lessonId: id, accountId: owner.accountId, learner: request.session.actor.wallet,
      source, sourceDigest: selected.hash as Hex, startedAt: state.startedAt, expiresAt: state.expiresAt,
      graderRevision: state.graderRevision ?? "script_aware_token_phonetic_v4",
      exercises: selected.selected.map((line, i) => ({ ordinal: ordinals[i], lineId: line.lineId as Hex, language: line.language })),
    };
    validatePrivateV5Offer(offer, profile, Math.floor(now() / 1000));
    const binding = await bindManagedPrivateStudyV5(operator, offer, check); await check();
    return { binding, source };
  }
  const attempts = makeStudyService({ db: ports.db, now,
    resolveLine: async (selected, lesson) => {
      studyCheck(lesson, "study_lesson_not_bound", 409);
      const { state } = await original(lesson.lessonId);
      const line = studySourceLines(entry(state).source).lines.find(item => item.line.lineId === selected.lineId)?.line;
      studyCheck(line, "study_line_unavailable", 404); return line;
    },
    transcriber: { providerRetention: "stored",
      async transcribe(audio, contentType, language, context) {
        studyCheck(context, "study_lesson_not_bound", 409);
        const saved = await bound(context.lessonId);
        return managedPrivateStudyV5Transcriber(operator, saved.binding, check).transcribe(audio, contentType, language, context);
      },
      async recover(context, audioDigest) {
        const saved = await bound(context.lessonId);
        return managedPrivateStudyV5Transcriber(operator, saved.binding, check).recover!(context, audioDigest);
      },
    },
  });
  const lessons = makeStudyLessonService({ db: ports.db, attempts, now,
    consentExpiry: async () => Infinity,
    // New starts below use the real selector/store directly to persist the
    // private choice in the first transaction, before any operator request.
    resolveLines: async song => studySourceLines(await source(song.postId as Hex)).lines.map(item => item.line),
  });
  async function get(id: string) { await original(id); const result = await lessons.get(owner, id); await check(); return result; }
  async function publication(id: string) { await original(id); return { state: "private" as const, receipt: null }; }
  return {
    owner, lessons, publication,
    syncPublication: async (id: string, _force = false) => { await original(id); return null; },
    recoverSavedLesson: get, get,
    // Withdrawing public permission cannot upgrade or destroy private work.
    endForWithdrawal: async (_through = Number.MAX_SAFE_INTEGER) => [],
    async song(postId: Hex) {
      const lyrics = await source(postId);
      studyCheck(studySourceLines(lyrics).lines.length >= 4, "insufficient_study_lines", 409);
      return studySong({ chainId: lyrics.chainId, postsContract: lyrics.postsContract,
        communityId: lyrics.communityId, postId: lyrics.postId, lyricRevision: lyrics.revision });
    },
    async start(requestId: string, input: unknown) {
      const song = studySong(input);
      studyCheck(/^[a-zA-Z0-9_-]{16,128}$/.test(requestId), "invalid_study_request_id");
      studyCheck(song.communityId === owner.communityId && song.chainId === ports.config.chainId &&
        song.postsContract === ports.config.postsContract, "study_wrong_community", 403);
      let row = await store.byRequest(owner, requestId); await check();
      if (row) {
        studyCheck(row.song_json === JSON.stringify(song), "study_request_conflict", 409); entry(store.state(row));
      } else {
        const lyrics = await source(song.postId as Hex);
        studyCheck(lyrics.revision === song.lyricRevision, "study_source_changed", 409);
        const history = await store.practice(owner, song); await check();
        const startedAt = now(), activation = ports.env.STUDY_GRADER_ACTIVATION
          ? JSON.parse(ports.env.STUDY_GRADER_ACTIVATION) as StudyGraderActivation : undefined;
        const initial = newLesson(song, selectStudyLessonLines(song, studySourceLines(lyrics).lines.map(item => item.line), history),
          startedAt, studyGraderAt(startedAt, activation));
        row = await store.create(owner, requestId, { ...initial, privateV5: {
          schema: "pirate.study-private-entry/5", version: 5, publication: { kind: "private" }, profileHash: digest(profile) as Hex, source: lyrics,
        } }); await check(); entry(store.state(row));
      }
      await bound(row.lesson_id); return get(row.lesson_id);
    },
    async latest(input: unknown) {
      const row = await store.latest(owner, studySong(input)); await check();
      if (!row) return null; entry(store.state(row)); return get(row.lesson_id);
    },
    async abandon(id: string) { await original(id); const result = await lessons.abandon(owner, id); await check(); return result; },
    async open(id: string, presentation: number, take: number) {
      await bound(id); const result = await lessons.openAttempt(owner, id, presentation, take); await check(); return result;
    },
    async submit(id: string, attemptId: string, audio: Request) {
      await original(id);
      const result = await Effect.runPromise(Effect.match(lessons.submit(owner, id, attemptId, audio), {
        onSuccess: value => ({ ok: true as const, value }), onFailure: error => ({ ok: false as const, error }),
      }));
      await check(); if (!result.ok) throw result.error; return result.value;
    },
  };
}
