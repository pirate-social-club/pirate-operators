// One frozen operation under the shared controller lease. No replacement sends.
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type PublicClient,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { insist } from "../../packages/community/common.ts";
import type { TxStore } from "../../services/operator-tx.ts";
import { readControllerInventory } from "./controller-inventory.ts";
import type { CorrectionTransaction } from "./study-correction-runner.ts";
import type { StudyDeploymentArtifact } from "./study-deployment-artifact.ts";
import {
  studyDeploymentPlan,
  studyDeploymentWindow,
  type StudyDeploymentOperation,
  type StudyDeploymentProfile,
} from "./study-deployment-plan.ts";
import { observeStudyDeployment } from "./study-deployment-observation.ts";
import type { IpfsTransport } from "../../packages/community/ipfs.ts";

export type StudyDeploymentTransaction = CorrectionTransaction;
function validateStored(
  operation: StudyDeploymentOperation,
  stored?: StudyDeploymentTransaction,
) {
  insist(
    !stored ||
      (stored.profileHash === operation.profileHash &&
        stored.nonce === operation.nonce &&
        stored.maximumFeeWei === operation.maximumFeeWei),
    "study_deployment_journal_profile_changed",
  );
  insist(
    !stored ||
      (BigInt(stored.gasPriceWei) > 0n &&
        BigInt(stored.gasPriceWei) <= BigInt(operation.maximumGasPriceWei)),
    "study_deployment_journal_price_changed",
  );
}
export async function studyDeploymentStatus(
  client: PublicClient,
  operation: StudyDeploymentOperation,
  stored?: StudyDeploymentTransaction,
) {
  validateStored(operation, stored);
  insist((await client.getChainId()) === 6343, "study_deployment_wrong_chain");
  if (stored?.raw) {
    const tx = parseTransaction(stored.raw);
    insist(
      tx.chainId === 6343 &&
        tx.nonce === operation.nonce &&
        (tx.to?.toLowerCase() ?? null) ===
          (operation.to?.toLowerCase() ?? null) &&
        tx.data === operation.data &&
        tx.gas === BigInt(operation.gas) &&
        tx.gasPrice === BigInt(stored.gasPriceWei) &&
        (tx.value ?? 0n) === 0n &&
        (
          await recoverTransactionAddress({
            serializedTransaction: stored.raw as TransactionSerialized,
          })
        ).toLowerCase() === operation.controller.toLowerCase(),
      "study_deployment_journal_transaction_changed",
    );
  }
  if (!stored?.hash) return { state: stored ? "prepared" : "unallocated" };
  insist(
    stored.raw && keccak256(stored.raw) === stored.hash,
    "study_deployment_signed_bytes_changed",
  );
  const receipt = await client
    .getTransactionReceipt({ hash: stored.hash })
    .catch((error) => {
      if ((error as Error).name !== "TransactionReceiptNotFoundError")
        throw error;
      return null;
    });
  if (!receipt) return { state: "unknown", hash: stored.hash };
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(
    receipt.transactionHash === stored.hash &&
      (await client.getBlock({ blockNumber: receipt.blockNumber })).hash ===
        receipt.blockHash,
    "study_deployment_receipt_not_canonical",
  );
  if (!operation.to && receipt.status === "success")
    insist(
      receipt.contractAddress?.toLowerCase() ===
        operation.contractAddress?.toLowerCase(),
      "study_deployment_receipt_address_changed",
    );
  return {
    state:
      receipt.blockNumber + 11n > head
        ? "confirming"
        : receipt.status === "success"
          ? "confirmed"
          : "reverted",
    hash: stored.hash,
    receipt: {
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      status: receipt.status,
    },
  };
}
export async function runStudyDeploymentOperation(
  client: PublicClient,
  profile: StudyDeploymentProfile,
  artifact: StudyDeploymentArtifact,
  operation: StudyDeploymentOperation,
  journal: TxStore,
  loadKey: () => Hex,
  beforeKey: (stored: StudyDeploymentTransaction) => void,
  now = () => Date.now(),
  transport?: IpfsTransport,
) {
  const plan = studyDeploymentPlan(profile, artifact);
  const expected = plan.operations.find((row) => row.step === operation.step);
  insist(
    expected && JSON.stringify(expected) === JSON.stringify(operation),
    "study_deployment_operation_changed",
  );
  const old = journal.get<StudyDeploymentTransaction>("deployment");
  const status = await studyDeploymentStatus(client, operation, old);
  if (["confirmed", "confirming", "reverted"].includes(status.state)) {
    if (old && status.receipt)
      journal.set("deployment", { ...old, receipt: status.receipt });
    return status;
  }
  const observation = await observeStudyDeployment(
    client,
    profile,
    artifact,
    operation,
    transport,
  );
  await readControllerInventory(
    client,
    profile,
    BigInt(observation.head.number),
  );
  studyDeploymentWindow(profile, now());
  if (
    old?.hash &&
    observation.latestNonce === operation.nonce &&
    observation.pendingNonce === operation.nonce + 1
  ) {
    const pending = await client.getTransaction({ hash: old.hash });
    insist(
      pending.hash === old.hash &&
        pending.from.toLowerCase() === profile.controller.toLowerCase() &&
        pending.nonce === operation.nonce &&
        pending.chainId === 6343 &&
        (pending.to?.toLowerCase() ?? null) ===
          (operation.to?.toLowerCase() ?? null) &&
        pending.input === operation.data &&
        pending.gas === BigInt(operation.gas) &&
        pending.gasPrice === BigInt(old.gasPriceWei) &&
        pending.value === 0n &&
        pending.blockHash === null,
      "study_deployment_pending_conflict",
    );
    return { state: "pending", hash: old.hash };
  }
  insist(
    observation.latestNonce === operation.nonce &&
      observation.pendingNonce === operation.nonce,
    "study_deployment_nonce_not_quiescent",
  );
  const estimate = await client.estimateGas({
    account: profile.controller,
    ...(operation.to ? { to: operation.to } : {}),
    data: operation.data,
  });
  insist(estimate <= BigInt(operation.gas), "study_deployment_gas_limit");
  insist(
    (await client.getBalance({ address: profile.controller })) >=
      BigInt(operation.maximumFeeWei),
    "study_deployment_insufficient_balance",
  );
  let stored = old;
  if (!stored) {
    stored = {
      profileHash: operation.profileHash,
      nonce: operation.nonce,
      gasPriceWei: observation.gasPriceWei,
      maximumFeeWei: operation.maximumFeeWei,
    };
    journal.transaction(() => {
      insist(!journal.get("deployment"), "study_deployment_already_prepared");
      journal.set("deployment", stored);
    });
  }
  validateStored(operation, stored);
  insist(
    BigInt(stored.gasPriceWei) > 0n &&
      BigInt(stored.gasPriceWei) <= BigInt(profile.maximumGasPriceWei),
    "study_deployment_journal_price_changed",
  );
  beforeKey(stored);
  if (!stored.raw) {
    studyDeploymentWindow(profile, now());
    const key = loadKey();
    insist(
      /^0x[0-9a-f]{64}$/i.test(key) && BigInt(key) > 10n,
      "study_deployment_fixture_key_refused",
    );
    const account = privateKeyToAccount(key);
    insist(
      account.address.toLowerCase() === profile.controller.toLowerCase(),
      "study_deployment_key_wrong_controller",
    );
    const raw = await account.signTransaction({
      type: "legacy",
      chainId: 6343,
      nonce: operation.nonce,
      ...(operation.to ? { to: operation.to } : {}),
      data: operation.data,
      gas: BigInt(operation.gas),
      gasPrice: BigInt(stored.gasPriceWei),
      value: 0n,
    });
    stored = { ...stored, raw, hash: keccak256(raw) };
    journal.set("deployment", stored);
  }
  insist(
    stored.raw && stored.hash && keccak256(stored.raw) === stored.hash,
    "study_deployment_signed_bytes_changed",
  );
  const feeAbi = parseAbi([
    "function getL1Fee(bytes data) view returns (uint256)",
  ]);
  const fee = await client.call({
    to: "0x420000000000000000000000000000000000000F",
    data: encodeFunctionData({
      abi: feeAbi,
      functionName: "getL1Fee",
      args: [stored.raw],
    }),
  });
  insist(
    fee.data &&
      decodeFunctionResult({
        abi: feeAbi,
        functionName: "getL1Fee",
        data: fee.data,
      }) <= BigInt(profile.dataFeeReserveWei),
    "study_deployment_data_fee_cap",
  );
  const fresh = await observeStudyDeployment(
    client,
    profile,
    artifact,
    operation,
    transport,
  );
  await readControllerInventory(client, profile, BigInt(fresh.head.number));
  insist(
    fresh.latestNonce === operation.nonce &&
      fresh.pendingNonce === operation.nonce,
    "study_deployment_prebroadcast_state_changed",
  );
  studyDeploymentWindow(profile, now());
  try {
    insist(
      (await client.sendRawTransaction({
        serializedTransaction: stored.raw,
      })) === stored.hash,
      "study_deployment_broadcast_hash_changed",
    );
  } catch (error) {
    return {
      state: "unknown",
      hash: stored.hash,
      reason: (error as Error).name,
    };
  }
  return studyDeploymentStatus(client, operation, stored);
}
