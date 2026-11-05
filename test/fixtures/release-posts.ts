// Explicit local MegaETH RPC simulation; no public transaction is sent.
import {
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  TransactionNotFoundError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  keccak256,
  parseTransaction,
  stringToHex,
  type Hex,
  type PublicClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { CommunityConfig } from "../../packages/community/config-manifest.ts";
import { postsAbi } from "../../packages/community/post-chain.ts";
export function releasePostsFixture(
  signer: PrivateKeyAccount,
  config: CommunityConfig,
) {
  const code = "0x6000",
    blockHash = (number: bigint) =>
      keccak256(stringToHex(`fixture block ${number}`));
  let raw: Hex | undefined,
    mined = false,
    broadcasts = 0;
  function publication() {
    if (!raw || !mined)
      throw new ContractFunctionRevertedError({
        abi: postsAbi,
        functionName: "getPost",
        data: encodeErrorResult({ abi: postsAbi, errorName: "UnknownPost" }),
      });
    const tx = parseTransaction(raw),
      call = decodeFunctionData({ abi: postsAbi, data: tx.data! });
    if (call.functionName !== "publishRevision")
      throw Error("fixture requires publication");
    const [
      communityId,
      postId,
      expectedRevision,
      configurationRevision,
      authorId,
      kind,
      manifestSha256,
      manifestURI,
    ] = call.args;
    return {
      communityId,
      postId,
      authorId,
      kind,
      revision: expectedRevision + 1n,
      configurationRevision,
      manifestSha256,
      manifestURI,
    };
  }
  function log() {
    const p = publication();
    return {
      address: config.postsContract,
      args: p,
      topics: encodeEventTopics({
        abi: postsAbi,
        eventName: "PostRevisionPublished",
        args: {
          communityId: p.communityId,
          postId: p.postId,
          authorId: p.authorId,
        },
      }),
      data: encodeAbiParameters(
        [
          { type: "uint8" },
          { type: "uint64" },
          { type: "uint64" },
          { type: "bytes32" },
          { type: "string" },
        ],
        [
          p.kind,
          p.revision,
          p.configurationRevision,
          p.manifestSha256,
          p.manifestURI,
        ],
      ),
      blockNumber: 100n,
      blockHash: blockHash(100n),
      transactionHash: keccak256(raw!),
      logIndex: 0,
    };
  }
  const client = {
    getChainId: async () => 6343,
    getBlockNumber: async () => 101n,
    getCode: async () => code,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      hash: blockHash(blockNumber),
    }),
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      3 + (raw && (mined || blockTag === "pending") ? 1 : 0),
    getGasPrice: async () => 1000000n,
    getBalance: async () => 10000000000000000n,
    estimateGas: async () => 300000n,
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "directory" ? config.directory : publication(),
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      broadcasts++;
      if (raw && raw !== serializedTransaction)
        throw Error("fixture rejects replacement");
      raw = serializedTransaction;
      return keccak256(raw);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (!raw || !mined || keccak256(raw) !== hash)
        throw new TransactionReceiptNotFoundError({ hash });
      return {
        transactionHash: hash,
        status: "success",
        blockNumber: 100n,
        blockHash: blockHash(100n),
        gasUsed: 250000n,
        effectiveGasPrice: 1000000n,
        logs: [log()],
      };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (!raw || keccak256(raw) !== hash)
        throw new TransactionNotFoundError({ hash });
      return {
        hash,
        chainId: 6343,
        from: signer.address,
        to: config.postsContract,
        value: 0n,
        input: parseTransaction(raw).data,
        blockHash: mined ? blockHash(100n) : null,
      };
    },
    getLogs: async ({
      fromBlock,
      toBlock,
    }: {
      fromBlock: bigint;
      toBlock: bigint;
    }) => (raw && mined && fromBlock <= 100n && toBlock >= 100n ? [log()] : []),
  } as unknown as PublicClient;
  return {
    client,
    profile: {
      address: config.postsContract,
      runtimeCodeHash: keccak256(code),
      deploymentBlock: 1n,
    },
    mine: () => {
      mined = true;
    },
    broadcasts: () => broadcasts,
  };
}
