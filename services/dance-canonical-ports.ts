import { encodeEventTopics, type Hex } from "viem";
import { danceVerdictsAbi } from "../packages/dance-chain/abi.ts";
import { bytes32, insist } from "../packages/community/common.ts";
import type {
  DanceCanonicalSource,
  DanceReadPort,
} from "../packages/dance-chain/reader.ts";
import {
  danceCaptureHash,
  danceMediaBinding,
  danceMediaId,
  danceOfferId,
} from "../packages/dance-chain/wire.ts";
import { DanceStore } from "../packages/dance/store.ts";
import type {
  DanceCanonicalEvidence,
  DanceCapture,
  DanceDecisionIntent,
  DancePorts,
  DanceSourcePin,
} from "../packages/dance/contracts.ts";
import {
  canonicalDanceCapture,
  canonicalDanceDecision,
  reconcileCanonicalDanceVerdict,
} from "./dance-canonical-commands.ts";

function selected(source: DanceCanonicalSource, pin: DanceSourcePin) {
  insist(
    BigInt(pin.chainId) === source.domain.chainId &&
      pin.communityId === source.domain.communityId &&
      pin.sourceHash === source.sourceHash &&
      pin.policyHash === source.pin.publicityPolicyHash &&
      pin.runtimeCodeHash === source.pin.runtimeCodeHash &&
      pin.publisher === source.pin.fixedPublisher &&
      pin.address === source.domain.verifier &&
      pin.fromBlock === source.pin.deploymentBlock.toString(),
    "dance_canonical_source_changed",
    503,
  );
}

export interface DanceVerdictJournal {
  attempts(commandId: string): Promise<readonly Hex[]>;
  prior(reviewId: string): Promise<DanceCanonicalEvidence | null>;
}

export function storedDanceVerdictJournal(
  db: D1Database,
  communityId: Hex,
): DanceVerdictJournal {
  const store = new DanceStore(db);
  return {
    async attempts(commandId) {
      const rows = await db
        .prepare(
          `SELECT a.transaction_hash FROM dance_transaction_attempts a
         JOIN dance_outbox b ON b.command_id=a.command_id
         WHERE a.command_id=? AND b.community_id=? AND b.kind='decision'
         ORDER BY a.attempt_id LIMIT 33`,
        )
        .bind(commandId, communityId)
        .all<{ transaction_hash: string }>();
      return rows.results.map((row) => bytes32(row.transaction_hash));
    },
    async prior(reviewId) {
      const review = await store.review(reviewId);
      insist(
        review.capture.communityId === communityId,
        "dance_not_found",
        404,
      );
      return review.canonical;
    },
  };
}

/** The original attempt hashes are the only receipt lookup authority.
 * A disappearing receipt alone cannot prove that a confirmed block changed. */
export async function observeDanceIntent(
  rpc: DanceReadPort,
  source: DanceCanonicalSource,
  journal: DanceVerdictJournal,
  intent: DanceDecisionIntent,
) {
  const expected = canonicalDanceDecision(source, intent);
  insist(
    BigInt(await rpc.chainId()) === source.domain.chainId,
    "dance_wrong_chain",
    503,
  );
  const [safe, attempts, prior] = await Promise.all([
    rpc.safe(),
    journal.attempts(intent.commandId),
    journal.prior(intent.preimage.submissionId),
  ]);
  insist(attempts.length <= 32, "dance_attempt_limit", 503);
  let found: DanceCanonicalEvidence | null = null;
  for (const hash of new Set(attempts.map(bytes32))) {
    const receipt = await rpc.receipt(hash);
    insist(
      !receipt || receipt.transactionHash === hash,
      "dance_receipt_not_owned",
      503,
    );
    if (
      !receipt ||
      receipt.status !== "success" ||
      receipt.blockNumber > safe.number
    )
      continue;
    const block = await rpc.block(receipt.blockNumber);
    insist(
      block.number === receipt.blockNumber,
      "dance_log_position_invalid",
      503,
    );
    if (block.hash !== receipt.blockHash) continue;
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() !== source.domain.verifier ||
        log.topics[1]?.toLowerCase() !== expected.submissionId ||
        log.topics[2]?.toLowerCase() !== expected.command.id
      )
        continue;
      // Registration and control logs can also be indexed by submission/command.
      // A verdict needs the exact verdict topic and immutable canonical payload.
      if (log.topics[0]?.toLowerCase() !== verdictTopic) continue;
      insist(log.transactionHash === hash, "dance_receipt_log_not_owned", 503);
      insist(!found, "dance_duplicate_verdict_log", 503);
      found = await reconcileCanonicalDanceVerdict(rpc, source, intent, log);
    }
  }
  if (found)
    return prior?.canonical && prior.evidenceHash === found.evidenceHash
      ? null
      : found;
  if (prior?.canonical && prior.finality === "safe") {
    insist(
      prior.commandId === intent.commandId &&
        prior.submissionId === intent.preimage.submissionId &&
        prior.commandHash === expected.command.hash &&
        prior.source.sourceHash === source.sourceHash,
      "dance_canonical_evidence_changed",
      503,
    );
    const number = BigInt(prior.blockNumber);
    if (number <= safe.number) {
      const observed = await rpc.block(number);
      insist(observed.number === number, "dance_log_position_invalid", 503);
      if (observed.hash !== prior.blockHash)
        return { ...prior, canonical: false };
    }
  }
  return null;
}

const [verdictTopic] = encodeEventTopics({
  abi: danceVerdictsAbi,
  eventName: "VerdictCommitted",
});

export type CanonicalDanceBindings = Pick<
  DancePorts,
  | "captureCommitment"
  | "mediaBindingHash"
  | "offerIdCommitment"
  | "canonicalEvidence"
>;

/** Use the exact source and trusted original journal, never receipt evidence
 * from an HTTP body or a new attempt constructed during recovery. */
export function canonicalDanceBindings(input: {
  source: DanceCanonicalSource;
  rpc: DanceReadPort;
  journal: DanceVerdictJournal;
  songPostId(
    capture: Omit<DanceCapture, "captureHash" | "consent">,
  ): Promise<Hex>;
}): CanonicalDanceBindings {
  const { source, rpc, journal } = input;
  return {
    async captureCommitment(capture) {
      const wire = canonicalDanceCapture(
        source,
        capture,
        await input.songPostId(capture),
      );
      return danceCaptureHash(source.domain, wire);
    },
    async mediaBindingHash(preimage) {
      selected(source, preimage.source);
      insist(
        Number.isSafeInteger(preimage.expectedPostRetentionGeneration) &&
          preimage.expectedPostRetentionGeneration > 1,
        "dance_media_binding_mismatch",
        503,
      );
      return danceMediaBinding(
        source.domain,
        bytes32(preimage.captureHash),
        danceMediaId(source.domain, preimage.mediaId),
        BigInt(preimage.expectedPostRetentionGeneration),
        bytes32(preimage.recordingSha256),
      );
    },
    async offerIdCommitment(offerId, pin) {
      selected(source, pin);
      return danceOfferId(source.domain, offerId);
    },
    canonicalEvidence: (intent) =>
      observeDanceIntent(rpc, source, journal, intent),
  };
}
