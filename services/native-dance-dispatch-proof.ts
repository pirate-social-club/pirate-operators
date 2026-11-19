import type { Hex } from "viem";
import { exact, insist, object } from "../packages/community/common.ts";
import { nativeDanceRaw, nativeDanceReply, type NativeDanceRetainedReference } from "./native-dance-retained-reference.ts";

export interface NativeDanceDispatchProof {
  calldata: Hex;
  expiresAtMs: number;
}

/** Recheck directly at the effect boundary after any synchronous journal work. */
export function assertNativeDanceDispatchProofCurrent(expiresAtMs: number, now = Date.now()) {
  insist(Number.isSafeInteger(expiresAtMs) && expiresAtMs > now, "native_dance_dispatch_proof_expired", 403);
}

export function readNativeDanceDispatchProof(raw: string, reference: NativeDanceRetainedReference): NativeDanceDispatchProof {
  const result = object(nativeDanceReply(raw, reference));
  exact(result, ["calldata", "expiresAtMs"]);
  const expiresAtMs = result.expiresAtMs;
  insist(typeof expiresAtMs === "number", "native_dance_dispatch_proof_invalid", 503);
  assertNativeDanceDispatchProofCurrent(expiresAtMs);
  return { calldata: nativeDanceRaw(result.calldata), expiresAtMs };
}
