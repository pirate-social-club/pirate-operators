// Public revision proof is separate from the immutable first-publication job.
import { zeroHash, type Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import {
  resultCommitment,
  studyExercisesHash,
  unpackStudyOutcomes,
  type TerminalResult,
} from "../packages/protocol/learning-results-v3.ts";

export interface StudyRevisionEvidence {
  result: TerminalResult;
  outcomes: Hex;
  commitment: Hex;
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  logIndex: number;
}
export const restoreStudyResult = (r: TerminalResult): TerminalResult => ({
  ...r,
  song: { ...r.song, chainId: BigInt(r.song.chainId) },
  startedAt: BigInt(r.startedAt),
  completedAt: BigInt(r.completedAt),
});
export const studyRevisionContext = (r: TerminalResult) =>
  resultCommitment(
    { ...restoreStudyResult(r), revision: 1, supersedes: zeroHash, status: 1 },
    "0x",
  );
const position = (a: StudyRevisionEvidence, b: StudyRevisionEvidence) =>
  BigInt(a.blockNumber) === BigInt(b.blockNumber)
    ? a.logIndex - b.logIndex
    : BigInt(a.blockNumber) < BigInt(b.blockNumber)
      ? -1
      : 1;

function validate(e: StudyRevisionEvidence) {
  const r = restoreStudyResult(e.result);
  check(
    r.activity === 2 &&
      Number.isInteger(r.revision) &&
      r.revision >= 1 &&
      r.revision <= 0xffffffff &&
      r.status >= 1 &&
      r.status <= 5 &&
      Number.isSafeInteger(e.logIndex) &&
      e.logIndex >= 0 &&
      /^\d+$/.test(e.blockNumber) &&
      /^0x[0-9a-f]{64}$/i.test(e.blockHash) &&
      /^0x[0-9a-f]{64}$/i.test(e.transactionHash) &&
      resultCommitment(r, e.outcomes) === e.commitment,
    "invalid_study_revision_evidence",
  );
  const outcomes = unpackStudyOutcomes(e.outcomes, r.linesTotal);
  check(
    studyExercisesHash(outcomes.map((x) => x.sourceOrdinal)) ===
      r.exercisesHash &&
      (r.status !== 1 ||
        outcomes.every(
          (x) => x.status === "correct" || x.status === "incorrect",
        )),
    "invalid_study_revision_outcomes",
  );
}

/** The caller authenticates the contract and canonical blocks/receipts first.
 * Missing links remain incomplete; a malformed latest revision never falls back.
 * A reorg requires the caller to replace an orphaned anchor with canonical proof.
 */
export function projectStudyRevisions(
  anchor: StudyRevisionEvidence,
  events: readonly StudyRevisionEvidence[],
  currentCommitment: Hex,
) {
  validate(anchor);
  check(events.length <= 128, "study_revision_history_limit");
  const revisions = new Map<number, StudyRevisionEvidence>();
  for (const event of events) {
    validate(event);
    check(
      studyRevisionContext(event.result) ===
        studyRevisionContext(anchor.result),
      "study_revision_context_changed",
    );
    if (event.result.revision < anchor.result.revision) continue;
    if (event.result.revision === anchor.result.revision) {
      check(
        event.commitment === anchor.commitment &&
          position(event, anchor) === 0 &&
          event.blockHash === anchor.blockHash,
        "study_revision_anchor_changed",
      );
      continue;
    }
    const previous = revisions.get(event.result.revision);
    check(
      !previous ||
        (previous.commitment === event.commitment &&
          previous.blockHash === event.blockHash &&
          position(previous, event) === 0),
      "conflicting_study_revision",
    );
    revisions.set(event.result.revision, event);
  }
  if (currentCommitment === anchor.commitment) {
    check(revisions.size === 0, "study_revision_head_conflict");
    return { latest: anchor, complete: true };
  }
  let latest = anchor;
  while (revisions.has(latest.result.revision + 1)) {
    const next = revisions.get(latest.result.revision + 1)!;
    check(
      next.result.supersedes === latest.commitment &&
        position(latest, next) < 0,
      "study_revision_chain_changed",
    );
    check(
      next.result.status !== 5 ||
        (latest.result.status !== 5 && next.outcomes === latest.outcomes),
      "invalid_study_invalidation",
    );
    latest = next;
    if (latest.commitment === currentCommitment) {
      check(
        ![...revisions.keys()].some((n) => n > latest.result.revision),
        "study_revision_head_conflict",
      );
      return { latest, complete: true };
    }
  }
  return { latest, complete: false };
}
