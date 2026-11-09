// Explicit local MegaETH RPC simulation holding several posts, one per
// transaction. Same surface as release-posts.ts; no public transaction is sent.
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

export function ownerPostsFixture(
  signer: PrivateKeyAccount,
  config: CommunityConfig,
) {
  const code = "0x6000",
    blockHash = (number: bigint) =>
      keccak256(stringToHex(`owner fixture block ${number}`));
  const sent: { raw: Hex; mined: boolean; block: bigint }[] = [];
  let broadcasts = 0;
  const decode = (raw: Hex) => {
    const call = decodeFunctionData({
      abi: postsAbi,
      data: parseTransaction(raw).data!,
    });
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
  };
  const minedTx = () => sent.filter((t) => t.mined);
  const log = (t: (typeof sent)[number]) => {
    const p = decode(t.raw);
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
      blockNumber: t.block,
      blockHash: blockHash(t.block),
      transactionHash: keccak256(t.raw),
      logIndex: 0,
    };
  };
  const head = () => 101n + BigInt(sent.length);
  const client = {
    getChainId: async () => 6343,
    getBlockNumber: async () => head(),
    getCode: async () => code,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      hash: blockHash(blockNumber),
    }),
    getTransactionCount: async ({ blockTag }: { blockTag: string }) =>
      3 + (blockTag === "pending" ? sent.length : minedTx().length),
    getGasPrice: async () => 1000000n,
    getBalance: async () => 10000000000000000n,
    estimateGas: async () => 300000n,
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args?: readonly unknown[];
    }) => {
      if (functionName === "directory") return config.directory;
      const found = minedTx()
        .map((t) => decode(t.raw))
        .find((p) => p.communityId === args?.[0] && p.postId === args?.[1]);
      if (!found)
        throw new ContractFunctionRevertedError({
          abi: postsAbi,
          functionName: "getPost",
          data: encodeErrorResult({ abi: postsAbi, errorName: "UnknownPost" }),
        });
      return found;
    },
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      broadcasts++;
      const nonce = parseTransaction(serializedTransaction).nonce;
      const same = sent.find((t) => parseTransaction(t.raw).nonce === nonce);
      if (same && same.raw !== serializedTransaction)
        throw Error("fixture rejects replacement");
      if (!same)
        sent.push({
          raw: serializedTransaction,
          mined: false,
          block: 100n + BigInt(sent.length),
        });
      return keccak256(serializedTransaction);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const t = sent.find((x) => keccak256(x.raw) === hash);
      if (!t || !t.mined) throw new TransactionReceiptNotFoundError({ hash });
      return {
        transactionHash: hash,
        status: "success",
        blockNumber: t.block,
        blockHash: blockHash(t.block),
        gasUsed: 250000n,
        effectiveGasPrice: 1000000n,
        logs: [log(t)],
      };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const t = sent.find((x) => keccak256(x.raw) === hash);
      if (!t) throw new TransactionNotFoundError({ hash });
      return {
        hash,
        chainId: 6343,
        from: signer.address,
        to: config.postsContract,
        value: 0n,
        input: parseTransaction(t.raw).data,
        blockHash: t.mined ? blockHash(t.block) : null,
      };
    },
    getLogs: async ({
      fromBlock,
      toBlock,
    }: {
      fromBlock: bigint;
      toBlock: bigint;
    }) =>
      minedTx()
        .filter((t) => t.block >= fromBlock && t.block <= toBlock)
        .map(log),
  } as unknown as PublicClient;
  return {
    client,
    profile: {
      address: config.postsContract,
      runtimeCodeHash: keccak256(code),
      deploymentBlock: 1n,
    },
    mine: () => {
      for (const t of sent) t.mined = true;
    },
    broadcasts: () => broadcasts,
  };
}
