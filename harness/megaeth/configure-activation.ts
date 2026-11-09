// One frozen directory configure under the shared controller lease, shared by
// the configuration activations. No replacement sends and no second
// allocation: a lost response is reconciled from the journaled signed bytes.
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
import { canonical, insist, object } from "../../packages/community/common.ts";
import type { TxStore } from "../../services/operator-tx.ts";
import {
  addPin,
  reconcilePin,
  type IpfsTransport,
  type PinIntent,
} from "../../packages/community/ipfs.ts";
/** The journaled configure: unsigned intent first, then signed bytes. */
export interface ActivationTransaction {
  profileHash: Hex;
  nonce: number;
  gasPriceWei: string;
  maximumFeeWei: string;
  raw?: Hex;
  hash?: Hex;
  receipt?: { blockNumber: string; blockHash: Hex; status: string };
}
export interface ActivationOperation {
  profileHash: Hex;
  step: "configure";
  controller: Hex;
  nonce: number;
  journalKey: "deployment";
  to: Hex;
  contractAddress?: Hex;
  data: Hex;
  gas: string;
  maximumGasPriceWei: string;
  maximumFeeWei: string;
}
export interface ActivationObservation {
  head: { number: string };
  latestNonce: number;
  pendingNonce: number;
  gasPriceWei: string;
}
/** Activation-specific checks the shared runner calls at fixed points. */
export interface ActivationHooks {
  /** Error-code prefix, such as study_activation. */
  prefix: string;
  controller: Hex;
  maximumGasPriceWei: string;
  dataFeeReserveWei: string;
  /** The operation re-derived from the current profile and source. */
  expected(): Promise<ActivationOperation>;
  /** Block-pinned predecessor state; the configuration must be unchanged. */
  observe(): Promise<ActivationObservation>;
  inventory(head: bigint): Promise<unknown>;
  window(now: number): void;
  /** Fresh independent readiness and unchanged source. */
  ready(now: number): void;
}

function validateStored(
  prefix: string,
  operation: ActivationOperation,
  stored?: ActivationTransaction,
) {
  insist(
    !stored ||
      (stored.profileHash === operation.profileHash &&
        stored.nonce === operation.nonce &&
        stored.maximumFeeWei === operation.maximumFeeWei),
    `${prefix}_journal_profile_changed`,
  );
  insist(
    !stored ||
      (BigInt(stored.gasPriceWei) > 0n &&
        BigInt(stored.gasPriceWei) <= BigInt(operation.maximumGasPriceWei)),
    `${prefix}_journal_price_changed`,
  );
}

