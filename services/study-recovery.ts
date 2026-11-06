import { studyCheck } from "../packages/study/contracts.ts";
import {
  liveStudy,
  studyAvailable,
  type StudyCommunityPorts,
} from "./study-community.ts";
import { makeStudyService } from "./study-spoken.ts";
import { makeStudyLessonService } from "./study-lessons.ts";

/** Bounded, account-scoped recovery, independent of browser or session cookies. */
export async function recoverStudyLessons(
  ports: StudyCommunityPorts,
  limit = 20,
) {
  if (!studyAvailable(ports.env, ports.config)) return 0;
  studyCheck(
    Number.isInteger(limit) && limit > 0 && limit <= 100,
    "invalid_study_scan_limit",
  );
  const now = ports.now ?? Date.now;
  const rows = await ports.db
    .prepare(
      `
    SELECT l.lesson_id,l.account_id,l.community_id,p.learner
    FROM study_lessons l LEFT JOIN study_publications p ON p.lesson_id=l.lesson_id
    WHERE l.community_id=? AND (
      (json_extract(l.state_json,'$.status')='active' AND json_extract(l.state_json,'$.expiresAt')<=?) OR
      (json_extract(l.state_json,'$.status')!='active' AND
        (p.state IN ('bound','pending') OR (p.state='published' AND
          (json_extract(p.receipt_json,'$.confirmed')=0 OR p.updated_at<=?)))))
    ORDER BY COALESCE(p.updated_at,l.started_at),l.lesson_id LIMIT ?
  `,
    )
    .bind(ports.config.communityId, now(), now() - 3600000, limit)
    .all<{
      lesson_id: string;
      account_id: string;
      community_id: string;
      learner: string | null;
    }>();
  for (const row of rows.results) {
    try {
      if (row.learner) {
        await liveStudy(ports, {
          account_id: row.account_id,
          wallet: row.learner,
        }).get(row.lesson_id);
      } else {
        // A draft whose grant binding never completed cannot have paid speech.
        // Close it privately; do not invent a learner or acquire a new grant.
        const unavailable = async (): Promise<never> => {
          throw Error("study_lesson_not_bound");
        };
        const attempts = makeStudyService({
          db: ports.db,
          now,
          resolveLine: unavailable,
          transcriber: { providerRetention: "stored", transcribe: unavailable },
        });
        await makeStudyLessonService({
          db: ports.db,
          now,
          attempts,
          resolveLines: unavailable,
        }).get(
          { accountId: row.account_id, communityId: row.community_id },
          row.lesson_id,
        );
      }
    } catch {
      // Persist fairness even when a single binding or RPC remains unavailable.
      await ports.db
        .prepare(
          "UPDATE study_publications SET updated_at=? WHERE lesson_id=? AND account_id=? AND community_id=?",
        )
        .bind(now(), row.lesson_id, row.account_id, row.community_id)
        .run();
    }
  }
  return rows.results.length;
}
