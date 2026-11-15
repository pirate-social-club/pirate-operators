// Explicit local receipt-capacity policy. Not authority, provider readiness or
// a filesystem free-space guarantee. Old journals need a separate cutover.
import {requireLinux} from "../../../packages/community-setup/shared-linux-profile.ts";
import type {LinuxJournal,JournalOperation} from "./linux-journal.ts";
import type {LinuxDeploymentPort} from "./linux-contracts.ts";
export const JOURNAL_CAPACITY_POLICY="pirate.linux-journal-capacity/1" as const;
export const JOURNAL_MAX_BYTES=2_097_152;
export const RESULT_MAX_BYTES=524_288;
export const INTENT_MAX_BYTES=262_144;
export const NAMESPACE_RESULT_MAX_BYTES=65_536;
export const CREDENTIAL_REQUIREMENTS_MAX_BYTES=131_072;
export const UPLOAD_RECEIPT_RESERVE_BYTES=4_096;
export const OBSERVATION_RESERVE_BYTES=8_192;
// Compact JSON uses exactly two array delimiter bytes per added result. The
// fixed reserve also covers phase/digest/receipt/state/message/revision growth.
export const TERMINAL_METADATA_BYTES=1_024;
export const TERMINAL_RESERVE_BYTES=RESULT_MAX_BYTES+TERMINAL_METADATA_BYTES+OBSERVATION_RESERVE_BYTES;
function observationGrowth(state:LinuxJournal,op:JournalOperation){
  // Exact scalar contribution, excluding constant keys/delimiters. Replacing
  // lifecycle fields spends the reservation instead of reserving them twice.
  const current=[state.message,op.message,op.receiptRef,op.observationRevision,op.state,op.custody,op.capacityPhase,op.recoveryResultDigest]
    .reduce<number>((n,v)=>n+Buffer.byteLength(JSON.stringify(v)),0);
  return Math.max(0,OBSERVATION_RESERVE_BYTES-current);
}
export const encodedBytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v)+"\n");
export function requireRepresentable(value:unknown,limit:number) {
  requireLinux(encodedBytes(value)<=limit,"journal_outcome_bound","This producer result/intent exceeds the explicit local receipt policy; preserve its native evidence. It is not an admitted inline outcome.");
}
export function recoveryPortFrom(backend:Pick<LinuxDeploymentPort,"journalRecovery">,sourceDigest?:string) {
  const p=backend.journalRecovery;
  requireLinux(p?.policy===JOURNAL_CAPACITY_POLICY && p.resultMaxBytes===RESULT_MAX_BYTES &&
    p.intentMaxBytes===INTENT_MAX_BYTES && typeof p.terminal==="function" &&
    typeof p.sourceDigest==="string" && /^0x[0-9a-f]{64}$/.test(p.sourceDigest) &&
    (sourceDigest===undefined || p.sourceDigest===sourceDigest),
    "journal_recovery_unavailable","Connect the actual source-pinned bounded-result and terminal-only recovery producer before any operation. A legacy/unbounded producer is unavailable.");
  return p;
}
const active=(op:JournalOperation)=>["running","pending","unknown"].includes(op.state);
export function reservedBytes(state:LinuxJournal) {
  let total=0;
  for(const op of [state.operation,...state.history])if(op && active(op)) {
    const growth=observationGrowth(state,op);
    total+=op.capacityPhase==="terminal"?growth:RESULT_MAX_BYTES+TERMINAL_METADATA_BYTES+growth;
    if(op.capacityPhase==="binding")total+=INTENT_MAX_BYTES+RESULT_MAX_BYTES;
    else if(op.capacityPhase==="reading")total+=RESULT_MAX_BYTES;
  }
  if(state.namespaceRequest)total+=NAMESPACE_RESULT_MAX_BYTES+TERMINAL_METADATA_BYTES;
  // A pending credential read replaces the same bounded requirements array.
  // Reserve its remaining growth, so a pending receipt does not reserve twice.
  if(state.secretRequest)total+=Math.max(0,CREDENTIAL_REQUIREMENTS_MAX_BYTES-encodedBytes(state.requirements))+TERMINAL_METADATA_BYTES;
  if(state.uploadRequest)total+=UPLOAD_RECEIPT_RESERVE_BYTES;
  return total;
}
export function requireJournalCapacity(state:LinuxJournal) {
  requireLinux(state.capacityPolicy===JOURNAL_CAPACITY_POLICY,"journal_capacity_upgrade_required","Preserve this old journal byte-for-byte; explicit capacity-policy inventory/cutover is required. Do not reset or auto-upgrade it.");
  requireLinux(encodedBytes(state)+reservedBytes(state)<=JOURNAL_MAX_BYTES,"journal_full","Preserve all evidence. Reserved terminal/recovery capacity cannot be spent on new work.");
}
export function canReadNormally(state:LinuxJournal) {
  const copy=structuredClone(state);if(!copy.operation)return false;
  copy.operation.capacityPhase="reading";
  return encodedBytes(copy)+reservedBytes(copy)<=JOURNAL_MAX_BYTES;
}
