// Coordinator proposal. The separately reviewed live adapter supplies effects.
// The default plan path never calls any port; execution requires explicit admission.
import { canonical, hashJson, insist } from "../packages/community/common.ts";
import {
  operatorPlan,
  type OperatorProfile,
} from "./study-operator-profile.ts";
export interface LiveOperator {
  workerTag: string;
  namespaces: OperatorProfile["objects"];
  moduleSha256: string;
  publicSettingsInvariantSha256: string;
  runtimeEvidenceSha256: string;
}
export type ExistingExecution =
  | "none"
  | "prepared"
  | "dispatched"
  | "unknown"
  | "complete";
export interface OperatorRunnerPorts {
  verifySourceAndArtifact(profile: OperatorProfile): Promise<void>; // public local package only
  observeContracts(profile: OperatorProfile): Promise<void>; // reuse observeStudyRelease; fixed chain
  acquireLock(profileHash: string): Promise<() => Promise<void>>;
  loadCloudCredential(profile: OperatorProfile): Promise<unknown>;
  observeOperator(
    profile: OperatorProfile,
    cloud: unknown,
  ): Promise<LiveOperator>;
  authenticateRetainedState(
    profile: OperatorProfile,
    cloud: unknown,
  ): Promise<void>;
  qualifyCustodyAndRuntime(
    profile: OperatorProfile,
    cloud: unknown,
  ): Promise<void>;
  existingExecution(profileHash: string): Promise<ExistingExecution>;
  preservePredecessor(
    profile: OperatorProfile,
    profileHash: string,
  ): Promise<void>;
  recordPrepared(profileHash: string): Promise<void>;
  recordDispatched(profileHash: string): Promise<void>;
  loadRuntimeSecrets(profile: OperatorProfile): Promise<unknown>;
  applyOnce(
    profile: OperatorProfile,
    profileHash: string,
    cloud: unknown,
    secrets: unknown,
  ): Promise<void>;
  planOnly?(
    profile: OperatorProfile,
    profileHash: string,
    cloud: unknown,
    secrets: unknown,
  ): Promise<unknown>;
  verifyPreservedSuccessor(
    profile: OperatorProfile,
    profileHash: string,
    cloud: unknown,
  ): Promise<void>;
  recordUnknown(profileHash: string): Promise<void>;
  recordComplete(profileHash: string): Promise<void>;
  now(): number;
}
function target(
  profile: OperatorProfile,
  live: LiveOperator,
  successor: boolean,
) {
  insist(
    live.workerTag === profile.worker.tag &&
      canonical(live.namespaces) === canonical(profile.objects),
    "study_operator_live_identity_changed",
    409,
  );
  insist(
    live.publicSettingsInvariantSha256 ===
      profile.predecessor.publicSettingsInvariantSha256 &&
      live.runtimeEvidenceSha256 === profile.retained.runtimeEvidenceSha256,
    "study_operator_retained_state_changed",
    409,
  );
  insist(
    live.moduleSha256 ===
      (successor ? profile.artifact.sha256 : profile.predecessor.moduleSha256),
    "study_operator_live_module_changed",
    409,
  );
}
function window(profile: OperatorProfile, now: number) {
  insist(
    now >= Date.parse(profile.window.notBefore) &&
      now < Date.parse(profile.window.deadline),
    "study_operator_execution_window_expired",
    409,
  );
  const seconds = Math.floor(now / 1000);
  insist(
    seconds >= profile.retained.quoteValidFrom &&
      seconds < profile.retained.quoteValidUntil,
    "study_operator_quote_window_expired",
    409,
  );
}
export async function runOperator(
  value: unknown,
  mode: "plan" | "preflight" | "cloud-plan" | "execute" = "plan",
  ports?: OperatorRunnerPorts,
  expectedProfileHash?: string,
) {
  const plan = operatorPlan(value),
    profile = plan.profile,
    profileHash = plan.profileHash;
  if (mode === "plan") return plan; // No port, credential, state or network access.
  insist(
    mode === "preflight" || mode === "cloud-plan" || mode === "execute",
    "study_operator_mode_invalid",
    409,
  );
  insist(ports, "study_operator_adapter_required", 409);
  if (mode === "execute" || mode === "cloud-plan")
    insist(
      expectedProfileHash === profileHash,
      "study_operator_profile_not_reviewed",
      409,
    );
  if (mode === "execute")
    insist(
      profile.execution.reviewedPlanPath &&
        profile.execution.reviewedPlanSha256,
      "study_operator_plan_review_missing",
      409,
    );
  if (mode === "cloud-plan")
    insist(ports.planOnly, "study_operator_plan_adapter_required", 409);
  await ports.verifySourceAndArtifact(profile);
  await ports.observeContracts(profile);
  if (mode === "preflight") {
    const cloud = await ports.loadCloudCredential(profile),
      live = await ports.observeOperator(profile, cloud);
    target(profile, live, false);
    await ports.authenticateRetainedState(profile, cloud);
    await ports.qualifyCustodyAndRuntime(profile, cloud);
    return {
      ...plan,
      observed: live,
      executionReady: false,
      execution: "not started",
    };
  }
  const release = await ports.acquireLock(profileHash);
  try {
    const existing = await ports.existingExecution(profileHash);
    const recovering =
      existing === "dispatched" ||
      existing === "unknown" ||
      existing === "complete";
    if (!recovering) window(profile, ports.now());
    const cloud = await ports.loadCloudCredential(profile),
      live = await ports.observeOperator(profile, cloud);
    if (
      existing === "dispatched" ||
      existing === "unknown" ||
      existing === "complete"
    ) {
      // Unknown apply outcomes may only reconcile the exact successor; never replay.
      target(profile, live, true);
      await ports.verifyPreservedSuccessor(profile, profileHash, cloud);
      await ports.recordComplete(profileHash);
      return { ...plan, reconciled: true, execution: "complete" };
    }
    insist(
      existing === "none" || existing === "prepared",
      "study_operator_execution_state_invalid",
      409,
    );
    target(profile, live, false);
    await ports.authenticateRetainedState(profile, cloud);
    await ports.qualifyCustodyAndRuntime(profile, cloud);
    await ports.preservePredecessor(profile, profileHash);
    await ports.recordPrepared(profileHash);
    // Recheck custody, targets and source after preservation and immediately before secrets/apply.
    window(profile, ports.now());
    await ports.verifySourceAndArtifact(profile);
    await ports.observeContracts(profile);
    target(profile, await ports.observeOperator(profile, cloud), false);
    await ports.qualifyCustodyAndRuntime(profile, cloud);
    const secrets = await ports.loadRuntimeSecrets(profile);
    insist(
      hashJson(profile) === profileHash,
      "study_operator_profile_mutated",
      409,
    );
    window(profile, ports.now());
    if (mode === "cloud-plan") {
      insist(ports.planOnly, "study_operator_plan_adapter_required", 409);
      const capture = await ports.planOnly(
        profile,
        profileHash,
        cloud,
        secrets,
      );
      return {
        ...plan,
        execution: "plan captured; no deploy dispatched",
        capture,
      };
    }
    await ports.recordDispatched(profileHash);
    try {
      await ports.applyOnce(profile, profileHash, cloud, secrets);
      target(profile, await ports.observeOperator(profile, cloud), true);
      await ports.verifyPreservedSuccessor(profile, profileHash, cloud);
      await ports.recordComplete(profileHash);
    } catch (error) {
      await ports.recordUnknown(profileHash); // Retain exact prepared package/state for reconciliation.
      throw error;
    }
    return { ...plan, reconciled: false, execution: "complete" };
  } finally {
    await release();
  }
}