export async function activationStatus(
  prefix: string,
  client: PublicClient,
  operation: ActivationOperation,
  stored?: ActivationTransaction,
) {
  validateStored(prefix, operation, stored);
  insist((await client.getChainId()) === 6343, `${prefix}_wrong_chain`);
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
      `${prefix}_journal_transaction_changed`,
    );
  }
  if (!stored?.hash) return { state: stored ? "prepared" : "unallocated" };
  insist(
    stored.raw && keccak256(stored.raw) === stored.hash,
    `${prefix}_signed_bytes_changed`,
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
    `${prefix}_receipt_not_canonical`,
  );
  if (!operation.to && receipt.status === "success")
    insist(
      receipt.contractAddress?.toLowerCase() ===
        operation.contractAddress?.toLowerCase(),
      `${prefix}_receipt_address_changed`,
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

export async function runActivationOperation(
  hooks: ActivationHooks,
  client: PublicClient,
  operation: ActivationOperation,
  journal: TxStore,
  loadKey: () => Hex,
  beforeKey: (stored: ActivationTransaction) => void,
  now = () => Date.now(),
) {
  const prefix = hooks.prefix;
  const expected = await hooks.expected();
  insist(
    expected && JSON.stringify(expected) === JSON.stringify(operation),
    `${prefix}_operation_changed`,
  );
  const old = journal.get<ActivationTransaction>("deployment");
  const status = await activationStatus(prefix, client, operation, old);
  if (["confirmed", "confirming", "reverted"].includes(status.state)) {
    if (old && status.receipt)
      journal.set("deployment", { ...old, receipt: status.receipt });
    return status;
  }
  const observation = await hooks.observe();
  await hooks.inventory(BigInt(observation.head.number));
  hooks.window(now());
  if (
    old?.hash &&
    observation.latestNonce === operation.nonce &&
    observation.pendingNonce === operation.nonce + 1
  ) {
    const pending = await client.getTransaction({ hash: old.hash });
    insist(
      pending.hash === old.hash &&
        pending.from.toLowerCase() === hooks.controller.toLowerCase() &&
        pending.nonce === operation.nonce &&
        pending.chainId === 6343 &&
        (pending.to?.toLowerCase() ?? null) ===
          (operation.to?.toLowerCase() ?? null) &&
        pending.input === operation.data &&
        pending.gas === BigInt(operation.gas) &&
        pending.gasPrice === BigInt(old.gasPriceWei) &&
        pending.value === 0n &&
        pending.blockHash === null,
      `${prefix}_pending_conflict`,
    );
    return { state: "pending", hash: old.hash };
  }
  insist(
    observation.latestNonce === operation.nonce &&
      observation.pendingNonce === operation.nonce,
    `${prefix}_nonce_not_quiescent`,
  );
  const estimate = await client.estimateGas({
    account: hooks.controller,
    ...(operation.to ? { to: operation.to } : {}),
    data: operation.data,
  });
  insist(estimate <= BigInt(operation.gas), `${prefix}_gas_limit`);
  insist(
    (await client.getBalance({ address: hooks.controller })) >=
      BigInt(operation.maximumFeeWei),
    `${prefix}_insufficient_balance`,
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
      insist(!journal.get("deployment"), `${prefix}_already_prepared`);
      journal.set("deployment", stored);
    });
  }
  validateStored(prefix, operation, stored);
  insist(
    BigInt(stored.gasPriceWei) > 0n &&
      BigInt(stored.gasPriceWei) <= BigInt(hooks.maximumGasPriceWei),
    `${prefix}_journal_price_changed`,
  );
  hooks.ready(now());
  beforeKey(stored);
  if (!stored.raw) {
    hooks.window(now());
    const key = loadKey();
    insist(
      /^0x[0-9a-f]{64}$/i.test(key) && BigInt(key) > 10n,
      `${prefix}_fixture_key_refused`,
    );
    const account = privateKeyToAccount(key);
    insist(
      account.address.toLowerCase() === hooks.controller.toLowerCase(),
      `${prefix}_key_wrong_controller`,
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
    `${prefix}_signed_bytes_changed`,
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
      }) <= BigInt(hooks.dataFeeReserveWei),
    `${prefix}_data_fee_cap`,
  );
  const fresh = await hooks.observe();
  await hooks.inventory(BigInt(fresh.head.number));
  insist(
    fresh.latestNonce === operation.nonce &&
      fresh.pendingNonce === operation.nonce,
    `${prefix}_prebroadcast_state_changed`,
  );
  hooks.window(now());
  hooks.ready(now());
  try {
    insist(
      (await client.sendRawTransaction({
        serializedTransaction: stored.raw,
      })) === stored.hash,
      `${prefix}_broadcast_hash_changed`,
    );
  } catch (error) {
    return {
      state: "unknown",
      hash: stored.hash,
      reason: (error as Error).name,
    };
  }
  return activationStatus(prefix, client, operation, stored);
}

/** Content-addressed pin journal: a changed execution window never adds again. */
export async function pinActivationManifest(
  prefix: string,
  window: (now: number) => void,
  plan: { pin: PinIntent; bytes: Uint8Array },
  journal: TxStore,
  secret: () => Promise<string>,
  now: () => number,
  transport?: IpfsTransport,
) {
  window(now());
  const old = journal.get<unknown>("activation-pin");
  let saved = old === undefined ? undefined : object(old);
  if (saved)
    insist(
      canonical(saved.pin) === canonical(plan.pin) &&
        ["dispatched", "received", "retained"].includes(String(saved.state)),
      `${prefix}_pin_journal_changed`,
    );
  const token = await secret();
  window(now());
  if (saved) await reconcilePin(plan.pin, token, transport);
  else {
    saved = { pin: plan.pin, state: "dispatched" };
    journal.set("activation-pin", saved); // Before the only non-idempotent request.
    window(now());
    await addPin(
      plan.pin,
      plan.bytes,
      token,
      async (receipt) => {
        saved = { ...saved, pin: plan.pin, state: "received", receipt };
        journal.set("activation-pin", saved);
      },
      transport,
    );
  }
  journal.set("activation-pin", { ...saved, state: "retained" });
  return {
    uri: plan.pin.uri,
    sha256: plan.pin.sha256,
    state: "retained",
    maximumAdds: 1,
  };
}
