import { createPublicClient, decodeEventLog, keccak256, type Hex } from "viem";
import { insist } from "../community/common.ts";
import type {
  RewardsProfile,
  ConfirmedTransfer,
  RewardGuardEvidence,
} from "./contracts.ts";
import { rewardAmount } from "./validation.ts";
import {
  mossGuardAbi,
  MOSS_GUARD_PROXY,
  MOSS_GUARD_PROXY_HASH,
  MOSS_GUARD_IMPLEMENTATION,
  MOSS_GUARD_IMPLEMENTATION_HASH,
  MOSS_GUARD_ORCHESTRATOR,
} from "./moss-guard.ts";

/** Read-only account proof. Never infer cancellation from a missing transfer or wallet callback. */
export async function readPaymentGuard(
  client: ReturnType<typeof createPublicClient>,
  p: RewardsProfile,
  raw: string,
  minimumBlock: string,
  transfers: (
    p: RewardsProfile,
    hash: string,
  ) => Promise<ConfirmedTransfer[] | null>,
): Promise<RewardGuardEvidence | null> {
  const nonce = rewardAmount(raw),
    seq = nonce >> 64n;
  insist(
    seq >> 176n === 0x5052n && nonce % (1n << 64n) === 0n,
    "reward_guard_namespace_invalid",
    409,
  );
  const safe = await client.getBlock({ blockTag: "safe" });
  async function accountAt(blockNumber: bigint) {
    const [delegation, proxy, implementation] = await Promise.all([
      client.getCode({ address: p.payoutWallet as Hex, blockNumber }),
      client.getCode({ address: MOSS_GUARD_PROXY, blockNumber }),
      client.readContract({
        address: MOSS_GUARD_ORCHESTRATOR,
        abi: mossGuardAbi,
        functionName: "accountImplementationOf",
        args: [p.payoutWallet as Hex],
        blockNumber,
      }),
    ]);
    insist(
      delegation?.toLowerCase() === `0xef0100${MOSS_GUARD_PROXY.slice(2)}` &&
        proxy &&
        keccak256(proxy) === MOSS_GUARD_PROXY_HASH &&
        implementation.toLowerCase() === MOSS_GUARD_IMPLEMENTATION,
      "reward_guard_account_changed_or_uninitialized",
      409,
    );
    const code = await client.getCode({
      address: MOSS_GUARD_IMPLEMENTATION,
      blockNumber,
    });
    insist(
      code && keccak256(code) === MOSS_GUARD_IMPLEMENTATION_HASH,
      "reward_guard_implementation_changed",
      409,
    );
  }
  await accountAt(safe.number);
  const at = (blockNumber: bigint) =>
    client.readContract({
      address: p.payoutWallet as Hex,
      abi: mossGuardAbi,
      functionName: "getNonce",
      args: [seq],
      blockNumber,
    });
  const current = await at(safe.number);
  if (current === nonce) return null;
  insist(current === nonce + 1n, "reward_guard_unexpected_sequence", 409);
  let low = rewardAmount(minimumBlock),
    high = safe.number;
  insist(
    low > 0n && low <= high && (await at(low - 1n)) === nonce,
    "reward_guard_predates_payment",
    409,
  );
  for (let step = 0; low < high && step < 256; step++) {
    const mid = (low + high) / 2n,
      value = await at(mid);
    insist(
      value === nonce || value === nonce + 1n,
      "reward_guard_unexpected_sequence",
      409,
    );
    if (value === nonce) low = mid + 1n;
    else high = mid;
  }
  insist(low === high, "reward_guard_history_unavailable", 503);
  await accountAt(low);
  const block = await client.getBlock({ blockNumber: low });
  const events = await client.getContractEvents({
    address: p.payoutWallet as Hex,
    abi: mossGuardAbi,
    eventName: "NonceInvalidated",
    fromBlock: low,
    toBlock: low,
    strict: true,
  });
  const matches = events.filter(
    (e) => !e.removed && e.args.nonce === nonce && e.blockHash === block.hash,
  );
  insist(
    matches.length === 1 && matches[0].logIndex !== null,
    "reward_guard_event_not_unique",
    409,
  );
  const event = matches[0];
  const receipt = await client.getTransactionReceipt({
    hash: event.transactionHash,
  });
  const guardLog = receipt.logs.find((log) => log.logIndex === event.logIndex);
  insist(
    receipt.status === "success" &&
      receipt.blockHash === block.hash &&
      receipt.blockNumber === low &&
      receipt.transactionHash === event.transactionHash &&
      guardLog?.address.toLowerCase() === p.payoutWallet,
    "reward_guard_receipt_changed",
    409,
  );
  const decoded = decodeEventLog({
    abi: mossGuardAbi,
    eventName: "NonceInvalidated",
    data: guardLog.data,
    topics: guardLog.topics,
  });
  insist(decoded.args.nonce === nonce, "reward_guard_receipt_changed", 409);
  const rows = await transfers(p, event.transactionHash);
  insist(
    rows !== null &&
      rows.every(
        (t) =>
          t.transactionHash === event.transactionHash &&
          t.blockHash === block.hash,
      ),
    "reward_guard_receipt_changed",
    409,
  );
  insist(
    (await client.getBlock({ blockNumber: low })).hash === block.hash &&
      (await client.getBlock({ blockNumber: safe.number })).hash ===
        safe.hash &&
      (await at(safe.number)) === current,
    "reward_guard_reorged",
    409,
  );
  return {
    chainId: 6343,
    account: p.payoutWallet,
    nonce: raw,
    transactionHash: event.transactionHash,
    blockHash: block.hash,
    blockNumber: low.toString(),
    logIndex: event.logIndex!,
    implementation: MOSS_GUARD_IMPLEMENTATION,
    transfers: rows,
  };
}
