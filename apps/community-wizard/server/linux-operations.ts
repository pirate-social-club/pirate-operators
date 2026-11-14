import {canReadNormally,recoveryPortFrom} from "./linux-journal-capacity.ts";
import {requireSharedReadback} from "./shared-configuration-readback.ts";
import {
  fields,
  natural,
  reference,
  identityFrom,
  requireLinux,
  LinuxInputError,
} from "../../../packages/community-setup/shared-linux-profile.ts";
import { canonical, digestJson, sameIdentity, type LinuxJournal } from "./linux-journal.ts";
import {
  boundIntentFrom,
  reconciliationFrom,
  resultFrom,
} from "./linux-operator-boundary.ts";
import type {
  OriginalLinuxDeploymentPort as LinuxDeploymentPort,
  OriginalLinuxOperation as LinuxOperation,
  LinuxObservation,
  LinuxOperationResult,
} from "./linux-contracts.ts";
export const unresolved = (state: LinuxJournal) =>
  state.operation &&
  ["running", "pending", "unknown"].includes(state.operation.state);
export const custodyHeld = (state: LinuxJournal) =>
  Boolean(unresolved(state) && state.operation?.custody !== "cleared");
export function operationBytes(state: LinuxJournal): LinuxOperation {
  const op = state.operation!;
  return structuredClone({
    id: op.id,
    kind: op.kind,
    draftRevision: op.draftRevision,
    plan: op.plan,
    startedAt: op.startedAt,
  });
}
export function linuxOperations(
  backend: LinuxDeploymentPort,
  read: () => LinuxJournal,
  change: (fn: (state: LinuxJournal) => void) => Promise<void>,
  call: <T>(work: () => Promise<T>) => Promise<T>,
  now: () => number,
) {
  let job: Promise<void> | undefined;
  let reconciliation:Promise<void>|undefined;
  let owned: { id: string; controller: AbortController } | undefined;
  async function apply(
    id: string,
    value: LinuxObservation,
    result: LinuxOperationResult,
  ) {
    const o = fields(
      value,
      value.state === "succeeded"
        ? [
            "revision",
            "custody",
            "state",
            "receiptRef",
            "identity",
            "profileDigest",
            "recovery",
            "health", "sharedConfiguration",
          ]
        : value.state === "failed"
          ? [
              "revision",
              "custody",
              "state",
              "receiptRef",
              "effects",
              "identity",
              "correction",
            ]
          : ["revision", "custody", "state", "receiptRef", "correction"],
    );
    const revision = natural(o.revision);
    requireLinux(
      revision > 0 &&
        ["held", "cleared"].includes(String(o.custody)) &&
        ["pending", "unknown", "failed", "succeeded"].includes(String(o.state)),
      "invalid_receipt",
      "Reconcile this operation through the actual receipt and custody verifier.",
    );
    requireLinux(
      o.custody !== "cleared" || result.outcome !== "custody-uncertain",
      "custody_uncertain",
      "The original active claim must remain held until actual postguard and cleanup reconciliation.",
    );
    const receiptRef = reference(o.receiptRef);
    await change((state) => {
      const op = state.operation;
      if (!op || op.id !== id || revision <= op.observationRevision) return;
      if (["failed", "succeeded"].includes(op.state)) return;
      if (o.state === "succeeded" || o.state === "failed") {
        requireLinux(
          o.custody === "cleared",
          "custody_uncertain",
          "Terminal status needs actual cleared process custody, not timeout or an empty process list.",
        );
        const identity = identityFrom(o.identity);
        requireLinux(
          sameIdentity(identity, op.plan.profile.identity),
          "receipt_identity",
          "The backend receipt names different original resources. Keep the intent held.",
        );
        state.identity = identity;
      }
      if (o.state === "succeeded") {
        requireSharedReadback(o.sharedConfiguration,op.plan.profile);
        requireLinux(
          result.resources.every(
            (r) => r.disposition !== "unknown" && r.disposition !== "conflict",
          ),
          "resource_effects_unresolved",
          "Unknown or conflicting resource effects cannot become a completed deployment.",
        );
        requireLinux(
          result.outcome === "completed" &&
            result.unrunPhases.length === 0 &&
            Object.values(op.plan.profile.identity.resources).every((key) =>
              result.resources.some(
                (r) =>
                  r.resourceKey === key && r.disposition === "owned-present",
              ),
            ),
          "incomplete_profile",
          "Incomplete phases or a diagnostic foundation cannot become a deployed community.",
        );
        const h = fields(o.health, [
          "origin",
          "application",
          "login",
          "media",
          "learning",
          "checkedAt",
        ]);
        requireLinux(
          o.profileDigest === op.plan.profileDigest &&
            h.origin === op.plan.profile.settings.origin &&
            h.application === true &&
            h.login === true &&
            h.media === true &&
            typeof h.learning === "boolean" &&
            (!op.plan.profile.settings.features.learning ||
              h.learning === true) &&
            natural(h.checkedAt) >= op.startedAt &&
            (h.checkedAt as number) <= now() + 60_000,
          "health_incomplete",
          "The actual full app, login, media and selected Learning checks remain incomplete.",
        );
        if (op.kind === "restore") {
          const recovery = fields(o.recovery, [
            "inspectionId",
            "manifestDigest",
            "sessionPolicy",
          ]);
          requireLinux(
            recovery.inspectionId === op.plan.restoreInspectionId &&
              recovery.manifestDigest === op.plan.restoreManifestDigest &&
              recovery.sessionPolicy === op.plan.sessionPolicy,
            "recovery_policy_unproven",
            "The exact backup and actual session/revocation recovery policy remain unproven.",
          );
        } else
          requireLinux(
            o.recovery === null,
            "unexpected_restore_receipt",
            "Read back the original non-restore operation.",
          );
        op.state = "succeeded";
        op.message =
          "The backend verified the complete application, login, media and selected Learning deployment.";
      } else if (o.state === "failed") {
        requireLinux(
          result.resources.every(
            (r) => r.disposition !== "unknown" && r.disposition !== "conflict",
          ),
          "resource_effects_unresolved",
          "Resource effects remain uncertain even though process custody may be cleared.",
        );
        requireLinux(
          o.effects === "none" || o.effects === "retained",
          "unknown_effects",
          "Unknown effects cannot authorize a replacement apply.",
        );
        op.state = "failed";
        op.message =
          "The attempt and custody are reconciled. Correct settings and review the same retained resources.";
      } else {
        op.state = o.state as "pending" | "unknown";
        op.message =
          o.custody === "cleared"
            ? "Process custody is cleared. You may edit and review settings; unresolved original effects still block apply."
            : "Original process custody or effects remain uncertain. Reconcile; no replacement deployment will be sent.";
      }
      op.custody = o.custody as "held" | "cleared";
      op.observationRevision = revision;
      op.receiptRef = receiptRef;
      state.message = op.message;
    });
  }
  async function retainAndObserve(
    bytes: LinuxOperation,
    raw: LinuxOperationResult,
    terminalSlot=false,
  ) {
    const result = resultFrom(raw, bytes);
    await change((s) => {
      const retained = [s.operation, ...s.history].find(
        (op) => op?.id === bytes.id,
      );
      requireLinux(retained && retained.id===s.operation?.id,"operation_changed","Retain the original pending operation.");
      const digest=digestJson(result);
      requireLinux(retained.recoveryResultDigest===null || retained.recoveryResultDigest===digest,"terminal_result_changed","Do not replace the reserved original terminal result.");
      if(!retained.results.some(old=>canonical(old)===canonical(result)))retained.results.push(structuredClone(result));
      if(terminalSlot){retained.recoveryResultDigest=digest;retained.capacityPhase="terminal";}
      else retained.capacityPhase="ready";
    });
    await apply(
      bytes.id,
      await call(() => backend.observeResult({ operation: structuredClone(bytes), result: structuredClone(result) })),
      result,
    );
  }
  async function boundedResult(
    seconds: number,
    controller: AbortController,
    work: () => Promise<LinuxOperationResult>,
  ) {
    natural(seconds, 86400);
    requireLinux(
      seconds > 0 && !controller.signal.aborted,
      "operation_cancelled",
      "Reconcile the original bounded operation.",
    );
    let timer: ReturnType<typeof setTimeout> | undefined,
      abortTimer: ReturnType<typeof setTimeout> | undefined;
    let aborted!: () => void;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_, reject) => {
          aborted = () => {
            abortTimer = setTimeout(
              () =>
                reject(
                  new LinuxInputError(
                    "operation_cancelled",
                    "Cancellation did not return a conclusive postguard. Retain custody and reconcile.",
                  ),
                ),
              5000,
            );
          };
          controller.signal.addEventListener("abort", aborted, { once: true });
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new LinuxInputError(
                "operation_deadline",
                "Execution reached its sealed bound. Custody remains held until actual reconciliation.",
              ),
            );
          }, seconds * 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abortTimer) clearTimeout(abortTimer);
      if (aborted) controller.signal.removeEventListener("abort", aborted);
    }
  }
  async function uncertain(id: string) {
    await change((s) => {
      if (
        s.operation?.id === id &&
        !["failed", "succeeded"].includes(s.operation.state)
      ) {
        s.operation.state = "unknown";
        s.operation.message =
          s.operation.custody === "cleared"
            ? "Process custody remains cleared, but a conclusive resource readback is still missing. Edit or review settings; reconcile effects before apply."
            : "No conclusively verified receipt or postguard was received. The original claim stays held until actual reconciliation.";
        s.message = s.operation.message;
      }
    });
  }
  return {
    start() {
      const bytes = operationBytes(read()),
        controller = new AbortController();
      owned = { id: bytes.id, controller };
      job = (async () => {
        try {
          recoveryPortFrom(backend,bytes.plan.profile.runtime.sourceDigest);
          const binding = boundIntentFrom(
            await call(() => backend.bindOperation(bytes)),
            bytes,
          );
          await change((s) => {
            requireLinux(
              s.operation?.id === bytes.id && s.operation.intent === null,
              "intent_changed",
              "The original bound intent must not be replaced.",
            );
            s.operation.intent = binding;
            s.operation.capacityPhase="reading";
          });
          // Both original request and exact server-owned low-level intent are
          // fsynced before invoking the actual owning operator method.
          const result = await boundedResult(
            binding.intent.executionBoundSeconds,
            controller,
            () =>
              binding.kind === "restore"
                ? backend.operator.restore(binding.intent, controller.signal)
                : backend.operator.deploy(binding.intent, controller.signal),
          );
          await retainAndObserve(bytes, result);
        } catch {
          await uncertain(bytes.id);
        } finally {
          if (owned?.id === bytes.id) owned = undefined;
        }
      })();
      void job.catch(() => {});
      return job;
    },
    async reconcile() {
      // A single serialized owner of each result reservation. Do not race the
      // still-running original native call or another read for the same slot.
      if(owned)return;
      if(reconciliation)return reconciliation;
      reconciliation=(async()=>{
        const state=read();requireLinux(state.operation,"operation_required","There is no retained deployment to reconcile.");
        if(!unresolved(state))return;
        const bytes=operationBytes(state), controller=new AbortController();
        const recovery=recoveryPortFrom(backend,bytes.plan.profile.runtime.sourceDigest);
        try {
          if(state.operation.recoveryResultDigest){
            const retained=state.operation.results.find(r=>digestJson(r)===state.operation!.recoveryResultDigest);
            requireLinux(retained,"terminal_result_missing","Preserve the exact original reserved result.");
            await apply(bytes.id,await call(()=>backend.observeResult({operation:structuredClone(bytes),result:structuredClone(retained)})),retained);
            return;
          }
          let ordinary=false;
          await change(s=>{
            requireLinux(s.operation?.id===bytes.id && s.operation.recoveryResultDigest===null,"operation_changed","Retain the original pending operation.");
            ordinary=canReadNormally(s);
            if(ordinary)s.operation.capacityPhase="reading";
          });
          if(!ordinary){
            // Never fetch another arbitrary pending result into the reserved
            // terminal slot. The actual producer must support this read-only
            // original-result boundary; there is no ordinary reconcile fallback.
            const value=await call(()=>recovery.terminal({operation:structuredClone(bytes),retainedIntent:structuredClone(read().operation!.intent)}));
            if(value.state==="pending"){
              const v=fields(value,["state","operationId"]);requireLinux(v.operationId===bytes.id,"operation_changed","Use the original recovery request.");return;
            }
            fields(value,["state","result"]);requireLinux(value.state==="result","terminal_recovery_invalid","Keep original effects pending.");
            const terminal=resultFrom(value.result,bytes);
            requireLinux(terminal.outcome!=="custody-uncertain" && terminal.resources.every(r=>r.disposition!=="unknown" && r.disposition!=="conflict"),"terminal_result_unclosed","The terminal-only producer must retain pending native work instead of spending its final slot.");
            await retainAndObserve(bytes,terminal,true);return;
          }
          const request=reconciliationFrom(await call(()=>backend.bindReconciliation({operation:structuredClone(bytes),retainedIntent:structuredClone(read().operation!.intent)})),bytes);
          const result=await boundedResult(request.executionBoundSeconds,controller,()=>backend.operator.reconcile(request,controller.signal));
          await retainAndObserve(bytes,result);
        } catch {await uncertain(bytes.id);}
      })().finally(()=>{reconciliation=undefined;});
      return reconciliation;
    },
    cancel() {
      if (owned) owned.controller.abort();
    },
    settled: () => job ?? Promise.resolve(),
  };
}
