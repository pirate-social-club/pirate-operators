// Explicit RPC simulation with the canonical ROOT workflow event sequence.
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import {
  rootRegistrationAbi,
  storyTestnet,
} from "../../packages/community/registration-chain.ts";

interface ReceiptLog {
  address: Hex;
  topics: ReturnType<typeof encodeEventTopics>;
  data: Hex;
  logIndex: number;
  blockNumber: bigint;
  transactionHash: Hex;
  blockHash: Hex;
  transactionIndex: number;
  removed: boolean;
}
export function registrationLogs(
  hash: Hex,
  blockHash: Hex,
  recipient: Hex,
  uri: string,
  blockNumber = 100n,
): ReceiptLog[] {
  const metadata = {
      transactionHash: hash,
      transactionIndex: 0,
      blockHash,
      blockNumber,
      removed: false,
    },
    transfer = (from: Hex, to: Hex, logIndex: number) => ({
      ...metadata,
      address: storyTestnet.nft,
      logIndex,
      topics: encodeEventTopics({
        abi: rootRegistrationAbi,
        eventName: "Transfer",
        args: { from, to, tokenId: 1n },
      }),
      data: "0x" as Hex,
    });
  return [
    transfer(
      "0x0000000000000000000000000000000000000000",
      storyTestnet.workflow,
      0,
    ),
    {
      ...metadata,
      address: storyTestnet.registry,
      logIndex: 1,
      topics: encodeEventTopics({
        abi: rootRegistrationAbi,
        eventName: "IPRegistered",
        args: { chainId: 1315n, tokenContract: storyTestnet.nft, tokenId: 1n },
      }),
      data: encodeAbiParameters(
        [
          { type: "address" },
          { type: "string" },
          { type: "string" },
          { type: "uint256" },
        ],
        [
          "0x3333333333333333333333333333333333333333",
          "Root asset",
          uri,
          1000n,
        ],
      ),
    },
    transfer(storyTestnet.workflow, recipient, 2),
  ];
}
