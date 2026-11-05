import {
  accountSession,
  authenticatedWrite,
  type AuthContext,
} from "../packages/community/accounts.ts";
import { exact, insist, jsonBody, text } from "../packages/community/common.ts";
import {
  reserveSubmission,
  sealSubmission,
} from "../packages/community/submissions.ts";
import { uploadAudio } from "../packages/community/uploads.ts";
import {
  reserveStem,
  uploadStem,
  requireStems,
  submissionStems,
  stemView,
  type StemSlot,
} from "../packages/community/stems.ts";
import { publicationExecutionProfile } from "../packages/community/publication-profile.ts";
import { resumeUncertainJob } from "../packages/community/publication-store.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type {
  CommunityUploadView,
  CommunityJobView,
} from "../packages/community/application-api.ts";
import {
  resumeFirstSongAdmission,
  type FirstSongDriverPorts,
} from "./first-song-driver.ts";

import type { PublicationWakeQueue } from "./community-jobs.ts";
import { requireCuratedOwner } from "../packages/community/curated-amendment.ts";
import { ownerCurated } from "../packages/community/owner-policy.ts";

interface ReleaseApiEnv {
  DB: D1Database;
  MEDIA: R2Bucket;
  JOBS: PublicationWakeQueue;
}
export interface ReleaseRuntime {
  config: CommunityConfig;
  ports: FirstSongDriverPorts;
}
export async function communityReleaseApi(
  request: Request,
  env: ReleaseApiEnv,
  context: AuthContext,
  ready: () => Promise<ReleaseRuntime>,
  reply: (body: unknown, status?: number) => Response,
) {
  const url = new URL(request.url),
    upload = /^\/api\/uploads\/([a-f0-9-]{36})\/(audio|seal)$/.exec(
      url.pathname,
    ),
    stem =
      /^\/api\/uploads\/([a-f0-9-]{36})\/stems(?:\/(instrumental|vocals))?$/.exec(
        url.pathname,
      ),
    job = /^\/api\/jobs\/([^/]+)(\/resume)?$/.exec(url.pathname);
  if (url.pathname !== "/api/uploads" && !upload && !job && !stem) return null;
  insist(!url.search, "invalid_request", 400);
  const read = request.method === "GET",
    session = read
      ? await accountSession(request, env.DB, context)
      : await authenticatedWrite(request, env.DB, context);
  if (stem) {
    // Private attachments remain authorized by the original account ownership.
    // Publication-owner adoption is separately gated on both completed seals.
    const id = stem[1]!,
      slot = stem[2] as StemSlot | undefined;
    const owned = await env.DB.prepare(
      "SELECT submission_id FROM media_submissions WHERE submission_id=? AND account_id=?",
    )
      .bind(id, session.account_id)
      .first();
    insist(owned, "submission_not_found", 404);
    if (!slot) {
      insist(read, "method_not_allowed", 405);
      return reply({ stems: stemView(await submissionStems(env.DB, id)) });
    }
    if (request.method === "POST") {
      const row = await reserveStem(
        env.DB,
        session.account_id,
        id,
        slot,
        await jsonBody(request),
      );
      return reply({ stem: stemView([row])[0] }, 201);
    }
    insist(request.method === "PUT", "method_not_allowed", 405);
    return reply(
      await uploadStem(
        env.DB,
        env.MEDIA,
        session.account_id,
        id,
        slot,
        request,
      ),
    );
  }
  if (url.pathname === "/api/uploads" && read) {
    const rows = await env.DB.prepare(
      "SELECT s.submission_id,s.post_id,s.metadata_json,COALESCE(j.phase,s.upload_state) AS state,j.job_id FROM media_submissions s LEFT JOIN publication_jobs j ON j.submission_id=s.submission_id WHERE s.account_id=? ORDER BY s.created_at DESC,s.submission_id DESC LIMIT 20",
    )
      .bind(session.account_id)
      .all<{
        submission_id: string;
        post_id: string;
        metadata_json: string;
        state: string;
        job_id: string | null;
      }>();
    const uploads: CommunityUploadView[] = rows.results.map((r) => ({
      submissionId: r.submission_id,
      postId: r.post_id,
      title: JSON.parse(r.metadata_json).title,
      state: r.state,
      jobId: r.job_id,
    }));
    return reply({ uploads });
  }
  if (job) {
    const id = text(decodeURIComponent(job[1]!), 128);
    insist(/^[A-Za-z0-9:_-]+$/.test(id), "invalid_job_identity", 400);
    const owned = await env.DB.prepare(
      "SELECT j.job_id,j.submission_id,s.post_id,j.phase,j.error_code FROM publication_jobs j JOIN media_submissions s ON s.submission_id=j.submission_id WHERE j.job_id=? AND s.account_id=?",
    )
      .bind(id, session.account_id)
      .first<{
        job_id: string;
        submission_id: string;
        post_id: string;
        phase: string;
        error_code: string | null;
      }>();
    insist(owned, "publication_job_not_found", 404);
    if (job[2]) {
      insist(
        request.method === "POST" && owned.phase === "uncertain",
        "job_not_reconcilable",
        409,
      );
      exact(await jsonBody(request), []);
      const runtime = await ready();
      await requireCuratedOwner(env.DB, runtime.config, session.wallet);
      await resumeFirstSongAdmission(runtime.ports, id);
      await resumeUncertainJob(env.DB, id, session.account_id);
      await env.JOBS.send({ jobId: id });
      return reply({ resuming: true });
    }
    insist(read, "method_not_allowed", 405);
    const view: CommunityJobView = {
      schema: "pirate.publication-job-view/1",
      jobId: owned.job_id,
      submissionId: owned.submission_id,
      postId: owned.post_id,
      phase: owned.phase,
      errorCode: owned.error_code,
      resumable: owned.phase === "uncertain",
    };
    return reply(view);
  }
  if (upload?.[2] === "audio") {
    insist(request.method === "PUT", "method_not_allowed", 405);
    return reply(
      await uploadAudio(
        env.DB,
        env.MEDIA,
        session.account_id,
        upload[1]!,
        request,
      ),
    );
  }
  insist(request.method === "POST", "method_not_allowed", 405);
  const { config, ports } = await ready(),
    profile = {
      chainId: config.chainId,
      communityId: config.communityId,
      postsContract: config.postsContract,
      configurationRevision: config.configurationRevision,
      publisher: config.publisher,
      moderationSigner: config.policies.moderationSigner,
      execution: publicationExecutionProfile(ports),
    };
  await requireCuratedOwner(env.DB, config, session.wallet);
  if (url.pathname === "/api/uploads") {
    insist(
      !ownerCurated(config.policies.admission),
      "owner_release_already_submitted",
      409,
    );
    const row = await reserveSubmission(
      env.DB,
      session,
      profile,
      await jsonBody(request),
      request.headers.get("idempotency-key") ?? "",
    );
    return reply(
      {
        submissionId: row.submission_id,
        postId: row.post_id,
        state: row.upload_state,
      },
      201,
    );
  }
  insist(upload?.[2] === "seal", "not_found", 404);
  exact(await jsonBody(request), []);
  await requireStems(env.DB, env.MEDIA, upload[1]!);
  const sealed = await sealSubmission(
    env.DB,
    env.MEDIA,
    session,
    profile,
    upload[1]!,
  );
  await env.JOBS.send({ jobId: sealed.jobId });
  return reply(sealed, 202);
}
