import assert from "node:assert/strict";
import { sameProcess, type ProcessIdentity } from "./backend-state.ts";

/** Lifetime absence and authority to signal are different questions. */
export function sameLifetime(previous: Pick<ProcessIdentity, "hostPid" | "hostStartTicks">,
  current: Pick<ProcessIdentity, "hostPid" | "hostStartTicks"> | null) {
  return current !== null && previous.hostPid === current.hostPid && previous.hostStartTicks === current.hostStartTicks;
}
export function requireLifetimeAbsent(previous: ProcessIdentity, current: ProcessIdentity | null) {
  const valid = (value: ProcessIdentity) => Number.isSafeInteger(value.hostPid) && value.hostPid > 0 &&
    typeof value.hostStartTicks === "string" && /^[0-9]+$/.test(value.hostStartTicks);
  assert(valid(previous) && (current === null || valid(current)), "backup_lifetime_observation_invalid_uncertain");
  assert(current === null || current.hostPid === previous.hostPid, "backup_wrong_pid_observation");
  if (sameLifetime(previous, current)) {
    assert(sameProcess(previous, current), "backup_live_lifetime_identity_changed_uncertain");
    throw new Error("backup_writer_lifetime_still_present");
  }
  return { lifetime: { pid: previous.hostPid, startTicks: previous.hostStartTicks }, observed: current,
    disposition: current === null ? "absent-at-observation" as const : "original-lifetime-gone-pid-reused" as const };
}
export function requireObserverHostFrame(holder: ProcessIdentity, observer: ProcessIdentity | null) {
  assert(sameProcess(holder, observer), "backup_observer_host_frame_changed_uncertain");
  return observer!;
}
export function containerProcessEvidence(observer: ProcessIdentity, containerId: string, dockerHostPid: number,
  observed: ProcessIdentity | null) {
  assert(observed && observed.hostPid === dockerHostPid && dockerHostPid > 0, "backup_container_pid_unobservable");
  assert(/^pid:\[[0-9]+\]$/.test(observed.pidNamespace) && /^net:\[[0-9]+\]$/.test(observed.networkNamespace),
    "backup_container_namespace_unobservable");
  // The observer is authenticated separately. A private container namespace is
  // retained as evidence; it need not and normally will not equal the host's.
  return { containerId, dockerHostPid, observerHostFrame: observer, containerProcess: observed };
}
