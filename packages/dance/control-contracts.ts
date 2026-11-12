import type { DanceAttempt } from "./contracts.ts";
/** Local journal metadata, not a new chain protocol or ABI. */
export interface DanceControlBinding {
  version: "pirate.dance-control-binding/1";
  commandId: string;
  intentHash: string;
  communityId: string;
  sourceHash: string;
  sourceJson: string;
  caller: string;
  wallet: string;
  operation: "grant" | "revoke";
  expectedEpoch: number;
  wireId: string;
  commandHash: string;
  encodedPayload: string;
  calldata: string;
  bindingHash: string;
}
export interface DanceRoleStamp {
  sourceHash: string;
  wallet: string;
  revision: number;
  blockNumber: number;
  blockHash: string;
}
export interface DanceRevokeContext {
  sourceHash?: string;
  roleEpoch: number;
  ownerEpoch: number;
  configurationRevision: number;
  /** Required on current HTTP authorization; captured SQL uses immutable epochs. */
  observation?: DanceRoleStamp;
}
export interface DanceControlEvidence {
  version: "pirate.dance-control-evidence/1";
  commandId: string;
  bindingHash: string;
  sourceHash: string;
  wallet: string;
  state: "canonical" | "orphaned" | "uncertain";
  resultEpoch: number | null;
  blockNumber: number | null;
  blockHash: string | null;
  transactionHash: string | null;
  transactionIndex: number | null;
  logIndex: number | null;
  anchorNumber: number | null;
  anchorHash: string | null;
  /** Exact receipt-owned log, retained even after demotion; JSON has decimal strings. */
  rawLogJson: string | null;
  reason: string | null;
}
export interface DanceRoleProjection {
  communityId: string;
  sourceHash: string;
  wallet: string;
  anchorNumber: number;
  anchorHash: string;
  ownerEpoch: number;
  configurationRevision: number;
  ownerValidFromMs: number;
  ownerExpiresAtMs: number;
  roleEpoch: number | null;
  roleExpiresAtMs: number | null;
  state: "active" | "inactive";
  /** Records the reviewed observer's complete returned snapshot and exact source. */
  observationJson: string;
}
export interface RetainedControlAttempt extends DanceAttempt {
  guardedBindingHash: string | null;
}
