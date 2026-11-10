// One frozen controller operation. The caller holds signer-wide dispatch custody.
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { insist } from "../../packages/community/common.ts";
import type { TxStore } from "../../services/operator-tx.ts";
import { observeCorrection } from "./study-correction-observation.ts";
import { readControllerInventory } from "./controller-inventory.ts";
import {
  correctionIntent,
  correctionWindow,
  type StudyCorrectionProfile,
} from "./study-correction-plan.ts";

export interface CorrectionTransaction {
  profileHash: Hex;
  nonce: number;
  gasPriceWei: string;
  maximumFeeWei: string;
  raw?: Hex;
  hash?: Hex;
  receipt?: { blockNumber: string; blockHash: Hex; status: string };
}
const notFound = (error: unknown) => {
  if ((error as Error).name !== "TransactionReceiptNotFoundError") throw error;
  return null;
};
export async function correctionStatus(
  client: PublicClient,
  profile: StudyCorrectionProfile,
  stored?: CorrectionTransaction,
) {
  const intent = correctionIntent(profile);
  insist(
    !stored ||
      (stored.profileHash === intent.profileHash &&
        stored.nonce === profile.nonce &&
        stored.maximumFeeWei === intent.maximumFeeWei),
    "correction_journal_profile_changed",
  );
  insist((await client.getChainId()) === 6343, "correction_wrong_chain");
  if (stored?.raw) {
    const tx = parseTransaction(stored.raw);
    insist(
      tx.chainId === 6343 &&
        tx.nonce === profile.nonce &&
        tx.to?.toLowerCase() === profile.contract.toLowerCase() &&
        tx.data === intent.data &&
        tx.gas === BigInt(profile.gas) &&
        tx.gasPrice === BigInt(stored.gasPriceWei) &&
        (tx.value ?? 0n) === 0n &&
        (
          await recoverTransactionAddress({
            serializedTransaction: stored.raw as TransactionSerialized,
          })
        ).toLowerCase() === profile.controller.toLowerCase(),
      "correction_journal_transaction_changed",
    );
  }
  if (!stored?.hash) return { state: stored ? "prepared" : "unallocated" };
  insist(
    stored.raw && keccak256(stored.raw) === stored.hash,
    "correction_journal_bytes_changed",
  );
  const receipt = await client
    .getTransactionReceipt({ hash: stored.hash })
    .catch(notFound);
  if (!receipt) return { state: "unknown", hash: stored.hash };
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(
    receipt.transactionHash === stored.hash &&
      (await client.getBlock({ blockNumber: receipt.blockNumber })).hash ===
        receipt.blockHash,
    "correction_receipt_not_canonical",
  );
  return {
    state:
      receipt.blockNumber + 11n <= head
        ? receipt.status === "success"
          ? "confirmed"
          : "reverted"
        : "confirming",
    hash: stored.hash,
    receipt: {
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      status: receipt.status,
    },
  };
}
export async function runCorrection(
  client: PublicClient,
  profile: StudyCorrectionProfile,
  journal: TxStore,
  loadKey: () => Hex,
  now = () => Date.now(),
  beforeKey?: (stored: CorrectionTransaction) => void,
) {
  const intent = correctionIntent(profile);
  const old = journal.get<CorrectionTransaction>("correction");
  const status = await correctionStatus(client, profile, old);
  if (
    status.state === "confirmed" ||
    status.state === "reverted" ||
    status.state === "confirming"
  ) {
    if (old && status.receipt)
      journal.set("correction", { ...old, receipt: status.receipt });
    return status;
  }
  const observation = await observeCorrection(client, profile);
  insist(
    observation.currentCommitment === profile.previous.commitment,
    "correction_already_changed_without_receipt",
  );
  await readControllerInventory(
    client,
    profile,
    BigInt(observation.head.number),
  );
  correctionWindow(profile, now());
  if (
    old?.hash &&
    observation.latestNonce === profile.nonce &&
    observation.pendingNonce === profile.nonce + 1
  ) {
    const pending = await client.getTransaction({ hash: old.hash });
    insist(
      pending.hash === old.hash &&
        pending.from.toLowerCase() === profile.controller.toLowerCase() &&
        pending.nonce === profile.nonce &&
        pending.chainId === 6343 &&
        pending.to?.toLowerCase() === profile.contract.toLowerCase() &&
        pending.input === intent.data &&
        pending.gas === BigInt(profile.gas) &&
        pending.gasPrice === BigInt(old.gasPriceWei) &&
        pending.value === 0n &&
        pending.blockHash === null,
      "correction_pending_conflict",
    );
    return { state: "pending", hash: old.hash };
  }
  insist(
    observation.latestNonce === profile.nonce &&
      observation.pendingNonce === profile.nonce,
    "correction_nonce_not_quiescent",
  );
  const gas = await client.estimateGas({
    account: profile.controller,
    to: intent.to,
    data: intent.data,
  });
  insist(gas <= BigInt(profile.gas), "correction_gas_limit");
  insist(
    (await client.getBalance({ address: profile.controller })) >=
      BigInt(intent.maximumFeeWei),
    "correction_insufficient_balance",
  );
  let stored = old;
  if (!stored) {
    // Persist a conservative lifetime charge and fixed nonce before key access.
    // Uncertain/reverted work is never refunded and cannot allocate another nonce.
    stored = {
      profileHash: intent.profileHash,
      nonce: profile.nonce,
      gasPriceWei: observation.gasPriceWei,
      maximumFeeWei: intent.maximumFeeWei,
    };
    journal.transaction(() => {
      insist(!journal.get("correction"), "correction_already_prepared");
      journal.set("correction", stored);
    });
  }
  insist(
    stored.profileHash === intent.profileHash &&
      stored.nonce === profile.nonce &&
      stored.maximumFeeWei === intent.maximumFeeWei &&
      BigInt(stored.gasPriceWei) > 0n &&
      BigInt(stored.gasPriceWei) <= BigInt(profile.maximumGasPriceWei),
    "correction_journal_changed",
  );
  beforeKey?.(stored);
  if (!stored.raw) {
    correctionWindow(profile, now());
    const key = loadKey();
    insist(
      /^0x[0-9a-f]{64}$/i.test(key) && BigInt(key) > 10n,
      "correction_fixture_key_refused",
    );
    const account = privateKeyToAccount(key);
    insist(
      account.address.toLowerCase() === profile.controller.toLowerCase(),
      "correction_key_wrong_controller",
    );
    const raw = await account.signTransaction({
      type: "legacy",
      chainId: 6343,
      nonce: profile.nonce,
      to: intent.to,
      data: intent.data,
      gas: BigInt(profile.gas),
      gasPrice: BigInt(stored.gasPriceWei),
      value: 0n,
    });
    stored = { ...stored, raw, hash: keccak256(raw) };
    journal.set("correction", stored);
  }
  insist(
    stored.hash && keccak256(stored.raw!) === stored.hash,
    "correction_signed_bytes_changed",
  );
  const feeAbi = parseAbi([
    "function getL1Fee(bytes data) view returns (uint256)",
  ]);
  const fee = await client.call({
    to: "0x420000000000000000000000000000000000000F",
    data: encodeFunctionData({
      abi: feeAbi,
      functionName: "getL1Fee",
      args: [stored.raw!],
    }),
  });
  insist(
    fee.data &&
      decodeFunctionResult({
        abi: feeAbi,
        functionName: "getL1Fee",
        data: fee.data,
      }) <= BigInt(profile.dataFeeReserveWei),
    "correction_data_fee_cap",
  );
  // Repeat every public/custody boundary after signing and immediately before
  // broadcast. Legacy runners do not share this lock; custody must stop them.
  const fresh = await observeCorrection(client, profile);
  await readControllerInventory(client, profile, BigInt(fresh.head.number));
  insist(
    fresh.currentCommitment === profile.previous.commitment &&
      fresh.latestNonce === profile.nonce &&
      fresh.pendingNonce === profile.nonce,
    "correction_prebroadcast_state_changed",
  );
  correctionWindow(profile, now());
  try {
    insist(
      (await client.sendRawTransaction({
        serializedTransaction: stored.raw!,
      })) === stored.hash,
      "correction_broadcast_hash_changed",
    );
  } catch (error) {
    // The outcome is unknown, not permission to sign a replacement. Let status
    // and a later same-profile invocation reconcile these exact signed bytes.
    return {
      state: "unknown",
      hash: stored.hash,
      reason: (error as Error).name,
    };
  }
  return correctionStatus(client, profile, stored);
}
