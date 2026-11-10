import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import { insist } from "../community/common.ts";
import { danceVerdictsAbi } from "./abi.ts";
import {
  danceEventEvidenceHash,
  danceSourceHash,
  decodeDanceRegistration,
  type DanceDomain,
  type DanceEventEvidence,
  type DanceSourcePin,
} from "./wire.ts";

export interface DanceCanonicalSource {
  schema: "pirate.dance-verdict/1";
  domain: DanceDomain;
  sourceHash: Hex;
  pin: DanceSourcePin;
  capturePolicy: Address;
  capturePolicyRuntimeHash: Hex;
}

export interface DanceBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  transactions: readonly Hex[];
}

export interface DanceLog {
  address: Address;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  transactionIndex: number | null;
  logIndex: number | null;
  removed?: boolean;
  data: Hex;
  topics: [] | [Hex, ...Hex[]];
}

export interface DanceReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logs: readonly DanceLog[];
}

export interface DanceReadPort {
  chainId(): Promise<number>;
  safe(): Promise<DanceBlock>;
  block(number: bigint): Promise<DanceBlock>;
  code(address: Address, blockNumber: bigint): Promise<Hex | undefined>;
  receipt(hash: Hex): Promise<DanceReceipt | null>;
  sourceView(
    address: Address,
    blockNumber: bigint,
  ): Promise<{
    sourceHash: Hex;
    communityId: Hex;
    version: number;
    capturePolicy: Address;
    capturePolicyRuntimeHash: Hex;
  }>;
  registration(
    address: Address,
    submissionId: Hex,
    blockNumber: bigint,
  ): Promise<readonly [Hex, Hex, Hex]>;
}

