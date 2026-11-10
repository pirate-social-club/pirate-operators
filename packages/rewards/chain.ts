import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  http,
  TransactionReceiptNotFoundError,
  type Hex,
} from "viem";
import { insist } from "../community/common.ts";
import type {
  ConfirmedTransfer,
  RewardChain,
  RewardsProfile,
} from "./contracts.ts";
import { rewardAddress, rewardAmount } from "./validation.ts";
import { readPaymentGuard } from "./guard-chain.ts";

const clientFor = (p: RewardsProfile) =>
  createPublicClient({
    transport: http(p.rpcUrl, {
      retryCount: 0,
      timeout: 10000,
      // workerd rejects "error". viem refuses the unfollowed 3xx as not ok.
      fetchOptions: { credentials: "omit", redirect: "manual" },
    }),
  });
async function checkedClient(p: RewardsProfile) {
  const client = clientFor(p);
  insist((await client.getChainId()) === 6343, "wrong_reward_chain", 503);
  const decimals = await client.readContract({
    address: rewardAddress(p.token) as Hex,
    abi: erc20Abi,
    functionName: "decimals",
  });
  insist(decimals === p.decimals, "reward_token_decimals_changed", 503);
  return client;
}
/** Read-only RPCs. No signer, private key, allowance or transaction-broadcast method exists here. */
export function rewardChain(): RewardChain {
  async function transfers(p: RewardsProfile, hash: string) {
    const client = await checkedClient(p);
    const receipt = await client
      .getTransactionReceipt({ hash: hash as Hex })
      .catch((error) => {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      });
    if (receipt === null) return null;
    insist(
      receipt.transactionHash.toLowerCase() === hash &&
        receipt.status === "success",
      "reward_transaction_failed_or_changed",
      409,
    );
    const [safe, canonical] = await Promise.all([
      client.getBlock({ blockTag: "safe" }),
      client.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    if (safe.number < receipt.blockNumber) return null;
    insist(
      canonical.hash === receipt.blockHash,
      "reward_transaction_reorged",
      409,
    );
    const result: ConfirmedTransfer[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== p.token) continue;
      let event;
      try {
        event = decodeEventLog({
          abi: erc20Abi,
          eventName: "Transfer",
          data: log.data,
          topics: log.topics,
        });
      } catch {
        continue;
      }
      insist(log.logIndex !== null, "reward_transfer_index_missing", 503);
      result.push({
        chainId: 6343,
        transactionHash: hash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber.toString(),
        logIndex: log.logIndex,
        sender: event.args.from.toLowerCase(),
        recipient: event.args.to.toLowerCase(),
        token: p.token,
        amountAtomic: event.args.value.toString(),
      });
    }
    const after = await client.getBlock({ blockNumber: receipt.blockNumber });
    insist(after.hash === canonical.hash, "reward_transaction_reorged", 409);
    return result;
  }
  return {
    async guard(p, nonce, minimumBlock) {
      return readPaymentGuard(
        await checkedClient(p),
        p,
        nonce,
        minimumBlock,
        transfers,
      );
    },
    async confirmedPosition(p) {
      const client = await checkedClient(p);
      return (await client.getBlock({ blockTag: "safe" })).number.toString();
    },
    async outgoing(p, fromBlock, toBlock) {
      const from = rewardAmount(fromBlock),
        to = rewardAmount(toBlock);
      insist(to >= from && to - from <= 9999n, "reward_audit_range_invalid");
      const client = await checkedClient(p),
        safe = await client.getBlock({ blockTag: "safe" });
      insist(to <= safe.number, "reward_audit_not_confirmed", 409);
      const logs = await client.getContractEvents({
        address: p.token as Hex,
        abi: erc20Abi,
        eventName: "Transfer",
        args: { from: p.payoutWallet as Hex },
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      const hashes = [
        ...new Set(
          logs.filter((l) => !l.removed).map((l) => l.transactionHash),
        ),
      ];
      insist(hashes.length <= 50, "reward_audit_transaction_limit", 409);
      const events: ConfirmedTransfer[] = [];
      for (const hash of hashes) {
        const rows = await transfers(p, hash);
        insist(rows !== null, "reward_audit_not_confirmed", 409);
        events.push(
          ...rows.filter(
            (r) =>
              r.sender === p.payoutWallet &&
              rewardAmount(r.blockNumber) >= from &&
              rewardAmount(r.blockNumber) <= to,
          ),
        );
      }
      return events;
    },
    async balance(p, owner) {
      const client = await checkedClient(p);
      return (
        await client.readContract({
          address: p.token as Hex,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [rewardAddress(owner) as Hex],
        })
      ).toString();
    },
    async position(p) {
      const client = await checkedClient(p);
      return (await client.getBlockNumber({ cacheTime: 0 })).toString();
    },
    async transfer(p, hash, expected) {
      const events = await transfers(p, hash);
      if (events === null) return null;
      const matches = events.filter(
        (e) =>
          e.sender === expected.sender &&
          e.recipient === expected.recipient &&
          e.amountAtomic === expected.amountAtomic,
      );
      insist(matches.length === 1, "reward_payment_transfer_not_unique", 409);
      return matches[0];
    },
    async incoming(p, hash, index) {
      insist(
        Number.isSafeInteger(index) && index >= 0,
        "invalid_reward_log_index",
      );
      const events = await transfers(p, hash);
      insist(events !== null, "reward_funding_not_confirmed", 409);
      const event = events.find((e) => e.logIndex === index);
      insist(event, "reward_funding_transfer_missing", 409);
      rewardAmount(event.amountAtomic);
      return event;
    },
  };
}
