// Explicit shared profile/port v2 successor to the retained v1 proposal. This module does not implement the
// target, credential, ciphertext-store or complete application lifecycle drivers.
// All are required owning services; none has an available/success fallback.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linuxDraftFrom, linuxProfileFrom } from "../../packages/community-setup/shared-linux-profile.ts";
import type {
  LinuxDeploymentPort, LinuxObservation, LinuxOperation, LinuxPlan,
  BoundLinuxIntent, LinuxOperatorAdapter, LinuxOperationResult,
} from "../../apps/community-wizard/server/linux-contracts.ts";

import { boundIntentFrom, reconciliationFrom, resultFrom } from "../../apps/community-wizard/server/linux-operator-boundary.ts";
import {requireGenuineProducer,type SharedResultProducer} from "./shared-v2-result-producer.ts";
import {recoveryPortFrom} from "../../apps/community-wizard/server/linux-journal-capacity.ts";
import {requireSharedReadback} from "../../apps/community-wizard/server/shared-configuration-readback.ts";
import { planFrom } from "../../apps/community-wizard/server/linux-boundaries.ts";

export const LINUX_SHARED_WIZARD_PORT_VERSION = 2;
type Methods<K extends keyof LinuxDeploymentPort> = Pick<LinuxDeploymentPort, K>;
export interface BoundPostReadback {
  operationId: string;
  planDigest: string;
  profileDigest: string;
  targetFingerprint: string;
  sourceDigest: string;
  artifactDigest: string;
  observation: LinuxObservation;
}
export interface LinuxSharedBackendServices {
  boundedResults:SharedResultProducer;
  adapterId: string;
  sourceDigest: string;
  maxStagedCiphertextBytes: number;
  custody: { assertHeld(): Promise<void> };
  catalog: Methods<"capabilities">;
  targets: Methods<"inspectTarget">;
  credentials: Methods<"credentialRequirements" | "verifyCredentials" | "reconcileCredentials" | "saveCredentials">;
  backups: Methods<"stageBackup" | "inspectBackup">;
  operator: LinuxOperatorAdapter;
  lifecycle: Methods<"prepare" | "bindOperation" | "bindReconciliation">;
  intents: {
    assertBound(value: BoundLinuxIntent): Promise<void>;
    assertReconciliation(value: Parameters<LinuxOperatorAdapter["reconcile"]>[0]): Promise<void>;
  };
  // Must use the real naming owner and original server-held proof records.
  authority: {
    assertCurrent(plan: LinuxPlan): Promise<void>;
    assertCurrentIntent(value: BoundLinuxIntent): Promise<void>;
  };
  // Separate actual application/host readbacks after effect commands. A command
  // receipt or capability flag cannot implement this service.
  postReadback: { observe(input: {operation: LinuxOperation; result: LinuxOperationResult}): Promise<BoundPostReadback> };
}

const digest = (value: unknown): value is string => typeof value === "string" &&
  value.length === 66 && /^0x[a-f0-9]{64}$/.test(value);
