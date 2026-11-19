import { bytes32, canonical, exact, hashJson, insist, object } from "../packages/community/common.ts";
import type { Hex } from "viem";
import { readNativePostsJobId, readNativePostsPublicationReference } from "./native-posts-publication.ts";

export const protectedPostsPinRoles = { pin_audio: "audio", pin_lyrics: "lyrics", pin_manifest: "post_manifest" } as const;
type PinStep = keyof typeof protectedPostsPinRoles;
type Step = PinStep | "catalog_reserve" | "publication" | "catalog_confirm";
type AuxiliaryPurpose = "pin" | "pin_status" | "reserve" | "status" | "ready";
type PrimaryReference = {
  installationId: Hex; releaseSha256: Hex; jobId: string; operationId: Hex; requestHash: Hex; step: Step;
};

function readStepReference(value: unknown): PrimaryReference {
  const row = object(value);
  exact(row, ["installationId", "releaseSha256", "jobId", "operationId", "requestHash", "step"]);
  const jobId = readNativePostsJobId(row.jobId), operationId = bytes32(row.operationId);
  const step = row.step;
  insist(typeof step === "string" && (Object.hasOwn(protectedPostsPinRoles, step) ||
    step === "catalog_reserve" || step === "publication" || step === "catalog_confirm") &&
    operationId === hashJson({ job: jobId, step }), "protected_posts_primary_reference_changed");
  return { installationId: bytes32(row.installationId), releaseSha256: bytes32(row.releaseSha256),
    jobId, operationId, requestHash: bytes32(row.requestHash), step: step as Step };
}

export function readPostsAuxiliaryPrimaryRequest(body: Record<string, unknown>) {
  const { purpose, version } = body;
  insist(purpose === "pin" || purpose === "pin_status" || purpose === "reserve" || purpose === "status" || purpose === "ready",
    "protected_posts_primary_purpose_invalid");
  const active = purpose === "pin" || purpose === "reserve" || purpose === "ready";
  const pin = purpose === "pin" || purpose === "pin_status";
  exact(body, ["version", "purpose", "reference", ...(active ? ["initiatingLeaseSha256"] : [])]);
  const reference = readStepReference(body.reference);
  insist(version === (pin ? "pirate.protected-managed-http/1" : "pirate.native-posts-catalog-reservation-request/1") &&
    (pin ? Object.hasOwn(protectedPostsPinRoles, reference.step) :
      reference.step === (purpose === "ready" ? "publication" : "catalog_reserve")),
  "protected_posts_primary_reference_changed");
  return { purpose: purpose as AuxiliaryPurpose, reference,
    initiatingLeaseSha256: active ? bytes32(body.initiatingLeaseSha256) : undefined };
}

export function readPostsTerminalPrimaryRequest(body: Record<string, unknown>) {
  const active = Object.hasOwn(body, "initiatingLeaseSha256");
  exact(body, ["version", "publication", "confirmation", ...(active ? ["initiatingLeaseSha256"] : [])]);
  insist(body.version === "pirate.native-posts-catalog-request/1", "protected_posts_primary_purpose_invalid");
  const publication = readNativePostsPublicationReference(canonical(body.publication));
  const confirmation = object(body.confirmation);
  exact(confirmation, ["operationId", "requestHash"]);
  const reference = readStepReference({
    installationId: publication.installationId, releaseSha256: publication.releaseSha256,
    jobId: publication.jobId, operationId: confirmation.operationId, requestHash: confirmation.requestHash, step: "catalog_confirm",
  });
  return { reference, publication, initiatingLeaseSha256: active ? bytes32(body.initiatingLeaseSha256) : undefined };
}

export function readPostsCanonicalPrimaryRequest(body: Record<string, unknown>) {
  exact(body, ["version", "wire", ...(Object.hasOwn(body, "parent") ? ["parent"] : [])]);
  insist(body.version === "pirate.native-posts-canonical-primary-request/1", "protected_posts_primary_purpose_invalid");
  if (!Object.hasOwn(body, "parent")) return { wire: body.wire };
  const parent = object(body.parent);
  const active = Object.hasOwn(parent, "initiatingLeaseSha256");
  exact(parent, ["reference", ...(active ? ["initiatingLeaseSha256"] : [])]);
  return { wire: body.wire, parent: { reference: readStepReference(parent.reference),
    initiatingLeaseSha256: active ? bytes32(parent.initiatingLeaseSha256) : undefined } };
}
