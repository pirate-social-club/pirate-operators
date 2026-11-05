import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { privateKeyToAccount } from "viem/accounts";
import { firstSongJobFixture } from "./first-song-job.ts";
import { evaluator } from "./release-admission.ts";
import { hashJson, canonical } from "../../packages/community/common.ts";
import {
  OWNER_POLICY_VERSION,
  OWNER_POLICY_HASH,
} from "../../packages/community/owner-policy.ts";
import { validateConfig } from "../../packages/community/config-manifest.ts";
import { releaseGrantDigest } from "../../packages/release/grant.ts";
import { publicationExecutionProfile } from "../../packages/community/publication-profile.ts";
import { publicationStep } from "../../packages/community/publication.ts";
import {
  loadJob,
  resumeUncertainJob,
} from "../../packages/community/publication-store.ts";
import { firstSongDriver } from "../../services/first-song-driver.ts";
import {
  retainedRecognition,
  originalProviderCalls,
} from "../../packages/moderation/curated-admission.ts";
import {
  getAdmission,
  admissionId,
} from "../../packages/moderation/admission-store.ts";
import {
  curatedAdmissionId,
  type CuratedAmendment,
} from "../../packages/community/curated-amendment.ts";

// Public disposable fixture key, never a deployed controller or funded wallet.
export const curatedController = privateKeyToAccount(`0x${"55".repeat(32)}`);
export async function curatedSongFixture() {
  const f = await firstSongJobFixture({
    controller: curatedController.address.toLowerCase() as `0x${string}`,
  });
  try {
    const originalConfig = f.configuration,
      transport = f.managed.config.transport;
    f.managed.config.transport = {
      async request(request: Request) {
        if (new URL(request.url).pathname === "/v1/responses")
          return Response.json(
            {
              error: { type: "invalid_request_error", code: "model_not_found" },
            },
            { status: 403 },
          );
        return transport.request(request);
      },
    };
    await Effect.runPromise(
      publicationStep(f.community.db, f.sealed.jobId, firstSongDriver(f.ports)),
    );
    await f.managed.runQueued();
    await resumeUncertainJob(
      f.community.db,
      f.sealed.jobId,
      f.session.account_id,
    );
    await Effect.runPromise(
      publicationStep(f.community.db, f.sealed.jobId, firstSongDriver(f.ports)),
    );
    const originalJob = await loadJob(f.community.db, f.sealed.jobId),
      originalId = admissionId(originalConfig.communityId, f.sealed.jobId),
      originalAdmission = await getAdmission(f.managed.db, originalId),
      originalCalls = await originalProviderCalls(f.managed.db, originalId),
      originalOperation = (await f.community.db
        .prepare(
          "SELECT * FROM external_operations WHERE job_id=? AND step='admission'",
        )
        .bind(f.sealed.jobId)
        .first<Record<string, unknown>>())!;
    const sql = await readFile(
      "apps/managed-moderation/migrations/0003_owner_curated.sql",
      "utf8",
    );
    await f.managed.db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => f.managed.db.prepare(s)),
    );
    const recognition = await retainedRecognition(
        f.managed.db,
        originalId,
        evaluator,
      ),
      config = validateConfig(
        {
          ...originalConfig,
          configurationRevision: 2,
          policies: {
            ...originalConfig.policies,
            admission: {
              version: OWNER_POLICY_VERSION,
              sha256: OWNER_POLICY_HASH,
            },
          },
        },
        [originalConfig],
      ),
      grant = {
        ...f.managed.grant,
        configurationRevision: 2,
        pins: { ...f.managed.grant.pins },
        registration: { ...f.managed.grant.registration },
      };
    grant.sha256 = releaseGrantDigest(grant);
    grant.pins.sha256 = grant.sha256;
    grant.registration.sha256 = grant.sha256 as `0x${string}`;
    const client = { ...f.ports.managed, configuration: config },
      ports = {
        ...f.ports,
        managed: client,
        release: { ...f.ports.release, grantHash: grant.sha256, client },
        posting: {
          ...f.ports.posting,
          config,
          currentConfiguration: async () => config,
        },
      };
    const amendment: CuratedAmendment = {
      schema: "pirate.owner-curated-amendment/1",
      communityId: config.communityId,
      jobId: f.sealed.jobId,
      submissionId: f.row.submission_id,
      postId: f.row.post_id,
      authorId: f.row.author_id,
      ownerWallet: f.row.captured_wallet,
      recipient: f.managed.context.recipient,
      contentSha256: f.row.audio_sha256,
      originalInputHash: originalJob.input_hash,
      originalAuthorityHash: hashJson(JSON.parse(originalJob.authority_json)),
      originalRequestHash: f.row.request_hash,
      originalAdmissionId: originalId,
      originalAdmissionRequestHash: originalAdmission.request_hash,
      originalPreparedHash: hashJson(
        JSON.parse(originalAdmission.prepared_json!),
      ),
      originalCallsHash: hashJson(originalCalls),
      originalOperationId: String(originalOperation.operation_id),
      originalOperationReceiptHash: hashJson(
        JSON.parse(String(originalOperation.result_json)),
      ),
      originalGrantHash: f.managed.grant.sha256,
      originalConfiguration: originalConfig,
      configurationSha256: hashJson(config),
      execution: publicationExecutionProfile(ports),
      recognitionSha256: hashJson(recognition),
      rating: "general",
      language: "en",
      expiresAt: grant.expiresAt,
    };
    const signed = {
        amendment,
        signature: await curatedController.signMessage({
          message: { raw: hashJson(amendment) },
        }),
      },
      id = curatedAdmissionId(config.communityId, f.sealed.jobId),
      prepared = JSON.parse(originalAdmission.prepared_json!),
      result = {
        schema: "pirate.owner-admission/1",
        admissionId: id,
        amendmentSha256: hashJson(signed),
        automatedContent: "deferred",
        declarations: {
          source: "operator_declared",
          rating: amendment.rating,
          language: amendment.language,
        },
        evidence: [recognition],
        probe: prepared.probe,
        windows: prepared.windows.map(
          ({
            objectKey,
            byteLength,
            ...facts
          }: {
            objectKey: string;
            byteLength: number;
          }) => facts,
        ),
      };
    f.managed.config.currentConfiguration = async () => config;
    f.managed.service.currentConfiguration = async () => config;
    f.managed.service.grant = grant;
    return {
      ...f,
      config,
      grant,
      ports,
      signed,
      result,
      id,
      originalId,
      originalJob,
      originalAdmission,
      originalOperation,
      originalCalls,
    };
  } catch (e) {
    await f.dispose();
    throw e;
  }
}
