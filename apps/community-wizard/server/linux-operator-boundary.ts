import {requireRepresentable,RESULT_MAX_BYTES,INTENT_MAX_BYTES} from "./linux-journal-capacity.ts";
// Shape/context validation only. The real owner verifies actual sealed files,
// complete-profile admission, process custody, authority and receipt contents.
import {
  fields,
  reference,
  text,
  natural,
  requireLinux,
} from "../../../packages/community-setup/shared-linux-profile.ts";
import { canonical } from "./linux-journal.ts";
import type {
  BoundLinuxIntent,
  OriginalLinuxOperation as LinuxOperation,
  OriginalLinuxPlan as LinuxPlan,
  LinuxOperationResult,
  LinuxReconciliationRequest,
} from "./linux-contracts.ts";
export function sha256From(value: unknown): string {
  requireLinux(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "backend_digest",
    "Use the actual SHA-256 digest from the owning sealed manifest.",
  );
  return value;
}
export function evidenceFrom(value: unknown) {
  const r = fields(value, ["relativePath", "sha256"]),
    relativePath = text(r.relativePath, 512);
  requireLinux(
    !relativePath.startsWith("/") &&
      relativePath
        .split("/")
        .every((p) => p !== "." && p !== ".." && /^[A-Za-z0-9_.-]+$/.test(p)),
    "backend_evidence",
    "The backend must reference a retained restricted receipt inside its evidence store.",
  );
  return { relativePath, sha256: sha256From(r.sha256) };
}
function secretFrom(value: unknown) {
  const s = fields(value, ["storeId", "keyId", "generation"]);
  reference(s.storeId);
  reference(s.keyId);
  natural(s.generation);
}
function targetFrom(value: unknown) {
  const t = fields(value, [
    "endpointRef",
    "endpointIdentityDigest",
    "stateNamespace",
    "deploymentId",
  ]);
  return {
    endpointRef: reference(t.endpointRef),
    endpointIdentityDigest: sha256From(t.endpointIdentityDigest),
    stateNamespace: reference(t.stateNamespace),
    deploymentId: reference(t.deploymentId),
  };
}
function releaseFrom(value: unknown) {
  const r = fields(value, [
    "sourceHead",
    "sourceTree",
    "manifest",
    "selectedProfileDigest",
    "requiredServices",
  ]);
  requireLinux(
    typeof r.sourceHead === "string" &&
      /^[a-f0-9]{40}$/.test(r.sourceHead) &&
      typeof r.sourceTree === "string" &&
      /^[a-f0-9]{40}$/.test(r.sourceTree) &&
      Array.isArray(r.requiredServices) &&
      r.requiredServices.length > 0 &&
      r.requiredServices.length <= 100 &&
      r.requiredServices.every((v) => typeof v === "string") &&
      new Set(r.requiredServices).size === r.requiredServices.length,
    "complete_release_required",
    "A diagnostic foundation or browser flag cannot admit the complete application. The backend must supply its actual sealed release.",
  );
  return {
    sourceHead: r.sourceHead,
    sourceTree: r.sourceTree,
    manifest: evidenceFrom(r.manifest),
    selectedProfileDigest: sha256From(r.selectedProfileDigest),
    requiredServices: r.requiredServices as string[],
  };
}
export function backendPlanFrom(value: unknown): LinuxPlan["backend"] {
  const b = fields(value, ["target", "release"]);
  return { target: targetFrom(b.target), release: releaseFrom(b.release) };
}
export function boundIntentFrom(
  value: BoundLinuxIntent,
  op: LinuxOperation,
): BoundLinuxIntent {
  fields(value, ["kind", "intent"]);
  requireRepresentable(value,INTENT_MAX_BYTES);
  const intent = value.intent;
  fields(
    intent,
    value.kind === "deploy"
      ? [
          "operationId",
          "journalRevision",
          "target",
          "planDigest",
          "draftRevision",
          "release",
          "appOrigin",
          "importedAuthorityRefs",
          "desiredConfiguration",
          "serviceSecretRefs",
          "resourceKeys",
          "executionBoundSeconds",
        ]
      : [
          "operationId",
          "journalRevision",
          "freshTarget",
          "encryptedCohortManifest",
          "transportConfiguration",
          "transportCredentialRef",
          "recoveryKeyRef",
          "compatibleRelease",
          "revocationPolicyDigest",
          "executionBoundSeconds",
        ],
  );
  requireLinux(
    value.kind === (op.kind === "restore" ? "restore" : "deploy") &&
      intent.operationId === op.id &&
      natural(intent.journalRevision) >= 0 &&
      natural(intent.executionBoundSeconds, 86400) > 0,
    "backend_intent",
    "Bind and durably retain the actual server-owned intent before launch.",
  );
  if (value.kind === "deploy") {
    const i = value.intent;
    requireLinux(
      i.planDigest === op.plan.digest &&
        i.draftRevision === op.draftRevision &&
        i.appOrigin === op.plan.profile.settings.origin &&
        canonical(targetFrom(i.target)) === canonical(op.plan.backend.target) &&
        canonical(releaseFrom(i.release)) ===
          canonical(op.plan.backend.release) &&
        i.target.deploymentId === op.plan.profile.identity.deploymentId &&
        Array.isArray(i.resourceKeys) &&
        canonical([...i.resourceKeys].sort()) ===
          canonical(Object.values(op.plan.profile.identity.resources).sort()),
      "backend_intent_context",
      "The actual intent differs from the reviewed plan, target, original resources or complete release.",
    );
    evidenceFrom(i.desiredConfiguration);
    requireLinux(
      Array.isArray(i.importedAuthorityRefs) &&
        i.importedAuthorityRefs.length <= 100 &&
        Array.isArray(i.serviceSecretRefs) &&
        i.serviceSecretRefs.length <= 100,
      "backend_intent_refs",
      "Retain bounded evidence and managed-secret references only.",
    );
    i.importedAuthorityRefs.forEach(evidenceFrom);
    requireLinux(
      i.importedAuthorityRefs.length > 0,
      "authority_evidence_required",
      "The naming adapter must supply actual scoped authority evidence references.",
    );
    i.serviceSecretRefs.forEach(secretFrom);
  } else {
    const i = value.intent;
    requireLinux(
      canonical(targetFrom(i.freshTarget)) ===
        canonical(op.plan.backend.target) &&
        canonical(releaseFrom(i.compatibleRelease)) ===
          canonical(op.plan.backend.release) &&
        i.freshTarget.deploymentId === op.plan.profile.identity.deploymentId &&
        evidenceFrom(i.encryptedCohortManifest).sha256 ===
          op.plan.restoreManifestDigest?.replace(/^0x/, ""),
      "restore_intent_context",
      "Restore must bind the exact authenticated cohort, fresh target and compatible reviewed release.",
    );
    evidenceFrom(i.transportConfiguration);
    secretFrom(i.transportCredentialRef);
    secretFrom(i.recoveryKeyRef);
    sha256From(i.revocationPolicyDigest);
  }
  return structuredClone(value);
}
export function reconciliationFrom(
  value: LinuxReconciliationRequest,
  op: LinuxOperation,
): LinuxReconciliationRequest {
  fields(value, [
    "operationId",
    "journalRevision",
    "target",
    "intents",
    "executionBoundSeconds",
  ]);
  requireLinux(
    value.operationId === op.id &&
      canonical(targetFrom(value.target)) ===
        canonical(op.plan.backend.target) &&
      natural(value.journalRevision) >= 0 &&
      natural(value.executionBoundSeconds, 86400) > 0 &&
      Array.isArray(value.intents) &&
      value.intents.length > 0 &&
      value.intents.length <= 1000,
    "reconciliation_context",
    "Read back the original scoped intents and target; do not replace or adopt resources.",
  );
  value.intents.forEach(evidenceFrom);
  return structuredClone(value);
}
export function resultFrom(
  value: LinuxOperationResult,
  op: LinuxOperation,
): LinuxOperationResult {
  requireRepresentable(value,RESULT_MAX_BYTES);
  fields(value, [
    "operationId",
    "outcome",
    "lastCompletedPhase",
    "unrunPhases",
    "resources",
    "ownedProcesses",
    "rawReceipt",
    "postguard",
    "cleanup",
  ]);
  requireLinux(
    value.operationId === op.id &&
      ["completed", "failed", "interrupted", "custody-uncertain"].includes(
        value.outcome,
      ) &&
      (value.lastCompletedPhase === null ||
        typeof value.lastCompletedPhase === "string") &&
      Array.isArray(value.unrunPhases) &&
      value.unrunPhases.length <= 100 &&
      value.unrunPhases.every((v) => typeof v === "string") &&
      Array.isArray(value.resources) &&
      value.resources.length <= 1000 &&
      Array.isArray(value.ownedProcesses) &&
      value.ownedProcesses.length <= 10000,
    "backend_result",
    "The backend must retain its actual bounded operation result and restricted receipts.",
  );
  for (const r of value.resources) {
    fields(r, [
      "resourceKey",
      "intentId",
      "targetIdentityDigest",
      "disposition",
      "evidence",
      ...(Object.hasOwn(r, "observedConfigurationDigest")
        ? ["observedConfigurationDigest"]
        : []),
    ]);
    reference(r.resourceKey);
    requireLinux(
      Object.values(op.plan.profile.identity.resources).includes(
        r.resourceKey,
      ) &&
        r.targetIdentityDigest ===
          op.plan.backend.target.endpointIdentityDigest,
      "resource_readback_context",
      "Retain readbacks for the original target and captured resource keys.",
    );
    if (r.observedConfigurationDigest !== undefined)
      sha256From(r.observedConfigurationDigest);
    reference(r.intentId);
    sha256From(r.targetIdentityDigest);
    requireLinux(
      ["owned-present", "confirmed-absent", "conflict", "unknown"].includes(
        r.disposition,
      ),
      "resource_readback",
      "Unknown or conflicting effects cannot be treated as absent.",
    );
    evidenceFrom(r.evidence);
  }
  for (const process of value.ownedProcesses) {
    fields(process, [
      "hostPid",
      "hostStartTicks",
      "hostGroup",
      "hostSession",
      "networkNamespace",
      "pidNamespace",
      ...(Object.hasOwn(process, "containerId") ? ["containerId"] : []),
    ]);
    if (process.containerId !== undefined) text(process.containerId);
    requireLinux(
      natural(process.hostPid) > 0 && /^\d+$/.test(process.hostStartTicks),
      "process_identity",
      "Use actual host process identities, never substituted namespace-local PIDs.",
    );
    natural(process.hostGroup);
    natural(process.hostSession);
    text(process.networkNamespace);
    text(process.pidNamespace);
  }
  evidenceFrom(value.rawReceipt);
  evidenceFrom(value.postguard);
  evidenceFrom(value.cleanup);
  return structuredClone(value);
}