function requireServices(value: LinuxSharedBackendServices) {
  assert(value && typeof value === "object", "linux_backend_services_unavailable");
  assert(typeof value.adapterId === "string" && value.adapterId.length > 0 && digest(value.sourceDigest),
    "linux_backend_source_identity_invalid");
  assert(Number.isSafeInteger(value.maxStagedCiphertextBytes) && value.maxStagedCiphertextBytes > 0,
    "linux_backend_backup_limit_invalid");
  const groups: [unknown, string[]][] = [
    [value.custody, ["assertHeld"]], [value.catalog, ["capabilities"]], [value.targets, ["inspectTarget"]],
    [value.credentials, ["credentialRequirements", "verifyCredentials", "reconcileCredentials", "saveCredentials"]],
    [value.backups, ["stageBackup", "inspectBackup"]],
    [value.operator, ["deploy", "restore", "reconcile"]],
    [value.lifecycle, ["prepare", "bindOperation", "bindReconciliation"]],
    [value.intents, ["assertBound", "assertReconciliation"]],
    [value.authority, ["assertCurrent", "assertCurrentIntent"]], [value.postReadback, ["observe"]],
  ];
  for (const [group, names] of groups) {
    assert(group && typeof group === "object" && names.every((name) =>
      typeof (group as Record<string, unknown>)[name] === "function"), "linux_backend_services_unavailable");
  }
}
function validatePlan(plan: LinuxPlan) {
  // W6 owns canonical plan/profile preimages and raw64 digest validation.
  // Runtime/artifact/capability digests keep their distinct 0x-prefixed API.
  assert.deepEqual(planFrom(plan), plan, "linux_backend_plan_not_canonical");
}
export function retainLinuxOperation(value: LinuxOperation) {
  const operation = structuredClone(value);
  assert(typeof operation.id === "string" && operation.id.length > 0 &&
    Number.isSafeInteger(operation.startedAt), "linux_backend_operation_invalid");
  assert(["create", "import", "restore"].includes(operation.kind), "linux_backend_operation_invalid");
  assert(Number.isSafeInteger(operation.draftRevision) && operation.draftRevision >= 0, "linux_backend_draft_revision_invalid");
  validatePlan(operation.plan);
  const action = operation.plan.action;
  const compatible = operation.kind === "restore" ? action === "restore" :
    action === "upgrade" || (operation.kind === "create" ? action === "create" : action === "adopt");
  assert(compatible, "linux_backend_operation_action_mismatch");
  if (action === "upgrade") {
    assert(typeof operation.plan.predecessorOperationId === "string" &&
      operation.plan.predecessorOperationId.length > 0, "upgrade_predecessor_required");
  }
  // Kind, predecessor and resource identities remain unchanged. Actual admitted
  // upgrade rights and original effects still require the real intent store,
  // current authority and server-held predecessor checks before any effect.
  return operation;
}

/** Bootstrap calls this with real required owning services, then passes the
 * returned port to createLinuxWizardRuntime. Missing services fail construction.
 * Factory presence is not an implemented backend or a support/readiness claim. */
