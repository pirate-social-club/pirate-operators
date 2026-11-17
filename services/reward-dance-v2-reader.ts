import {
  decodeEventLog, encodeAbiParameters, encodeEventTopics, formatLog,
  keccak256, stringToHex, toHex, type AbiParameter, type Hex, type PublicClient,
} from "viem";
import { bytes32, hashJson, insist } from "../packages/community/common.ts";
import type { DanceBlock, DanceLog } from "../packages/dance-chain/reader.ts";
import { danceReadPort } from "../packages/dance-chain/rpc.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/v2/abi.ts";
import {
  danceAccountCommitment, danceCaptureHash, danceOfferId, danceSourceHash,
  decodeDanceRegistration, type DanceCapture,
} from "../packages/dance-chain/v2/wire.ts";
import { songKeyOf } from "../packages/protocol/records.ts";
import type { QualificationEntry } from "../packages/rewards/contracts.ts";
import { offerInput } from "../packages/rewards/offers.ts";
import { rewardTime } from "../packages/rewards/validation.ts";
import type { DancePublicationSourceV2 } from "./dance-publication-source.ts";
import type { CategoricalRewardReader } from "./reward-sources.ts";

/** Ports over ORIGINAL retained private bindings and exact historical song
 * evidence. A current credential/grant/queue lookup cannot implement these.
 * Root supplies the concrete producer; this reader writes no private state. */
export interface RewardDanceV2Proofs {
  retainedCapture(input: {
    sourceHash: Hex; captureId: Hex; captureHash: Hex;
  }): Promise<{ accountId: string; capture: DanceCapture } | null>;
  authenticateSong(
    song: DanceCapture["song"], blockNumber: bigint, blockHash: Hex,
  ): Promise<boolean>;
}

const same = (a: string | null | undefined, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const digest = (v: unknown): v is Hex =>
  typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) && BigInt(v) !== 0n;
const position = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const uuid = (v: unknown): v is string => typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const maxUint64 = (1n << 64n) - 1n;
const maxSeconds = BigInt(Number.MAX_SAFE_INTEGER) / 1000n;
const event = danceVerdictsAbi.find(x => x.type === "event" && x.name === "VerdictCommittedV2")!;
const eventData = event.inputs.filter(x => !x.indexed) as readonly AbiParameter[];
const topic = encodeEventTopics({ abi: danceVerdictsAbi, eventName: "VerdictCommittedV2" })[0] as Hex;
type Cutoff = Parameters<CategoricalRewardReader["verifyAt"]>[0];

function ownedLog(a: DanceLog, b: DanceLog) {
  return a.removed === false && b.removed === false && same(a.address, b.address) &&
    a.blockNumber === b.blockNumber && a.blockHash !== null && same(a.blockHash, b.blockHash ?? "") &&
    a.transactionHash !== null && same(a.transactionHash, b.transactionHash ?? "") &&
    a.transactionIndex === b.transactionIndex && a.logIndex === b.logIndex && same(a.data, b.data) &&
    a.topics.length === b.topics.length && a.topics.every((t, i) => same(b.topics[i], t));
}

/** Additive V2 categorical adapter. No source selection, scored fallback,
 * current-grant check, ticket operation, claim, nonce, signing or payment call.
 * The generic RPC helper is used only for blocks/receipts: all source state,
 * registrations and events below use the actual V2 ABI and V2 wire hashes. */
