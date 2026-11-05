// Explicit local Story RPC simulation. No public-chain transaction is sent.
import {
  decodeFunctionData,
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
import { registrationLogs } from "./registration-receipt.ts";
export function releaseStoryFixture(signer: PrivateKeyAccount) {
  const code = "0x6000",
    blockHash = `0x${"3".repeat(64)}` as Hex,
    asset = "0x3333333333333333333333333333333333333333";
  let beforeEstimate: (() => void) | undefined;
  const transactions = new Map<Hex, Hex>();
  let broadcasts = 0,
    orphaned = false;
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
    estimateGas: async () => {
      beforeEstimate?.();
      return 1000000n;
    },
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
      if (orphaned) throw new TransactionReceiptNotFoundError({ hash });
      const decoded = decodeFunctionData({
        abi: rootRegistrationAbi,
        data: transaction(hash).data!,
      });
      if (decoded.functionName !== "mintAndRegisterIp")
        throw Error("fixture requires ROOT workflow");
      return {
        status: "success",
        transactionHash: hash,
        blockNumber: 100n,
        blockHash,
        gasUsed: 500000n,
        effectiveGasPrice: 1000000000n,
        logs: registrationLogs(
          hash,
          blockHash,
          decoded.args[1],
          decoded.args[2].nftMetadataURI,
        ),
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
      blockNumber: 100n,
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
    beforeEstimate: (hook: () => void) => {
      beforeEstimate = hook;
    },
    codeHash: keccak256(code),
    broadcasts: () => broadcasts,
    orphan: (value: boolean) => {
      orphaned = value;
    },
    mints: () => transactions.size,
  };
}
