import { StudyLessonStore } from "../packages/study/lesson-store.ts";
import { studySong } from "../packages/study/lesson.ts";
import { studyCheck, type StudyPrincipal } from "../packages/study/contracts.ts";
import type { StudyCommunityPorts, LiveStudy } from "./study-community.ts";
import type { livePrivateStudyV5 } from "./study-v5-community.ts";

/** An explicit fresh selection never reinterprets an old persisted lesson.
 * Only its configured retained V3/V4 target may serve that original; new starts
 * stay private V5. ResultsTarget and legacy offer encodings remain unchanged. */
export function dispatchPrivateStudyV5(
  ports: StudyCommunityPorts,
  owner: StudyPrincipal,
  fresh: ReturnType<typeof livePrivateStudyV5>,
  legacy: (version: 3 | 4, contract: string) => LiveStudy,
): LiveStudy {
  const store = new StudyLessonStore(ports.db);
  async function selected(id: string) {
    const state = store.state(await store.row(owner, id));
    if (state.privateV5) return fresh;
    const row = await ports.db.prepare(`SELECT binding_json FROM study_publications WHERE lesson_id=? AND account_id=? AND community_id=?`)
      .bind(id, owner.accountId, owner.communityId).first<{ binding_json: string }>();
    studyCheck(row, "study_lesson_not_bound", 409);
    const target: unknown = JSON.parse(row.binding_json)?.target;
    studyCheck(target && typeof target === "object" && "version" in target && "contract" in target && "chainId" in target &&
      (target.version === 3 || target.version === 4), "study_contract_changed", 409);
    const configured = target.version === 4 ? ports.env.STUDY_RESULTS_V4_CONTRACT : ports.env.STUDY_RESULTS_V3_CONTRACT;
    studyCheck(configured && typeof target.contract === "string" && configured.toLowerCase() === target.contract.toLowerCase() &&
      target.chainId === Number(ports.env.KARAOKE_PAYMENT_CHAIN_ID), "study_contract_changed", 409);
    return legacy(target.version, configured);
  }
  return {
    ...fresh,
    async start(requestId: string, input: unknown) {
      const row = await store.byRequest(owner, requestId);
      if (row && !store.state(row).privateV5) return (await selected(row.lesson_id)).start(requestId, input);
      return fresh.start(requestId, input);
    },
    async latest(input: unknown) {
      const row = await store.latest(owner, studySong(input));
      return row ? (await selected(row.lesson_id)).get(row.lesson_id) : null;
    },
    get: async (id: string) => (await selected(id)).get(id),
    recoverSavedLesson: async (id: string) => (await selected(id)).recoverSavedLesson(id),
    abandon: async (id: string) => (await selected(id)).abandon(id),
    open: async (id: string, presentation: number, take: number) => (await selected(id)).open(id, presentation, take),
    submit: async (id: string, attempt: string, audio: Request) => (await selected(id)).submit(id, attempt, audio),
    publication: async (id: string) => (await selected(id)).publication(id),
    syncPublication: async (id: string, force = false) => (await selected(id)).syncPublication(id, force),
    async endForWithdrawal(through = Number.MAX_SAFE_INTEGER) {
      const row = await ports.db.prepare(`SELECT lesson_id FROM study_lessons WHERE account_id=? AND community_id=?
        AND history_deleted_at IS NULL AND json_extract(state_json,'$.privateV5') IS NULL
        AND json_extract(state_json,'$.status')='active' AND started_at<=? ORDER BY started_at,lesson_id LIMIT 1`)
        .bind(owner.accountId, owner.communityId, through).first<{ lesson_id: string }>();
      return row ? (await selected(row.lesson_id)).endForWithdrawal(through) : [];
    },
  };
}
