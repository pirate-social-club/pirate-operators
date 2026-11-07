// The surrounding reader first authenticates the exact reviewed ciphertext.
import { insist, object } from "../packages/community/common.ts";
import type { OperatorProfile } from "./study-operator-profile.ts";
export function assertOwnedOperatorState(
  record: Record<string, unknown>,
  profile: OperatorProfile,
) {
  const owned = (value: unknown) => {
    const attr = object(value);
    insist(
      attr.accountId === profile.worker.accountId &&
        attr.workerId === profile.worker.tag &&
        attr.workerName === profile.worker.name,
      "study_operator_owned_worker_state_changed",
      409,
    );
  };
  insist(
    typeof record.status === "string" &&
      ["created", "updated", "updating"].includes(record.status) &&
      record.resourceType === "Cloudflare.Worker" &&
      record.logicalId === "Operator" &&
      (record.providerMode === undefined || record.providerMode === "live"),
    "study_operator_owned_worker_state_changed",
    409,
  );
  owned(record.attr);
  if (record.status === "updating") {
    const old = object(record.old);
    owned(old.attr);
    insist(
      object(record.props).name === profile.worker.name &&
        object(old.props).name === profile.worker.name,
      "study_operator_updating_target_changed",
      409,
    );
    // The pinned schema requires props/bindings/attr; actual old records may also
    // retain full metadata. Never invent absent metadata, but validate it when present.
    insist(
      (old.resourceType === undefined ||
        old.resourceType === "Cloudflare.Worker") &&
        (old.logicalId === undefined || old.logicalId === "Operator") &&
        (old.status === undefined ||
          (typeof old.status === "string" &&
            ["created", "updated"].includes(old.status))) &&
        (old.providerMode === undefined || old.providerMode === "live") &&
        Array.isArray(old.bindings),
      "study_operator_updating_predecessor_changed",
      409,
    );
  }
}
