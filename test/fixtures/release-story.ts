// Explicit local Story RPC simulation. No public-chain transaction is sent.
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseTransaction,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  rootRegistrationAbi,
  storyTestnet,
} from "../../packages/community/registration-chain.ts";
export function releaseStoryFixture(signer: PrivateKeyAccount) {
  const code = "0x6000",
    blockHash = `0x${"3".repeat(64)}` as Hex,
    asset = "0x3333333333333333333333333333333333333333";
  const transactions = new Map<Hex, Hex>();
  let broadcasts = 0;
  const transaction = (hash: Hex) => {
    const raw = transactions.get(hash);
    if (!raw) throw new TransactionReceiptNotFoundError({ hash });
    return parseTransaction(raw);
  };
  const client = {
    getChainId: async () => 1315,
    getBlockNumber: async () => 101n,
    getCode: async () => code,
    getTransactionCount: async () => 3,
    getGasPrice: async () => 1000000000n,
    getBalance: async () => 10000000000000000n,
    estimateGas: async () => 1000000n,
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      broadcasts++;
      const hash = keccak256(serializedTransaction);
      transactions.set(hash, serializedTransaction);
      return hash;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      transaction(hash);
      return {
        status: "success",
        transactionHash: hash,
        blockNumber: 100n,
        blockHash,
        gasUsed: 500000n,
        effectiveGasPrice: 1000000000n,
        logs: [
          {
            address: storyTestnet.registry,
            topics: encodeEventTopics({
              abi: rootRegistrationAbi,
              eventName: "IPRegistered",
              args: {
                chainId: 1315n,
                tokenContract: storyTestnet.nft,
                tokenId: 1n,
              },
            }),
            data: encodeAbiParameters(
              [
                { type: "address" },
                { type: "string" },
                { type: "string" },
                { type: "uint256" },
              ],
              [asset, "Root asset", "ipfs://unused", 1000n],
            ),
          },
        ],
      };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => ({
      hash,
      chainId: 1315,
      from: signer.address,
      to: storyTestnet.workflow,
      value: 0n,
      input: transaction(hash).data,
      blockHash,
    }),
    getBlock: async () => ({ hash: blockHash }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "ipId") return asset;
      const hash = [...transactions.keys()][0]!;
      const decoded = decodeFunctionData({
        abi: rootRegistrationAbi,
        data: transaction(hash).data!,
      });
      if (decoded.functionName !== "mintAndRegisterIp")
        throw Error("fixture requires ROOT workflow");
      return functionName === "ownerOf"
        ? decoded.args[1]
        : decoded.args[2].nftMetadataURI;
    },
  } as unknown as PublicClient;
  return {
    client,
    codeHash: keccak256(code),
    broadcasts: () => broadcasts,
    mints: () => transactions.size,
  };
}
