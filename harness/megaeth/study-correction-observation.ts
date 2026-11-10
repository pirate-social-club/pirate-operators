// Read-only proof for a frozen manual controller operation.
import { keccak256, parseAbi, type PublicClient } from "viem";
import { insist } from "../../packages/community/common.ts";
import { directoryAbi } from "../../packages/community/directory-reader.ts";
import {
  resultsV3Abi,
  resultCommitment,
} from "../../packages/protocol/learning-results-v3.ts";
import {
  correctionIntent,
  type StudyCorrectionProfile,
} from "./study-correction-plan.ts";
const lower = (v: string) => v.toLowerCase();

/** The receipt proves the supplied previous event; latest state is pinned to a
 * canonical block. A current commitment alone cannot authenticate its metadata. */
export async function observeCorrection(
  client: PublicClient,
  profile: StudyCorrectionProfile,
) {
  const intent = correctionIntent(profile);
  insist((await client.getChainId()) === 6343, "correction_wrong_chain");
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(
    head >= BigInt(profile.previous.blockNumber) + 11n,
    "correction_previous_not_confirmed",
  );
  const blockNumber = head - 1n;
  const [
    block,
    directoryCode,
    code,
    row,
    version,
    controller,
    community,
    publicity,
    current,
    receipt,
    priorBlock,
    gasPrice,
    latestNonce,
    pendingNonce,
  ] = await Promise.all([
    client.getBlock({ blockNumber }),
    client.getCode({ address: profile.directory, blockNumber }),
    client.getCode({ address: profile.contract, blockNumber }),
    client.readContract({
      address: profile.directory,
      abi: directoryAbi,
      functionName: "getCommunity",
      args: [profile.communityId],
      blockNumber,
    }),
    client.readContract({
      address: profile.contract,
      abi: resultsV3Abi,
      functionName: "VERSION",
      blockNumber,
    }),
    client.readContract({
      address: profile.contract,
      abi: parseAbi(["function controller() view returns (address)"]),
      functionName: "controller",
      blockNumber,
    }),
    client.readContract({
      address: profile.contract,
      abi: resultsV3Abi,
      functionName: "communityId",
      blockNumber,
    }),
    client.readContract({
      address: profile.contract,
      abi: resultsV3Abi,
      functionName: "publicityPolicy",
      blockNumber,
    }),
    client.readContract({
      address: profile.contract,
      abi: resultsV3Abi,
      functionName: "commitments",
      args: [profile.previous.result.sessionId],
      blockNumber,
    }),
    client.getTransactionReceipt({ hash: profile.previous.transactionHash }),
    client.getBlock({ blockNumber: BigInt(profile.previous.blockNumber) }),
    client.getGasPrice(),
    client.getTransactionCount({
      address: profile.controller,
      blockTag: "latest",
    }),
    client.getTransactionCount({
      address: profile.controller,
      blockTag: "pending",
    }),
  ]);
  insist(
    directoryCode &&
      keccak256(directoryCode) === profile.directoryCodeHash &&
      code &&
      keccak256(code) === profile.codeHash,
    "correction_code_changed",
  );
  insist(
    lower(row.registry) === lower(profile.registry) &&
      row.configurationRevision.toString() === profile.configurationRevision &&
      lower(row.configuration.learningRecords) === lower(profile.contract) &&
      lower(row.configuration.controller) === lower(profile.controller),
    "correction_registration_changed",
  );
  insist(
    version === 3 &&
      lower(controller) === lower(profile.controller) &&
      community === profile.communityId &&
      publicity === profile.publicityPolicy,
    "correction_contract_changed",
  );
  insist(
    current === profile.previous.commitment || current === intent.commitment,
    "correction_current_commitment_changed",
  );
  const event = receipt.logs.find(
    (log) => log.logIndex === profile.previous.logIndex,
  );
  const { decodeEventLog } = await import("viem");
  insist(
    receipt.transactionHash === profile.previous.transactionHash &&
      receipt.status === "success" &&
      receipt.blockHash === profile.previous.blockHash &&
      priorBlock.hash === receipt.blockHash &&
      receipt.blockNumber.toString() === profile.previous.blockNumber &&
      event &&
      lower(event.address) === lower(profile.contract),
    "correction_previous_not_canonical",
  );
  const decoded = decodeEventLog({
    abi: resultsV3Abi,
    eventName: "ResultPublished",
    data: event.data,
    topics: event.topics,
  });
  insist(
    decoded.args.commitment === profile.previous.commitment &&
      resultCommitment(decoded.args.result, decoded.args.outcomes) ===
        profile.previous.commitment,
    "correction_previous_event_changed",
  );
  insist(
    gasPrice > 0n && gasPrice <= BigInt(profile.maximumGasPriceWei),
    "correction_gas_price_cap",
  );
  insist(
    (await client.getBlock({ blockNumber })).hash === block.hash,
    "correction_head_changed",
  );
  return {
    intent,
    head: { number: blockNumber.toString(), hash: block.hash! },
    currentCommitment: current,
    gasPriceWei: gasPrice.toString(),
    latestNonce,
    pendingNonce,
  };
}
