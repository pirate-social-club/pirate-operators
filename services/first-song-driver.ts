import { requireAuthorizedOwner, requireOwnerIdentity } from "../packages/community/owner-authorization.ts";
import type { OwnerVerification } from "../packages/community/owner-authorization-verifier.ts";
import { catalogOwner } from "../packages/community/owner-policy.ts";
import { catalogPublication, type CatalogPublicationPorts } from "../packages/community/catalog-publication.ts";
import { requireExecutionProfile } from "../packages/community/publication-profile.ts";
import { requireStems } from "../packages/community/stems.ts";
import {
  canonical,
  hashJson,
  insist,
  object,
} from "../packages/community/common.ts";
import {
  publicationInput,
  type PublicationInput,
} from "../packages/community/publication-input.ts";
import type { ManagedClient } from "../packages/community/managed-client.ts";
import {
  executeAdmission,
  reconcileAdmission,
  validateAdmissionResult,
  resumeAdmissionProcessing,
} from "../packages/community/publication-admission.ts";
import {
  releasePin,
  releaseRegistration,
  validateReleaseResult,
  type ReleasePorts,
} from "../packages/community/publication-release.ts";
import {
  preparePosting,
  executePosting,
  reconcilePosting,
  validatePosting,
  type PostingPorts,
} from "../packages/community/publication-posting.ts";
import type {
  ExternalOperation,
  PublicationJob,
  PublicationStep,
} from "../packages/community/publication-store.ts";
import { activeAdmissionOperation } from "../packages/community/publication-store.ts";
import { preparedOperation } from "../packages/community/publication.ts";
import { ownerBudgetKey } from "../packages/release/owner-grant.ts";
import type {
  PublicationDriver,
  OperationResult,
  Reconciliation,
} from "../packages/community/publication.ts";

export interface FirstSongDriverPorts {
  db: D1Database;
  media: R2Bucket;
  managed: ManagedClient;
  release: ReleasePorts;
  posting: PostingPorts;
  acrEndpoint: string;
  checkServices(): Promise<void>;
  /** Controller-signed owner authorization; required under the unregistered owner policy. */
  ownerAuthorization?: unknown;
  ownerVerification?: OwnerVerification;
  catalog?: CatalogPublicationPorts;
  clock?: import("../packages/community/publication.ts").PublicationClock;
}
const roleFor = (step: PublicationStep) =>
  step === "pin_audio"
    ? "audio"
    : step === "pin_lyrics"
      ? "lyrics"
      : "post_manifest";
