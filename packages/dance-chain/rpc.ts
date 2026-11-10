import {
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { insist } from "../community/common.ts";
import { danceVerdictsAbi } from "./abi.ts";
import type { DanceBlock, DanceLog, DanceReadPort } from "./reader.ts";

const event = danceVerdictsAbi.find(
  (x) => x.type === "event" && x.name === "VerdictCommitted",
)!;

/** Read-only viem adapter. A caller supplies the already selected community RPC. */
export function danceReadPort(client: PublicClient): DanceReadPort & {
  verdictLogs(
    address: Address,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<DanceLog[]>;
} {
  const block = (
    b: Awaited<ReturnType<typeof client.getBlock>>,
  ): DanceBlock => {
    insist(
      b.number !== null &&
        b.hash !== null &&
        b.transactions.every((tx) => typeof tx === "string"),
      "dance_block_incomplete",
      503,
    );
    return {
      number: b.number,
      hash: b.hash,
      timestamp: b.timestamp,
      transactions: b.transactions,
    };
  };
  return {
    chainId: () => client.getChainId(),
    safe: async () =>
      block(
        await client.getBlock({ blockTag: "safe", includeTransactions: false }),
      ),
    block: async (blockNumber) =>
      block(await client.getBlock({ blockNumber, includeTransactions: false })),
    code: (address, blockNumber) => client.getCode({ address, blockNumber }),
    receipt: (hash) =>
      client.getTransactionReceipt({ hash }).catch((error: unknown) => {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }),
    async sourceView(address, blockNumber) {
      const read = { address, abi: danceVerdictsAbi, blockNumber } as const;
      const [
        sourceHash,
        communityId,
        version,
        capturePolicy,
        capturePolicyRuntimeHash,
      ] = await Promise.all([
        client.readContract({ ...read, functionName: "sourceHash" }),
        client.readContract({ ...read, functionName: "communityId" }),
        client.readContract({ ...read, functionName: "VERSION" }),
        client.readContract({ ...read, functionName: "capturePolicy" }),
        client.readContract({
          ...read,
          functionName: "capturePolicyRuntimeHash",
        }),
      ]);
      return {
        sourceHash,
        communityId,
        version,
        capturePolicy,
        capturePolicyRuntimeHash,
      };
    },
    registration: (address: Address, id: Hex, blockNumber: bigint) =>
      client.readContract({
        address,
        abi: danceVerdictsAbi,
        functionName: "registrationOf",
        args: [id],
        blockNumber,
      }),
    verdictLogs: (address, fromBlock, toBlock) =>
      client.getLogs({ address, event, fromBlock, toBlock, strict: true }),
  };
}
