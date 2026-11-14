import {operationActionMatches} from "../../../packages/community-setup/operational-selection.ts";
import {JOURNAL_CAPACITY_POLICY,requireJournalCapacity} from "./linux-journal-capacity.ts";
import {digestJson,sameIdentity} from "./linux-journal.ts";
import {namespaceChallengeFrom} from "./shared-namespace-challenge.ts";
import {
  fields,
  requireLinux,
  reference,
  natural,
  hash,
  targetFrom,
  type LinuxDraftV2,
} from "../../../packages/community-setup/shared-linux-profile.ts";
import {
  planFrom,
  requirementsFrom,
  targetInspectionFrom,
  namespaceProofFrom,
  restoreInspectionFrom,
} from "./linux-boundaries.ts";
import { boundIntentFrom, resultFrom } from "./linux-operator-boundary.ts";
import type { LinuxJournal } from "./linux-journal.ts";

export function validateLinuxJournal(state: LinuxJournal) {
  // Reject incompatible retained metadata rather than silently resetting it.
  fields(state, [
    "version", "capacityPolicy",
    "revision",
    "draft",
    "destination",
    "target",
    "namespace",
    "imported",
    "backupId",
    "backupDigest",
    "restore",
    "plan",
    "identity",
    "requirements",
    "secretRequest",
    "uploadRequest",
    "operation", "namespaceRequest", "namespaceChallenge", "namespaceHistory",
    "history",
    "message",
  ]);
  if(state.draft?.version === 3)requireLinux(state.imported === null && state.restore === null && state.backupId === null &&
    state.backupDigest === null && state.uploadRequest === null && state.history.length === 0,"create_recovery_deferred","Preserve this inconsistent create journal; no recovery state may be reinterpreted.");
  if (state.plan) state.plan = planFrom(state.plan);
  if (state.operation) state.operation.plan = planFrom(state.operation.plan);
  state.requirements = requirementsFrom(state.requirements);
  if (state.destination) {
    const d = fields(state.destination, ["mode", "target"]);
    requireLinux(
      ["create", "import", "restore"].includes(String(d.mode)),
      "invalid_journal",
      "Preserve this unsupported setup destination.",
    );
    state.destination = {
      mode: d.mode as LinuxDraftV2["mode"],
      target: targetFrom(d.target),
    };
  }
  if (state.target) {
    const d = state.draft ?? state.destination;
    requireLinux(
      d,
      "invalid_journal",
      "The retained target has no selected destination.",
    );
    state.target = targetInspectionFrom(state.target, d);
  }
  if (state.namespace) {
    requireLinux(
      state.draft,
      "invalid_journal",
      "The retained namespace has no community settings.",
    );
    state.namespace = namespaceProofFrom(
      state.namespace,
      state.draft.namespace.tld,
    );
  }
  if (state.backupId) {
    reference(state.backupId);
    hash(state.backupDigest);
  }
  if (state.restore) {
    requireLinux(
      state.backupId && state.backupDigest,
      "invalid_journal",
      "The retained backup inspection has no original ciphertext identity.",
    );
    state.restore = restoreInspectionFrom(
      state.restore,
      state.backupId,
      state.backupDigest,
      [state.restore.format],
    );
  }
  for (const op of [state.operation, ...state.history])
    if (op) {
      fields(op, [
        "id",
        "kind",
        "draftRevision",
        "plan",
        "startedAt",
        "state",
        "intent",
        "results", "capacityPhase", "recoveryResultDigest",
        "custody",
        "receiptRef",
        "observationRevision",
        "message",
      ]);
      op.plan = planFrom(op.plan);
      reference(op.id);
      natural(op.draftRevision);
      natural(op.startedAt);
      natural(op.observationRevision);
      requireLinux(
        ["held", "cleared"].includes(op.custody) && Array.isArray(op.results),
        "invalid_journal",
        "Preserve the original operation custody and receipts.",
      );
      requireLinux(
        ["create", "import", "restore"].includes(op.kind) &&
          ["running", "pending", "unknown", "failed", "succeeded"].includes(
            op.state,
          ) &&
          operationActionMatches(op.kind,op.plan.action),
        "invalid_journal",
        "Preserve this unsupported retained operation.",
      );
      requireLinux(
        !["failed", "succeeded"].includes(op.state) ||
          (op.custody === "cleared" &&
            op.observationRevision > 0 &&
            op.receiptRef !== null),
        "invalid_journal",
        "Terminal retained work needs its actual custody and receipt provenance.",
      );
      if (op.intent) op.intent = boundIntentFrom(op.intent, op);
      op.results = op.results.map((result) => resultFrom(result, op));
      requireLinux(["binding","reading","ready","terminal"].includes(op.capacityPhase),"invalid_journal","Retain explicit recovery reservation provenance.");
      requireLinux(op.recoveryResultDigest===null || typeof op.recoveryResultDigest==="string" && /^[0-9a-f]{64}$/.test(op.recoveryResultDigest) &&
        op.capacityPhase==="terminal" && op.results.some(r=>digestJson(r)===op.recoveryResultDigest),"invalid_journal","Retain the exact reserved terminal result; never replace it.");
      requireLinux(op.capacityPhase!=="terminal" || op.recoveryResultDigest!==null,"invalid_journal","A consumed terminal slot needs its exact retained result.");
      if (op.receiptRef) reference(op.receiptRef);
    }
  for (const pending of [state.secretRequest, state.uploadRequest, state.namespaceRequest])
    if (pending) reference(pending.id);

  if(state.namespaceRequest){
    const r=fields(state.namespaceRequest,["id","kind","bindingRevision","challengeId"]);natural(r.bindingRevision);
    requireLinux((r.kind==="begin" && r.challengeId===null || r.kind==="complete" && typeof r.challengeId==="string") &&
      r.bindingRevision===state.revision && state.draft,"invalid_journal","Preserve the original bound namespace request.");
    if(r.challengeId!==null)hash(r.challengeId);
  }
  if(state.namespaceChallenge)state.namespaceChallenge=namespaceChallengeFrom(state.namespaceChallenge);
  if(state.namespaceRequest?.kind==="complete")requireLinux(state.namespaceChallenge?.id===state.namespaceRequest.challengeId,"invalid_journal","Retain the original one-use challenge.");
  requireLinux(Array.isArray(state.namespaceHistory) && state.namespaceHistory.length<=1000,"invalid_journal","Retain original namespace request history.");
  for(const r of state.namespaceHistory){fields(r,["requestId","kind","challengeId","bindingRevision","outcome","evidenceRef"]);reference(r.requestId);natural(r.bindingRevision);reference(r.evidenceRef);requireLinux(["begin","complete"].includes(r.kind)&&["completed","not-started"].includes(r.outcome),"invalid_journal","Retain request disposition.");if(r.challengeId!==null)hash(r.challengeId);}
  requireLinux(state.history.every(op=>["failed","succeeded"].includes(op.state)),"invalid_journal","An unresolved historical operation requires explicit recovery, not a new admission.");
  if(state.operation && ["running","pending","unknown"].includes(state.operation.state))requireLinux(state.identity && sameIdentity(state.identity,state.operation.plan.profile.identity),"invalid_journal","Pending work must retain its already captured complete resource identity.");
  requireJournalCapacity(state);
  return state;
}
