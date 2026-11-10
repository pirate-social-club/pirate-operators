import { bytes32, hashJson, insist } from "../community/common.ts";
import type { QualificationEntry } from "../rewards/contracts.ts";
import {
  DANCE_SOURCE,
  type DanceCapture,
  type DanceVerdict,
} from "./contracts.ts";
import { danceId, danceTime, validateCapture } from "./validation.ts";

/** Versioned proposal for the coordinator-owned categorical contract reader.
 * Only a verified canonical adapter may construct these records. Local review
 * rows are never treated as chain evidence by this reader. No RPC is invented.
 */
export interface CanonicalDancePass {
  version: typeof DANCE_SOURCE;
  capture: DanceCapture;
  recordingSha256: string;
  verdict: Omit<DanceVerdict, "chainAdmission"> & {
    chainAdmission: "held" | "canonical";
  };
  evidenceHash: string;
  sourceId: string;
  canonicalBlockHash: string;
  canonicalBlockNumber: string;
  /** Authoritative timestamp chosen by the admitted contract specification. */
  committedAtMs: number;
}
export function danceQualificationEntries(
  records: readonly CanonicalDancePass[],
  offer: {
    offerId: string;
    inputHash: string;
    songKey: string;
    sourceId: string;
    opensAt: number;
    cutoffAt: number;
  },
): QualificationEntry[] {
  [offer.inputHash, offer.songKey, offer.sourceId].forEach(bytes32);
  danceId(offer.offerId);
  const entries: QualificationEntry[] = [];
  for (const r of records) {
    validateCapture(r.capture);
    bytes32(r.recordingSha256);
    bytes32(r.evidenceHash);
    bytes32(r.canonicalBlockHash);
    danceTime(r.committedAtMs);
    insist(
      r.version === DANCE_SOURCE && /^\d+$/.test(r.canonicalBlockNumber),
      "dance_source_invalid",
      503,
    );
    // Until coordinator admits the categorical contract there are NO payable
    // records: local verdicts explicitly carry chainAdmission:'held'.
    insist(
      r.verdict.chainAdmission !== "held",
      "dance_chain_admission_held",
      503,
    );
    const selected = r.capture.offer;
    insist(
      selected &&
        selected.offerId === offer.offerId &&
        selected.inputHash === offer.inputHash &&
        selected.sourceId === offer.sourceId &&
        r.sourceId === offer.sourceId &&
        selected.opensAtMs === offer.opensAt * 1000 &&
        selected.cutoffAtMs === offer.cutoffAt * 1000 &&
        r.capture.songKey === offer.songKey &&
        r.verdict.verdict === "passed" &&
        r.verdict.version === DANCE_SOURCE &&
        r.verdict.score === null &&
        r.verdict.cue === "not_required" &&
        r.verdict.rewardReason === "candidate_held" &&
        r.verdict.reviewerAccountId !== r.capture.accountId &&
        r.verdict.reviewerIdentityId !== r.capture.identityId &&
        r.verdict.committedAtMs === r.committedAtMs,
      "dance_source_binding_mismatch",
      503,
    );
    insist(
      r.committedAtMs >= offer.opensAt * 1000 &&
        r.committedAtMs < offer.cutoffAt * 1000,
      "dance_source_outside_window",
      503,
    );
    entries.push({
      accountId: r.capture.accountId,
      wallet: r.capture.wallet,
      evidenceHash: r.evidenceHash,
      completedAt: Math.floor(r.committedAtMs / 1000),
    });
  }
  return entries;
}
/** Stable local evidence preimage. Contains no media URL or reusable capability. */
export function danceEvidenceHash(
  capture: DanceCapture,
  recordingSha256: string,
  verdict: DanceVerdict,
) {
  return hashJson({ version: DANCE_SOURCE, capture, recordingSha256, verdict });
}