export function createSharedLinuxDeploymentPort(input: LinuxSharedBackendServices): LinuxDeploymentPort {
  requireServices(input);
  const journalRecovery=sharedJournalRecoveryForSelectedNative(input);
  recoveryPortFrom({journalRecovery},input.sourceDigest);
  const held = () => input.custody.assertHeld();
  async function readback(operation: LinuxOperation, result: LinuxOperationResult): Promise<LinuxObservation> {
    await held();
    const observed = await input.postReadback.observe({operation: structuredClone(operation), result: structuredClone(result)});
    assert.equal(observed.operationId, operation.id, "linux_backend_readback_wrong_operation");
    assert.equal(observed.planDigest, operation.plan.digest, "linux_backend_readback_wrong_plan");
    assert.equal(observed.profileDigest, operation.plan.profileDigest, "linux_backend_readback_wrong_profile");
    assert.equal(observed.targetFingerprint, operation.plan.targetFingerprint, "linux_backend_readback_wrong_target");
    assert.equal(observed.sourceDigest, operation.plan.profile.runtime.sourceDigest, "linux_backend_readback_wrong_source");
    assert.equal(observed.artifactDigest, operation.plan.profile.runtime.artifactDigest, "linux_backend_readback_wrong_artifact");
    const observation = observed.observation;
    assert(Number.isSafeInteger(observation.revision) && observation.revision > 0, "linux_backend_readback_stale");
    assert(["held", "cleared"].includes(observation.custody), "linux_backend_custody_invalid");
    if (result.outcome === "custody-uncertain") {
      assert(observation.custody === "held" && !["failed", "succeeded"].includes(observation.state), "linux_backend_custody_uncertain");
    }
    if (["failed", "succeeded"].includes(observation.state)) {
      assert(observation.custody === "cleared", "linux_backend_custody_uncertain");
    }
    assert(typeof observation.receiptRef === "string" && observation.receiptRef.length > 0 &&
      observation.receiptRef.length <= 200 && !/[\x00-\x1f\x7f]/.test(observation.receiptRef), "linux_backend_readback_receipt_missing");
    if (observation.state === "succeeded") {
      requireSharedReadback(observation.sharedConfiguration,operation.plan.profile);
      assert(result.outcome === "completed" && result.unrunPhases.length === 0 &&
        result.resources.every((resource) => !["unknown", "conflict"].includes(resource.disposition)), "linux_backend_result_incomplete");
      assert.deepEqual(observation.identity, operation.plan.profile.identity, "linux_backend_readback_wrong_resources");
      assert.equal(observation.profileDigest, operation.plan.profileDigest, "linux_backend_readback_wrong_profile");
      assert.equal(observation.health.origin, operation.plan.profile.settings.origin, "linux_backend_readback_wrong_origin");
      assert(observation.health.application && observation.health.login && observation.health.media &&
        (!operation.plan.profile.settings.features.learning || observation.health.learning), "linux_backend_readback_incomplete");
      const now = Date.now();
      assert(Number.isSafeInteger(observation.health.checkedAt) && observation.health.checkedAt <= now &&
        now - observation.health.checkedAt <= 60_000, "linux_backend_readback_stale");
      if (operation.kind === "restore") {
        assert(observation.recovery && observation.recovery.inspectionId === operation.plan.restoreInspectionId &&
          observation.recovery.manifestDigest === operation.plan.restoreManifestDigest &&
          observation.recovery.sessionPolicy === operation.plan.sessionPolicy, "linux_backend_restore_readback_incomplete");
      }
    }
    return structuredClone(observation);
  }
  return Object.freeze({
    version: LINUX_SHARED_WIZARD_PORT_VERSION,
    journalRecovery:Object.freeze({...journalRecovery,async terminal(request){
      await held();const result=await journalRecovery.terminal(structuredClone(request));await held();return structuredClone(result);
    }} satisfies LinuxDeploymentPort["journalRecovery"]),
    operator: Object.freeze({
      async deploy(intent, signal) {
        await held(); assert(!signal.aborted, "linux_backend_cancelled");
        const value: BoundLinuxIntent = {kind: "deploy", intent: structuredClone(intent)};
        await input.intents.assertBound(value); await input.authority.assertCurrentIntent(value); await held();
        return input.operator.deploy(structuredClone(intent), signal);
      },
      async restore(intent, signal) {
        await held(); assert(!signal.aborted, "linux_backend_cancelled");
        const value: BoundLinuxIntent = {kind: "restore", intent: structuredClone(intent)};
        await input.intents.assertBound(value); await input.authority.assertCurrentIntent(value); await held();
        return input.operator.restore(structuredClone(intent), signal);
      },
      async reconcile(request, signal) {
        await held(); assert(!signal.aborted, "linux_backend_cancelled");
        await input.intents.assertReconciliation(structuredClone(request));
        return input.operator.reconcile(structuredClone(request), signal);
      },
    } satisfies LinuxOperatorAdapter),
    async capabilities() {
      await held(); const result = await input.catalog.capabilities();
      assert.equal(result.version, LINUX_SHARED_WIZARD_PORT_VERSION);
      assert.equal(result.adapterId, input.adapterId); assert.equal(result.sourceDigest, input.sourceDigest);
      assert.equal(result.backup.maxBytes, input.maxStagedCiphertextBytes, "linux_backend_backup_limit_mismatch");
      return structuredClone(result);
    },
    async inspectTarget(request) { await held(); return input.targets.inspectTarget(structuredClone(request)); },
    async credentialRequirements(request) { await held(); return input.credentials.credentialRequirements(structuredClone(request)); },
    async verifyCredentials(request) { await held(); return input.credentials.verifyCredentials(structuredClone(request)); },
    async reconcileCredentials(request) { await held(); return input.credentials.reconcileCredentials(structuredClone(request)); },
    async saveCredentials(request) {
      await held();
      // Transient values go only to the required secret owner, never a plan,
      // capability, operation log, receipt or deployment health response here.
      await input.credentials.saveCredentials(request);
    },
    async stageBackup(request) {
      await held();
      assert(Number.isSafeInteger(request.byteLength) && request.byteLength > 0 &&
        request.byteLength <= input.maxStagedCiphertextBytes, "linux_backend_backup_size_invalid");
      const hash = createHash("sha256"); let bytes = 0, completed = false;
      async function* bounded() {
        for await (const part of request.bytes) {
          assert(part instanceof Uint8Array, "linux_backend_backup_chunk_invalid");
          bytes += part.byteLength; assert(bytes <= request.byteLength, "linux_backend_backup_size_invalid");
          hash.update(part); yield part;
        }
        assert.equal(bytes, request.byteLength, "linux_backend_backup_size_invalid"); completed = true;
      }
      const staged = await input.backups.stageBackup({ ...request, bytes: bounded() });
      assert(completed, "linux_backend_backup_not_consumed");
      assert.equal(staged.ciphertextDigest, "0x" + hash.digest("hex"), "linux_backend_backup_digest_mismatch");
      return structuredClone(staged);
    },
    async inspectBackup(request) {
      await held(); const result = await input.backups.inspectBackup(request);
      assert(digest(result.ciphertextDigest) && digest(result.manifestDigest), "linux_backend_backup_digest_invalid");
      assert.deepEqual(linuxProfileFrom(result.profile), result.profile, "linux_backend_backup_profile_invalid");
      assert(!result.compatible || result.authenticated, "linux_backend_backup_not_authenticated");
      return structuredClone(result);
    },
    async prepare(request) {
      await held(); linuxDraftFrom(request.draft);
      const plan = await input.lifecycle.prepare(structuredClone(request)); validatePlan(plan);
      assert.equal(plan.targetInspectionId, request.target.id, "linux_backend_plan_wrong_inspection");
      assert.equal(plan.targetFingerprint, request.target.fingerprint, "linux_backend_plan_wrong_target");
      assert.equal(plan.namespaceProofId, request.namespace.id, "linux_backend_plan_wrong_namespace");
      await input.authority.assertCurrent(structuredClone(plan));
      return structuredClone(plan);
    },
    async bindOperation(value) {
      await held(); const operation = retainLinuxOperation(value);
      assert(operation.plan.expiresAt > Date.now(), "linux_backend_plan_expired");
      await input.authority.assertCurrent(structuredClone(operation.plan));
      const bound = boundIntentFrom(await input.lifecycle.bindOperation(structuredClone(operation)), operation);
      await input.intents.assertBound(structuredClone(bound));
      await input.boundedResults.admit(operation,bound);
      return bound;
    },
    async bindReconciliation(request) {
      await held(); const operation = retainLinuxOperation(request.operation);
      // Original expired intents remain readable; no new effects are authorized.
      const bound = reconciliationFrom(await input.lifecycle.bindReconciliation({
        operation, retainedIntent: structuredClone(request.retainedIntent),
      }), operation);
      await input.intents.assertReconciliation(structuredClone(bound));
      return bound;
    },
    async observeResult(request) {
      await held(); const operation = retainLinuxOperation(request.operation);
      const result = resultFrom(request.result, operation);
      return readback(operation, result);
    },
  } satisfies LinuxDeploymentPort);
}

// Used by the exact shared-v2 owning factory successor, never by v1 capability
// construction. An arbitrary structural recovery port or declared byte policy
// cannot implement this selected native producer join.
export function sharedJournalRecoveryForSelectedNative(input:{
 boundedResults:SharedResultProducer;operator:LinuxOperatorAdapter;sourceDigest:string;
}) {
 return requireGenuineProducer(input.boundedResults,input.operator,input.sourceDigest).port;
}
