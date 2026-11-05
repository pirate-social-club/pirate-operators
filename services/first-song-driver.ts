import type { PrivateKeyAccount } from "viem/accounts";
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
export function firstSongDriver(
  ports: FirstSongDriverPorts,
): PublicationDriver {
  const load = async (operation: ExternalOperation) => {
    const input = await publicationInput(
      ports.db,
      ports.media,
      operation.job_id,
      ports.managed.configuration,
    );
    insist(
      operation.request_hash ===
        hashJson(
          requestValue(
            input,
            operation.step,
            ports.release.grantHash,
            ports.managed.origin,
          ),
        ) &&
        canonical(JSON.parse(operation.request_json)) ===
          canonical(
            requestValue(
              input,
              operation.step,
              ports.release.grantHash,
              ports.managed.origin,
            ),
          ),
      "publication_operation_input_changed",
      503,
    );
    return input;
  };
  const validateMedia = async (input: PublicationInput) => {
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
      return requestValue(
        input,
        step,
        ports.release.grantHash,
        ports.managed.origin,
      );
    },
    async prepare(operation) {
      const input = await load(operation);
      await ports.checkServices();
      if (operation.step === "publication") {
        await validateMedia(input);
        return preparePosting(operation, ports.posting);
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
        payload: { grantHash: ports.release.grantHash },
      };
    },
    async execute(operation) {
      const input = await load(operation);
      await ports.checkServices();
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
        return executePosting(operation, ports.posting);
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
    async reconcile(operation) {
      const input = await load(operation);
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
    async validate(operation, result) {
      const input = await load(operation);
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
