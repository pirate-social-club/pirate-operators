import type { Address, Hex } from "viem";
import { digest, type Ticket } from "../packages/protocol/index.ts";
import {
  rewardScore,
  songEndMs,
  type BillingEntry,
  type KaraokeManifest,
  type KaraokeResultBody,
  type LineOutcome,
  type OperatorQuote,
  type RedemptionRef,
} from "../packages/protocol/payments.ts";
import {
  aggregateKaraokeSession,
  applyTimingOffsetCompensation,
  bucketRecognizedWordsIntoLines,
  scoreKaraokeLine,
  KARAOKE_SCORING_VERSION,
  type KaraokeRecognizedWord,
} from "../packages/scoring/scoring.ts";
import type { Store } from "./runtime.ts";

export interface Attempt {
  ticketId: Hex;
  attemptId: Hex;
  startedAt: number;
  connected: boolean;
  disconnectedAt: number | null;
  lastAudioAt: number | null;
  failedLineIds: string[];
  ended: null | {
    endedAt: number;
    status: KaraokeResultBody["status"];
    paymentDeadline: number;
  };
  /** Set at the payment deadline; the closure's nonce and block once known. */
  closing: null | { submitting: boolean; nonce: number | null; block: number | null };
  finalized: boolean;
}

/**
 * Builds the final result from the purchases reconciled at the closure block.
 * Unpaid lines are never scored or revealed; the session timing compensation
 * runs over paid lines only.
 */
export function resultBody(
  store: Store,
  ticket: Ticket,
  manifest: KaraokeManifest,
  quote: OperatorQuote,
  quoteId: Hex,
  attempt: Attempt,
  paid: ReadonlyMap<string, RedemptionRef>,
  closedAtBlock: number,
): KaraokeResultBody {
  const ended = attempt.ended!;
  const billing: BillingEntry[] = manifest.segments.map((segment) => ({
    segmentId: segment.segmentId,
    take: 0,
    lineIds: segment.lineIds,
    redemption: paid.get(segment.segmentId) ?? null,
  }));
  const paidLines = new Set(
    billing.filter((b) => b.redemption).flatMap((b) => b.lineIds),
  );
  const words = store.get<KaraokeRecognizedWord[]>(`words:${ticket.ticketId}`) ?? [];
  const buckets = bucketRecognizedWordsIntoLines({
    lines: manifest.lines.map((line, i) => ({
      lineId: line.lineId,
      lineIndex: i,
      scoredLineIndex: i,
      text: line.text,
      startMs: line.startMs,
      endMs: line.endMs,
      words: line.words,
    })),
    words,
    nowMs: songEndMs(manifest) + 1000,
    finalizedReason: "session_end",
  }).map((bucket) =>
    attempt.failedLineIds.includes(bucket.lineId)
      ? { ...bucket, finalizedReason: "provider_failed" as const }
      : bucket,
  );
  const paidScores = buckets
    .filter((bucket) => paidLines.has(bucket.lineId))
    .map((bucket) => scoreKaraokeLine({ bucket }));
  const compensated = new Map(
    applyTimingOffsetCompensation(paidScores).lineScores.map((s) => [s.lineId, s]),
  );
  const lines: LineOutcome[] = manifest.lines.map((line) => {
    const score = compensated.get(line.lineId);
    const outcome = (status: LineOutcome["status"], scoreBps: number | null) => ({
      lineId: line.lineId,
      lineVersion: line.lineVersion,
      status,
      scoreBps,
    });
    if (!score) return outcome("unpaid", null);
    if (score.uncertain) return outcome("unmeasured", null);
    if (score.recognizedWords.length === 0) return outcome("silent", null);
    return outcome(
      "assessed",
      Math.min(10000, Math.max(0, Math.round(score.score * 10000))),
    );
  });
  const session = aggregateKaraokeSession({ lineScores: paidScores });
  const summary = {
    scoreBps: Math.round(session.finalScore * 10000),
    coverageBps:
      session.lineCount > 0
        ? Math.round((session.scoredLineCount / session.lineCount) * 10000)
        : 0,
    scoringVersion: KARAOKE_SCORING_VERSION,
  };
  const reward = rewardScore(lines);
  const paidCount = billing.filter((b) => b.redemption).length;
  return {
    attemptId: attempt.attemptId,
    ticketId: ticket.ticketId,
    communityId: ticket.communityId,
    participant: ticket.participant as Address,
    songHash: ticket.songHash,
    manifestSha256: ticket.manifestSha256,
    quoteId,
    community: ticket.community,
    mode: ticket.mode,
    status: ended.status,
    finality: "final",
    revision: 1,
    startedAt: attempt.startedAt,
    lastAudioAt: attempt.lastAudioAt,
    endedAt: ended.endedAt,
    closedAtBlock,
    summary,
    summaryHash: digest(summary),
    lines,
    billing,
    linesHash: digest(lines),
    billingHash: digest(billing),
    ...reward,
    paidCount,
    paidAmount: (BigInt(paidCount) * BigInt(quote.segmentPrice)).toString(),
  };
}
