import { Effect } from "effect";
import {
  firstSongDriver,
  resumeFirstSongAdmission,
  type FirstSongDriverPorts,
} from "./first-song-driver.ts";
import { publicationStep } from "../packages/community/publication.ts";
import {
  loadJob,
  resumeUncertainJob,
  isPublicationStep,
} from "../packages/community/publication-store.ts";
import { insist } from "../packages/community/common.ts";

export interface PublicationWakeQueue {
  send(
    message: { jobId: string },
    options?: QueueSendOptions,
  ): Promise<unknown>;
}
export async function runCommunityJob(
  ports: FirstSongDriverPorts,
  jobs: PublicationWakeQueue,
  id: string,
) {
  insist(/^[A-Za-z0-9:_-]{1,128}$/.test(id), "invalid_job_identity", 400);
  const saved = await loadJob(ports.db, id);
  if (saved.phase === "uncertain") {
    const owner = await ports.db
      .prepare("SELECT account_id FROM media_submissions WHERE submission_id=?")
      .bind(saved.submission_id)
      .first<{ account_id: string }>();
    insist(owner, "publication_owner_unavailable", 503);
    await resumeFirstSongAdmission(ports, id);
    await resumeUncertainJob(ports.db, id, owner.account_id);
  }
  const phase = await Effect.runPromise(
    publicationStep(ports.db, id, firstSongDriver(ports),ports.clock),
  );
  if (isPublicationStep(phase))
    await jobs.send({ jobId: id }, { delaySeconds: 15 });
  return phase;
}
export async function recoverCommunityJobs(
  db: D1Database,
  jobs: PublicationWakeQueue,
) {
  const rows = await db
    .prepare(
      "SELECT job_id FROM publication_jobs WHERE (phase IN ('admission','pin_audio','pin_lyrics','registration','pin_manifest','publication','catalog_reserve','catalog_confirm') AND lease_until<=? AND due_at<=?) OR phase='uncertain' ORDER BY updated_at LIMIT 10",
    )
    .bind(Date.now(), Date.now())
    .all<{ job_id: string }>();
  for (const row of rows.results) await jobs.send({ jobId: row.job_id });
}