function requestValue(
  input: PublicationInput,
  step: PublicationStep,
  grantHash: string,
  serviceOrigin: string,
) {
  const base = {
    schema: "pirate.first-song-publication-request/1",
    grantHash,
    serviceOrigin,
    step,
    inputHash: input.job.input_hash,
    context: input.context,
  };
  if (step !== "publication") return base;
  const pin = object(object(input.progress.pin_manifest).pin);
  return {
    ...base,
    publication: {
      communityId: input.context.lyrics.communityId,
      postId: input.context.postId,
      authorId: input.context.authorId,
      configurationRevision: input.authority.configurationRevision,
      manifestSha256: pin.sha256,
      manifestURI: pin.uri,
    },
  };
}
function confirmed(result: Reconciliation): OperationResult {
  insist(
    result.kind !== "absent" && result.kind !== "unknown",
    "release_result_pending",
    503,
  );
  return result;
}
function pinResult(value: unknown): OperationResult {
  const v = object(value),
    pin = object(v.pin);
  return { kind: "confirmed", providerId: String(pin.uri), value: v };
}
/** Owner jobs bind the owner scope and window so a replacement grant replays. */
const releaseBinding = (ports: FirstSongDriverPorts) => {
  const grant = ports.release.ownerGrant;
  if (!grant) return ports.release.grantHash;
  const key = ownerBudgetKey(grant, "songs");
  return hashJson({ ownerScope: key.scope, ownerWindow: key.period });
};
export function firstSongDriver(
  ports: FirstSongDriverPorts,
): PublicationDriver {
  async function authorizeOwner() {
    if (!ports.release.ownerGrant) return;
    return requireAuthorizedOwner(ports.ownerAuthorization, ports.managed.configuration,
      ports.release.ownerGrant.ownerWallet, undefined, ports.ownerVerification);
  }
  const load = async (operation: ExternalOperation) => {
    const input = await publicationInput(
      ports.db,
      ports.media,
      operation.job_id,
      ports.managed.configuration,
    );
    requireExecutionProfile(input.authority, ports);
    if (operation.step !== "admission")
      await requireStems(ports.db, ports.media, input.row.submission_id);
    insist(
      operation.request_hash ===
        hashJson(
          requestValue(
            input,
            operation.step,
            releaseBinding(ports),
            ports.managed.origin,
          ),
        ) &&
        canonical(JSON.parse(operation.request_json)) ===
          canonical(
            requestValue(
              input,
              operation.step,
              releaseBinding(ports),
              ports.managed.origin,
            ),
          ),
      "publication_operation_input_changed",
      503,
    );
    return input;
  };
  const validateMedia = async (input: PublicationInput) => {
    // Owner jobs have no registration step or receipt to replay.
    if (!ports.release.ownerGrant) {
      const registration = object(input.progress.registration),
        receipt = object(registration.receipt);
      await validateReleaseResult(input, ports.release, "registration", {
        kind: "confirmed",
        providerId: String(receipt.transactionHash),
        value: registration,
      });
    }
    for (const step of ["pin_audio", "pin_lyrics", "pin_manifest"] as const)
      await validateReleaseResult(
        input,
        ports.release,
        step,
        pinResult(input.progress[step]),
      );
  };
  return {
    async request(job: PublicationJob, step: PublicationStep) {
      const input = await publicationInput(
        ports.db,
        ports.media,
        job.job_id,
        ports.managed.configuration,
      );
      requireExecutionProfile(input.authority, ports);
      if (step !== "admission")
        await requireStems(ports.db, ports.media, input.row.submission_id);
      if(ports.release.ownerGrant) {
        const original=await requireOwnerIdentity(ports.ownerAuthorization,ports.managed.configuration,ports.release.ownerGrant.ownerWallet,ports.ownerVerification);
        insist(Math.floor(input.createdAt/1000)>=original.validFrom&&Math.floor(input.createdAt/1000)<original.expiresAt,"publication_original_owner_window_changed",403);
      }
      return requestValue(
        input,
        step,
        releaseBinding(ports),
        ports.managed.origin,
      );
    },
    async prepare(operation,job) {
      const input = await load(operation);
      await ports.checkServices();
      await authorizeOwner();
      if (operation.step === "catalog_reserve" || operation.step === "catalog_confirm") {
        insist(ports.catalog, "recognition_runtime_unconfigured",503);
        return {replay:{kind:"provider_idempotency",provider:"pirate-recognition-reservation/1",key:operation.operation_id},payload:{intentHash:input.job.input_hash}};
      }
      if (operation.step === "publication") {
        await validateMedia(input);
        await authorizeOwner();
        return preparePosting(operation, ports.posting, job);
      }
      return {
        replay: {
          kind: "provider_idempotency",
          provider:
            operation.step === "admission"
              ? "pirate-managed-admission/1"
              : "pirate-managed-release/1",
          key: operation.operation_id,
        },
        payload: { grantHash: releaseBinding(ports) },
      };
    },
    async execute(operation,job) {
      const input = await load(operation);
      await ports.checkServices();
      await authorizeOwner();
      if (operation.step === "catalog_reserve" || operation.step === "catalog_confirm") {
        insist(ports.catalog,"recognition_runtime_unconfigured",503);
        const c=await catalogPublication(ports.catalog,operation,job?.lease_token);
        return confirmed(await (operation.step === "catalog_reserve" ? c.reserve("execute") : c.commit("execute")));
      }
      if (operation.step === "admission")
        return executeAdmission(
          ports.db,
          input,
          ports.managed,
          ports.acrEndpoint,
        );
      if (operation.step === "registration")
        return confirmed(
          await releaseRegistration(input, ports.release, "execute"),
        );
      if (operation.step === "publication") {
        await validateMedia(input);
        const owner=await authorizeOwner();
        const beforeBroadcast=async()=>{
          await ports.posting.beforeBroadcast?.(operation);
          if(!owner)return;
          insist(job?.lease_token,"publication_lease_lost",409);
          const held=await ports.db.withSession("first-primary").prepare(`SELECT e.request_hash,e.prepared_json FROM external_operations e
            JOIN publication_jobs j ON j.job_id=e.job_id WHERE e.operation_id=? AND e.job_id=? AND j.phase='publication'
            AND j.lease_token=? AND j.lease_until>? AND e.status IN ('running','uncertain')`)
            .bind(operation.operation_id,operation.job_id,job.lease_token,Date.now()).first<{request_hash:string;prepared_json:string|null}>();
          insist(held?.request_hash===operation.request_hash&&held.prepared_json===operation.prepared_json,"publication_lease_lost",409);
          const now=ports.ownerVerification?.now() ?? Math.floor(Date.now()/1000);
          insist(now>=owner.validFrom&&now<owner.expiresAt,"owner_authorization_outside_window",403);
        };
        if (catalogOwner(ports.managed.configuration.policies.admission)) {
          insist(ports.catalog,"recognition_runtime_unconfigured",503);
          return executePosting(operation,{...ports.posting,beforeBroadcast,catalogBeforeBroadcast:async()=>{await (await catalogPublication(ports.catalog!,operation,job?.lease_token)).bind(); await authorizeOwner();}},job);
        }
        await authorizeOwner();
        return executePosting(operation, {...ports.posting,beforeBroadcast,catalogBeforeBroadcast:async()=>{await authorizeOwner();}},job);
      }
      return confirmed(
        await releasePin(
          input,
          ports.release,
          roleFor(operation.step),
          "execute",
        ),
      );
    },
    async reconcile(operation,job) {
      const input = await load(operation);
      if (operation.step === "catalog_reserve" || operation.step === "catalog_confirm") {
        insist(ports.catalog,"recognition_runtime_unconfigured",503);
        const c=await catalogPublication(ports.catalog,operation,job?.lease_token);
        return operation.step === "catalog_reserve" ? c.reserve("reconcile") : c.commit("reconcile");
      }
      if (operation.step === "admission")
        return reconcileAdmission(input, ports.managed, ports.acrEndpoint);
      if (operation.step === "registration")
        return releaseRegistration(input, ports.release, "reconcile");
      if (operation.step === "publication")
        return reconcilePosting(operation, ports.posting);
      return releasePin(
        input,
        ports.release,
        roleFor(operation.step),
        "reconcile",
      );
    },
    async validate(operation, result,job) {
      const input = await load(operation);
      if (operation.step === "catalog_reserve" || operation.step === "catalog_confirm") {
        insist(ports.catalog,"recognition_runtime_unconfigured",503);
        const c=await catalogPublication(ports.catalog,operation,job?.lease_token),fresh=await (operation.step === "catalog_reserve" ? c.reserve("reconcile") : c.commit("reconcile"));
        insist(canonical(fresh)===canonical(result),"catalog_receipt_changed",503);return;
      }
      if (operation.step === "admission")
        return validateAdmissionResult(
          input,
          ports.managed,
          ports.acrEndpoint,
          result,
        );
      if (operation.step === "publication")
        return validatePosting(operation, ports.posting, result);
      return validateReleaseResult(
        input,
        ports.release,
        operation.step,
        result,
      );
    },
  };
}

