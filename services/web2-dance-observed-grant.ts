import { keccak256, toHex, type PublicClient } from "viem";
import { canonical, insist } from "../packages/community/common.ts";
import { digest } from "../packages/protocol/index.ts";
import { capturedFee, exact, parseCommand, preparedCall, record, signature } from "./publication-command-contract.ts";
import { verifyPublicationCommandEvent } from "./publication-command-events.ts";
import { parsePublicationReceipt } from "./publication-app-transport.ts";

export type ObservedDanceGrant = Readonly<{
  command: ReturnType<typeof parseCommand>;
  receipt: ReturnType<typeof parsePublicationReceipt>;
  signature: ReturnType<typeof signature>;
  acceptedJson: string;
}>;

/** Recheck the already recorded grant against its canonical transaction and
 * exact V5 event. This does not advance the app or operator journal. */
export async function verifyObservedDanceGrant(client: PublicClient, evidence: ObservedDanceGrant) {
  const command = parseCommand(evidence.command), sig = signature(evidence.signature);
  const accepted = record(JSON.parse(evidence.acceptedJson));
  exact(accepted, ["command", "signature", "fee"]);
  const fee = capturedFee(accepted.fee);
  insist(command.action === "grant" && command.source.chainId === 6343 && fee.chainId === command.source.chainId &&
    canonical({ command, signature: sig, fee }) === evidence.acceptedJson, "dance_activation_grant_original_changed", 503);
  const proof = parsePublicationReceipt(evidence.receipt, command);
  insist(proof.state === "recorded" && proof.transactionHash &&
    proof.observed && typeof proof.transactionIndex === "number", "dance_activation_grant_observation_required", 503);
  const hash = proof.transactionHash, height = BigInt(proof.observed.blockNumber), index = proof.transactionIndex;
  const call = preparedCall(command, sig);
  insist(call.digest === command.digest, "dance_activation_grant_original_changed", 503);

  const [receipt, transaction, block, safe, chainId] = await Promise.all([
    client.getTransactionReceipt({ hash }), client.getTransaction({ hash }), client.getBlock({ blockNumber: height }),
    client.getBlock({ blockTag: "safe" }), client.getChainId(),
  ]);
  insist(chainId === command.source.chainId && safe.number >= height &&
    block.number === height && block.hash === proof.observed.blockHash &&
    block.timestamp === BigInt(proof.observed.timestampS) && block.transactions[index] === hash &&
    receipt.status === "success" && receipt.transactionHash === hash && receipt.transactionIndex === index &&
    receipt.blockNumber === height && receipt.blockHash === block.hash &&
    receipt.from.toLowerCase() === fee.payer && receipt.to?.toLowerCase() === command.source.registry &&
    transaction.hash === hash && transaction.blockNumber === height && transaction.blockHash === block.hash &&
    transaction.transactionIndex === index && transaction.from.toLowerCase() === fee.payer &&
    transaction.to?.toLowerCase() === command.source.registry && transaction.input === call.data && transaction.value === 0n,
    "dance_activation_grant_observation_changed", 503);

  const code = await client.getCode({ address: command.source.registry, blockHash: block.hash, requireCanonical: true });
  insist(code && keccak256(code) === command.source.registryRuntimeHash, "dance_activation_grant_registry_changed", 503);
  verifyPublicationCommandEvent({
    schema: "pirate.publication-queued/1", command, signature: sig, fee,
    kind: "record_publication_grant", ref: command.commandId, data: call.data, bodyHash: digest(accepted),
  }, {
    transactionHash: hash, blockNumber: toHex(height), transactionIndex: toHex(index), blockHash: block.hash,
    from: receipt.from, to: receipt.to, status: "0x1",
    logs: receipt.logs.map(log => ({
      address: log.address, data: log.data, topics: log.topics, removed: log.removed,
      transactionHash: log.transactionHash, blockHash: log.blockHash,
      blockNumber: toHex(log.blockNumber), transactionIndex: toHex(log.transactionIndex),
    })),
  }, block.timestamp);

  const [confirmed, sameSafe] = await Promise.all([
    client.getBlock({ blockNumber: height }), client.getBlock({ blockNumber: safe.number }),
  ]);
  insist(confirmed.hash === block.hash && confirmed.timestamp === block.timestamp &&
    sameSafe.hash === safe.hash && sameSafe.timestamp === safe.timestamp, "dance_activation_grant_observation_changed", 503);
  return command.digest;
}
