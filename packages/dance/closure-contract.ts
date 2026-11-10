import { canonical } from "../community/common.ts";
import type { DanceSourcePin } from "./contracts.ts";
/** Root owns actual source verifier, atomic offer-close/settlement mount.
 * Capture these with entries, not current credential_bindings after unlink. */
export interface DanceClosureSnapshot {
  version: "pirate.dance-closure-snapshot/1";
  offerId: string;
  offerInputHash: string;
  cutoffBlock: { number: string; hash: string; timestampSeconds: string };
  sources: readonly DanceSourcePin[];
  retainedBindings: readonly {
    accountId: string;
    wallet: string;
    accountCommitment: string;
  }[];
}
export function closureSnapshotDisposition(
  frozen: DanceClosureSnapshot,
  revalidated: DanceClosureSnapshot,
) {
  return canonical(frozen) === canonical(revalidated)
    ? {
        hold: false as const,
        preserveEntries: true as const,
        replayPaid: false as const,
      }
    : {
        hold: true as const,
        preserveEntries: true as const,
        replayPaid: false as const,
      };
}