export function rewardDanceV2Reader(input: {
  source: DancePublicationSourceV2;
  client: PublicClient;
  proofs: RewardDanceV2Proofs;
}): CategoricalRewardReader {
  const source = structuredClone(input.source), { domain, pin } = source;
  insist(source.version === 2 && domain.chainId === 6343n &&
    typeof pin.deploymentBlock === "bigint" && pin.deploymentBlock >= 0n && pin.deploymentBlock <= maxUint64 &&
    pin.executionRule === keccak256(stringToHex("directory-current-publisher/1")) &&
    same(danceSourceHash(domain, pin), source.sourceHash), "dance_v2_source_pin_changed", 503);
  insist(typeof input.proofs?.retainedCapture === "function" &&
    typeof input.proofs?.authenticateSong === "function", "dance_v2_proofs_unavailable", 503);
  const retainedCapture = input.proofs.retainedCapture.bind(input.proofs);
  const authenticateSong = input.proofs.authenticateSong.bind(input.proofs);
  const client = input.client, rpc = danceReadPort(client);

  async function anchor(cutoff: Cutoff) {
    insist(BigInt(await rpc.chainId()) === domain.chainId, "dance_wrong_chain", 503);
    const safe = await rpc.safe();
    insist(typeof cutoff.number === "bigint" && cutoff.number >= pin.deploymentBlock &&
      cutoff.number <= maxUint64 && cutoff.number <= safe.number && digest(cutoff.hash) &&
      typeof cutoff.timestamp === "bigint" && cutoff.timestamp > 0n && cutoff.timestamp <= maxSeconds &&
      safe.timestamp >= cutoff.timestamp && digest(safe.hash), "dance_verdict_not_confirmed", 409);
    const block = await rpc.block(cutoff.number);
    insist(block.number === cutoff.number && same(block.hash, cutoff.hash) &&
      block.timestamp === cutoff.timestamp, "reward_results_head_changed", 503);
    return { block, safe };
  }
  async function unchanged(block: DanceBlock, safe: DanceBlock) {
    const [current, confirmed] = await Promise.all([rpc.block(block.number), rpc.block(safe.number)]);
    insist(current.number === block.number && same(current.hash, block.hash) &&
      current.timestamp === block.timestamp && confirmed.number === safe.number &&
      same(confirmed.hash, safe.hash) && confirmed.timestamp === safe.timestamp,
      "reward_results_head_changed", 503);
  }
  async function sourceAt(block: DanceBlock) {
    const at = { blockHash: block.hash, requireCanonical: true as const };
    const read = { address: domain.verifier, abi: danceVerdictsAbi, ...at } as const;
    const peers = [
      [domain.verifier, pin.runtimeCodeHash], [pin.directory, pin.directoryRuntimeHash],
      [pin.consentRegistry, pin.consentRegistryRuntimeHash], [pin.posts, pin.postsRuntimeHash],
      [source.capturePolicy, source.capturePolicyRuntimeHash],
    ] as const;
    const [version, hash, community, policy, policyHash, code] = await Promise.all([
      client.readContract({ ...read, functionName: "VERSION" }),
      client.readContract({ ...read, functionName: "sourceHash" }),
      client.readContract({ ...read, functionName: "communityId" }),
      client.readContract({ ...read, functionName: "capturePolicy" }),
      client.readContract({ ...read, functionName: "capturePolicyRuntimeHash" }),
      Promise.all(peers.map(([address]) => client.getCode({ address, ...at }))),
    ]);
    insist(version === 2 && same(hash, source.sourceHash) && same(community, domain.communityId) &&
      same(policy, source.capturePolicy) && same(policyHash, source.capturePolicyRuntimeHash) &&
      code.every((bytes, i) => bytes && bytes !== "0x" && same(keccak256(bytes), peers[i]![1])),
      "dance_v2_historical_runtime_changed", 503);
  }
  async function verdict(log: DanceLog, cutoff: DanceBlock) {
    const { blockNumber, blockHash, transactionHash, transactionIndex, logIndex } = log;
    insist(log.removed === false && same(log.address, domain.verifier) &&
      blockNumber !== null && blockNumber >= pin.deploymentBlock && blockNumber <= cutoff.number &&
      digest(blockHash) && digest(transactionHash) && position(transactionIndex) && position(logIndex),
      "dance_log_position_invalid", 503);
    const [block, receipt] = await Promise.all([rpc.block(blockNumber), rpc.receipt(transactionHash)]);
    insist(block.number === blockNumber && same(block.hash, blockHash) &&
      same(block.transactions[transactionIndex], transactionHash) && block.timestamp > 0n &&
      block.timestamp <= maxSeconds && block.timestamp <= cutoff.timestamp,
      "dance_verdict_reorged", 409);
    insist(receipt?.status === "success" && receipt.blockNumber === blockNumber &&
      same(receipt.blockHash, blockHash) && same(receipt.transactionHash, transactionHash) &&
      receipt.transactionIndex === transactionIndex, "dance_receipt_not_owned", 503);
    const owned = receipt.logs.filter(l => l.logIndex === logIndex);
    insist(owned.length === 1 && ownedLog(owned[0]!, log), "dance_receipt_log_not_owned", 503);
    insist(log.topics.length === 4 && same(log.topics[0], topic), "dance_v2_event_encoding_invalid", 503);
    const { args } = decodeEventLog({ abi: danceVerdictsAbi, eventName: "VerdictCommittedV2",
      data: log.data, topics: log.topics, strict: true });
    const { submissionId, commandId, learner, learnerAccountCommitment, sourceHash,
      verdict: decision, learnerPublicationGrantId, reviewerPublicationGrantId, configurationRevision } = args;
    const topics = encodeEventTopics({ abi: danceVerdictsAbi, eventName: "VerdictCommittedV2",
      args: { submissionId, commandId, learner } });
    insist(topics.every((t, i) => typeof t === "string" && same(log.topics[i], t)) &&
      same(log.data, encodeAbiParameters(eventData, [learnerAccountCommitment, sourceHash, decision,
        learnerPublicationGrantId, reviewerPublicationGrantId, configurationRevision])),
      "dance_v2_event_encoding_invalid", 503);
    insist(same(sourceHash, source.sourceHash) && digest(commandId) && digest(decision.commandHash) &&
      digest(decision.submissionHash) && digest(learnerAccountCommitment) &&
      digest(learnerPublicationGrantId) && digest(reviewerPublicationGrantId) && configurationRevision > 0n &&
      (decision.category === 1 || decision.category === 2) && decision.committedAtSeconds === block.timestamp,
      "dance_event_context_changed", 503);
    const [, registration] = await Promise.all([
      sourceAt(block),
      client.readContract({ address: domain.verifier, abi: danceVerdictsAbi, functionName: "registrationOf",
        args: [submissionId], blockHash: block.hash, requireCanonical: true }),
    ]);
    insist(same(registration[2], decision.submissionHash), "dance_registration_hash_changed", 503);
    const { capture, submission } = decodeDanceRegistration(domain, registration[0], registration[1], registration[2]);
    // Canonical event seconds become milliseconds exactly once. Retained wire
    // capture/submission/offer timestamps already use milliseconds.
    const completedMs = block.timestamp * 1000n;
    const within = decision.category === 1 && capture.offer.present &&
      completedMs >= capture.offer.opensAtMs && completedMs < capture.offer.cutoffAtMs;
    insist(same(submission.submissionId, submissionId) && same(capture.learner, learner) &&
      same(capture.accountCommitment, learnerAccountCommitment) &&
      same(capture.publicationGrantId, learnerPublicationGrantId) &&
      capture.identityEpoch > 0n && capture.reservedAtMs <= submission.trustedSubmittedAtMs &&
      completedMs >= submission.trustedSubmittedAtMs && completedMs < submission.reviewDeadlineMs &&
      decision.withinFrozenOfferWindow === within && capture.song.chainId === domain.chainId &&
      same(capture.song.communityId, domain.communityId) && same(capture.song.posts, pin.posts) &&
      same(capture.rulesSha256, pin.rulesSha256) && same(capture.termsSha256, pin.termsSha256) &&
      same(capture.rubricSha256, pin.rubricSha256) && same(capture.mediaPolicySha256, pin.mediaPolicySha256),
      "dance_verdict_binding_changed", 503);
    const evidenceHash = hashJson({ schema: "pirate.dance-reward-event/2", chainId: domain.chainId.toString(),
      verifier: domain.verifier.toLowerCase(), communityId: domain.communityId.toLowerCase(),
      sourceHash: source.sourceHash.toLowerCase(), blockNumber: blockNumber.toString(),
      blockHash: blockHash.toLowerCase(), transactionHash: transactionHash.toLowerCase(),
      transactionIndex, logIndex, data: log.data.toLowerCase(), topics: log.topics.map(t => t.toLowerCase()) });
    const again = await rpc.block(block.number);
    insist(again.number === block.number && same(again.hash, block.hash) && again.timestamp === block.timestamp,
      "dance_verdict_reorged", 409);
    return { capture, submission, block, within, completedAt: Number(completedMs), evidenceHash };
  }

  return {
    fromBlock: pin.deploymentBlock,
    async verifyAt(cutoff) {
      const { block, safe } = await anchor(structuredClone(cutoff));
      await sourceAt(block); await unchanged(block, safe);
      return hashJson({ schema: "pirate.dance-reward-policy-evidence/2", sourceHash: source.sourceHash,
        capturePolicy: source.capturePolicy, capturePolicyRuntimeHash: source.capturePolicyRuntimeHash });
    },
    async read(suppliedOffer, suppliedHash, fromBlock, suppliedCutoff) {
      const offer = structuredClone(offerInput(suppliedOffer)), inputHash = bytes32(suppliedHash);
      insist(hashJson(offer) === inputHash, "reward_offer_input_changed", 503);
      // An old offer without explicit resultSources never gains this reader.
      if (!offer.resultSources?.some(hash => same(hash, source.sourceHash))) return [];
      insist(new Set(offer.resultSources).size === offer.resultSources.length,
        "reward_offer_sources_invalid", 503);
      rewardTime(offer.opensAt); rewardTime(offer.cutoffAt);
      insist(offer.opensAt < offer.cutoffAt, "reward_offer_window_invalid", 503);
      const { block: cutoff, safe } = await anchor(structuredClone(suppliedCutoff));
      insist(safe.timestamp * 1000n >= BigInt(offer.cutoffAt) && cutoff.number < safe.number &&
        cutoff.timestamp * 1000n < BigInt(offer.cutoffAt), "reward_cutoff_not_confirmed", 409);
      insist(fromBlock >= pin.deploymentBlock && fromBlock <= cutoff.number &&
        cutoff.number - fromBlock <= 5_000_000n, "reward_results_scan_limit", 503);
      const [next, first, before] = await Promise.all([
        rpc.block(cutoff.number + 1n), rpc.block(fromBlock),
        fromBlock > pin.deploymentBlock ? rpc.block(fromBlock - 1n) : Promise.resolve(null),
      ]);
      insist(next.number === cutoff.number + 1n && next.timestamp * 1000n >= BigInt(offer.cutoffAt) &&
        next.timestamp > cutoff.timestamp, "reward_cutoff_not_indexable", 503);
      insist(first.number === fromBlock && first.timestamp <= cutoff.timestamp &&
        (before ? before.number === fromBlock - 1n && before.timestamp * 1000n < BigInt(offer.opensAt)
          : first.timestamp * 1000n <= BigInt(offer.opensAt)), "reward_history_starts_after_offer", 409);
      await sourceAt(cutoff);
      const positions = new Set<string>(), earliest = new Map<string, QualificationEntry>();
      let count = 0;
      for (let from = fromBlock; from <= cutoff.number; from += 10000n) {
        const to = from + 9999n < cutoff.number ? from + 9999n : cutoff.number;
        // Request raw logs with the exact V2 topic. ABI-filtering getLogs can
        // silently omit malformed matching events; every returned byte is checked.
        const logs = await client.request({ method: "eth_getLogs", params: [{ address: domain.verifier,
          topics: [topic], fromBlock: toHex(from), toBlock: toHex(to) }] });
        for (const raw of logs) {
          insist(++count <= 20000, "reward_entry_limit", 409);
          const log = formatLog(raw);
          insist(log.blockNumber !== null && log.blockNumber >= from && log.blockNumber <= to,
            "dance_log_position_invalid", 503);
          const key = `${log.blockNumber}:${log.transactionHash?.toLowerCase()}:${log.logIndex}`;
          insist(!positions.has(key), "dance_duplicate_verdict_log", 503); positions.add(key);
          const result = await verdict(log, cutoff), c = result.capture, bound = c.offer;
          if (!result.within || !bound.present ||
            !same(bound.offerIdCommitment, danceOfferId(domain, offer.offerId)) ||
            !same(bound.inputHash, inputHash) || !same(bound.sourceHash, source.sourceHash) ||
            bound.opensAtMs !== BigInt(offer.opensAt) || bound.cutoffAtMs !== BigInt(offer.cutoffAt) ||
            songKeyOf({ ...c.song, chainId: Number(c.song.chainId) }) !== offer.songKey ||
            result.completedAt < offer.opensAt || result.completedAt >= offer.cutoffAt) continue;
          const [retained, songVerified] = await Promise.all([
            retainedCapture({ sourceHash: source.sourceHash, captureId: c.captureId, captureHash: result.submission.captureHash }),
            authenticateSong(structuredClone(c.song), result.block.number, result.block.hash),
          ]);
          insist(songVerified, "dance_historical_song_unverified", 503);
          let valid = false;
          if (retained && uuid(retained.accountId)) {
            valid = same(danceCaptureHash(domain, retained.capture), result.submission.captureHash) &&
              same(danceAccountCommitment(domain, retained.accountId, c.learner), c.accountCommitment);
          }
          insist(retained && valid, "dance_v2_retained_capture_unverified", 503);
          const entry: QualificationEntry = { accountId: retained.accountId, wallet: c.learner.toLowerCase(),
            evidenceHash: result.evidenceHash, completedAt: result.completedAt };
          const prior = earliest.get(entry.accountId);
          insist(!prior || prior.wallet === entry.wallet, "reward_qualifier_wallet_changed", 409);
          if (!prior || entry.completedAt < prior.completedAt ||
            (entry.completedAt === prior.completedAt && entry.evidenceHash < prior.evidenceHash)) earliest.set(entry.accountId, entry);
        }
      }
      await unchanged(cutoff, safe);
      return [...earliest.values()].sort((a, b) => a.completedAt - b.completedAt ||
        (a.evidenceHash < b.evidenceHash ? -1 : a.evidenceHash > b.evidenceHash ? 1 : 0));
    },
  };
}