const same = (a: string | null | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase();
const isDigest = (value: string | null): value is Hex =>
  value !== null && /^0x[\da-fA-F]{64}$/.test(value) && BigInt(value) !== 0n;
const position = (value: number | null): value is number =>
  value !== null && Number.isSafeInteger(value) && value >= 0;
const verdictEvent = danceVerdictsAbi.find(
  (item) => item.type === "event" && item.name === "VerdictCommitted",
)!;
const verdictEventData = verdictEvent.inputs.filter(
  (input) => !input.indexed,
) as readonly AbiParameter[];
const maxUint64 = (1n << 64n) - 1n;
const maxSeconds = BigInt(Number.MAX_SAFE_INTEGER) / 1000n;

function sameOwnedLog(a: DanceLog, b: DanceLog) {
  return (
    a.removed === false &&
    b.removed === false &&
    same(a.address, b.address) &&
    a.blockNumber === b.blockNumber &&
    a.blockHash !== null &&
    same(b.blockHash, a.blockHash) &&
    a.transactionHash !== null &&
    same(b.transactionHash, a.transactionHash) &&
    a.transactionIndex === b.transactionIndex &&
    a.logIndex === b.logIndex &&
    same(a.data, b.data) &&
    a.topics.length === b.topics.length &&
    a.topics.every((t, i) => same(b.topics[i], t))
  );
}

export async function verifyDanceSourceAt(
  rpc: DanceReadPort,
  source: DanceCanonicalSource,
  blockNumber: bigint,
) {
  const { domain: d, pin } = source;
  insist(
    source.schema === "pirate.dance-verdict/1" &&
      blockNumber >= pin.deploymentBlock &&
      same(danceSourceHash(d, pin), source.sourceHash),
    "dance_source_pin_changed",
    503,
  );
  const peers = [
    [d.verifier, pin.runtimeCodeHash],
    [pin.directory, pin.directoryRuntimeHash],
    [pin.v4, pin.v4RuntimeHash],
    [pin.posts, pin.postsRuntimeHash],
    [source.capturePolicy, source.capturePolicyRuntimeHash],
  ] as const;
  const [validator, ...code] = await Promise.all([
    rpc.sourceView(d.verifier, blockNumber),
    ...peers.map(([address]) => rpc.code(address, blockNumber)),
  ]);
  insist(
    validator.version === 1 &&
      same(validator.communityId, d.communityId) &&
      same(validator.sourceHash, source.sourceHash) &&
      same(validator.capturePolicy, source.capturePolicy) &&
      same(
        validator.capturePolicyRuntimeHash,
        source.capturePolicyRuntimeHash,
      ) &&
      code.every(
        (bytes, i) =>
          bytes !== undefined &&
          bytes !== "0x" &&
          same(keccak256(bytes), peers[i]![1]),
      ),
    "dance_historical_runtime_changed",
    503,
  );
}

/** Decode a historical event after checking both its canonical position and
 * its receipt-owned raw bytes. Later role, account and media changes do not
 * change the result that the pinned contract accepted at this position. */
export async function verifyDanceVerdict(
  rpc: DanceReadPort,
  source: DanceCanonicalSource,
  log: DanceLog,
  anchor?: DanceBlock,
) {
  const { domain: d } = source;
  insist(BigInt(await rpc.chainId()) === d.chainId, "dance_wrong_chain", 503);
  const observedSafe = await rpc.safe();
  const safe = anchor ?? observedSafe;
  const {
    blockNumber,
    blockHash,
    transactionHash,
    transactionIndex,
    logIndex,
  } = log;
  insist(
    log.removed === false &&
      same(log.address, d.verifier) &&
      blockNumber !== null &&
      blockNumber >= source.pin.deploymentBlock &&
      blockNumber <= maxUint64 &&
      isDigest(blockHash) &&
      isDigest(transactionHash) &&
      position(transactionIndex) &&
      position(logIndex),
    "dance_log_position_invalid",
    503,
  );
  insist(
    blockNumber <= safe.number &&
      safe.number <= observedSafe.number &&
      isDigest(safe.hash),
    "dance_verdict_not_confirmed",
    409,
  );
  const [block, receipt] = await Promise.all([
    rpc.block(blockNumber),
    rpc.receipt(transactionHash),
  ]);
  insist(
    block.number === blockNumber &&
      same(block.hash, blockHash) &&
      same(block.transactions[transactionIndex], transactionHash) &&
      block.timestamp > 0n &&
      block.timestamp <= maxSeconds,
    "dance_verdict_reorged",
    409,
  );
  insist(
    receipt?.status === "success" &&
      receipt.blockNumber === blockNumber &&
      same(receipt.blockHash, blockHash) &&
      same(receipt.transactionHash, transactionHash) &&
      receipt.transactionIndex === transactionIndex,
    "dance_receipt_not_owned",
    503,
  );
  const owned = receipt.logs.filter(
    (candidate) => candidate.logIndex === logIndex,
  );
  insist(
    owned.length === 1 && sameOwnedLog(owned[0]!, log),
    "dance_receipt_log_not_owned",
    503,
  );
  insist(
    log.topics.length === 4 && /^0x[0-9a-fA-F]{576}$/.test(log.data),
    "dance_event_encoding_invalid",
    503,
  );
  const event = decodeEventLog({
    abi: danceVerdictsAbi,
    eventName: "VerdictCommitted",
    data: log.data,
    topics: log.topics,
    strict: true,
  });
  const {
    verdict,
    sourceHash,
    submissionId,
    learner,
    learnerAccountCommitment,
    commandId,
  } = event.args;
  const topics = encodeEventTopics({
    abi: danceVerdictsAbi,
    eventName: "VerdictCommitted",
    args: { submissionId, commandId, learner },
  });
  insist(
    topics.every(
      (topic, i) => typeof topic === "string" && same(log.topics[i], topic),
    ) &&
      same(
        log.data,
        encodeAbiParameters(verdictEventData, [
          learnerAccountCommitment,
          sourceHash,
          verdict,
        ]),
      ),
    "dance_event_encoding_invalid",
    503,
  );
  insist(
    same(sourceHash, source.sourceHash) &&
      verdict.committedAtSeconds === block.timestamp &&
      (verdict.category === 1 || verdict.category === 2) &&
      isDigest(verdict.commandHash) &&
      isDigest(verdict.submissionHash) &&
      isDigest(commandId),
    "dance_event_context_changed",
    503,
  );
  const [, registration] = await Promise.all([
    verifyDanceSourceAt(rpc, source, blockNumber),
    rpc.registration(d.verifier, submissionId, blockNumber),
  ]);
  insist(
    same(registration[2], verdict.submissionHash),
    "dance_registration_hash_changed",
    503,
  );
  const { capture, submission } = decodeDanceRegistration(
    d,
    registration[0],
    registration[1],
    registration[2],
  );
  const committedAtMs = block.timestamp * 1000n;
  const within =
    verdict.category === 1 &&
    capture.offer.present &&
    committedAtMs >= capture.offer.opensAtMs &&
    committedAtMs < capture.offer.cutoffAtMs;
  insist(
    same(submission.submissionId, submissionId) &&
      same(capture.learner, learner) &&
      same(capture.accountCommitment, learnerAccountCommitment) &&
      committedAtMs >= submission.trustedSubmittedAtMs &&
      committedAtMs < submission.reviewDeadlineMs &&
      verdict.withinFrozenOfferWindow === within,
    "dance_verdict_binding_changed",
    503,
  );
  const [again, canonicalSafe] = await Promise.all([
    rpc.block(blockNumber),
    rpc.block(safe.number),
  ]);
  insist(
    again.number === blockNumber &&
      same(again.hash, blockHash) &&
      canonicalSafe.number === safe.number &&
      same(canonicalSafe.hash, safe.hash) &&
      again.timestamp === block.timestamp,
    "dance_verdict_reorged",
    409,
  );
  const provenance: DanceEventEvidence = {
    sourceHash,
    commandHash: verdict.commandHash,
    submissionHash: verdict.submissionHash,
    verdict: verdict.category,
    committedAtSeconds: block.timestamp,
    transactionHash,
    transactionIndex: BigInt(transactionIndex),
    logIndex: BigInt(logIndex),
    blockNumber,
    blockHash,
  };
  return {
    sourceHash,
    commandId,
    capture,
    submission,
    learner,
    learnerAccountCommitment,
    verdict:
      verdict.category === 1 ? ("pass" as const) : ("not_passed" as const),
    committedAtMs: Number(committedAtMs),
    withinFrozenOfferWindow: within,
    evidenceHash: danceEventEvidenceHash(d, provenance),
    provenance,
  };
}

export type VerifiedDanceVerdict = Awaited<
  ReturnType<typeof verifyDanceVerdict>
>;