/** Used by the authenticated resume route and the owned cron/queue wakeup.
 * This continuation is distinct from the driver's read-only reconcile method. */
export async function resumeFirstSongAdmission(
  ports: FirstSongDriverPorts,
  jobId: string,
) {
  const input = await publicationInput(
    ports.db,
    ports.media,
    jobId,
    ports.managed.configuration,
  );
  requireExecutionProfile(input.authority, ports);
  if (
    input.job.phase !== "uncertain" ||
    input.progress.resumePhase !== "admission"
  )
    return false;
  const operation = await activeAdmissionOperation(ports.db, jobId);
  insist(
    operation &&
      (operation.status === "running" || operation.status === "uncertain") &&
      operation.request_hash ===
        hashJson(
          requestValue(
            input,
            "admission",
            releaseBinding(ports),
            ports.managed.origin,
          ),
        ),
    "admission_resume_intent_changed",
    409,
  );
  const preparation = preparedOperation(operation);
  insist(
    preparation.replay.kind === "provider_idempotency" &&
      preparation.replay.key === operation.operation_id,
    "admission_resume_not_idempotent",
    503,
  );
  // Observe the immutable original before asking for NEW processing authority.
  // A lost completed reply needs neither a new window nor provider dispatch.
  const observation=await reconcileAdmission(input,ports.managed,ports.acrEndpoint);
  if(observation.kind!=="unknown"&&observation.kind!=="absent")return false;
  if(ports.release.ownerGrant) {
    const owner=await requireOwnerIdentity(ports.ownerAuthorization,ports.managed.configuration,ports.release.ownerGrant.ownerWallet,ports.ownerVerification);
    const now=ports.ownerVerification?.now() ?? Math.floor(Date.now()/1000);
    if(now<owner.validFrom||now>=owner.expiresAt)return false;
  }
  await ports.checkServices();
  const proof = {
    schema: "pirate.admission-resume-intent/1",
    operationId: operation.operation_id,
    admissionId: input.context.admissionId,
    requestHash: operation.request_hash,
    serviceOrigin: ports.managed.origin,
  };
  await ports.db
    .prepare(
      "INSERT INTO external_operation_reconciliations(operation_id,proof_sha256,proof_json,observed_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(operation.operation_id, hashJson(proof), canonical(proof), Date.now())
    .run();
  if(ports.release.ownerGrant) await requireAuthorizedOwner(ports.ownerAuthorization,ports.managed.configuration,ports.release.ownerGrant.ownerWallet,undefined,ports.ownerVerification);
  return resumeAdmissionProcessing(
    ports.db,
    input,
    ports.managed,
    ports.acrEndpoint,
  );
}
