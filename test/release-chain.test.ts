import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type PublicClient,
} from "viem";
import {
  rootRegistrationData,
  rootRegistrationAbi,
  observeRootRegistration,
  storyTestnet,
} from "../packages/community/registration-chain.ts";
import {
  observePublication,
  publicationData,
  readCommunityPosts,
  postsAbi,
} from "../packages/community/post-chain.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";

const hash = `0x${"1".repeat(64)}` as const,
  blockHash = `0x${"2".repeat(64)}` as const;
const signer = "0x1111111111111111111111111111111111111111",
  recipient = "0x2222222222222222222222222222222222222222",
  asset = "0x3333333333333333333333333333333333333333";
const uri =
  "ipfs://bafkreiabsnyic5vcde6vn37d3ljdpwqyxbyaqgjrkwqmbw4o545i6hpqfy";
test("ROOT registration calls the parent-free workflow and reconciles only the exact confirmed mint to the captured creator", async () => {
  const input = {
    recipient,
    contentSha256: hash,
    metadata: { uri, sha256: hash },
    nftMetadata: { uri, sha256: hash },
  } as const;
  const data = rootRegistrationData(input),
    decoded = decodeFunctionData({ abi: rootRegistrationAbi, data });
  assert.equal(decoded.functionName, "mintAndRegisterIp");
  assert.equal(decoded.args![1], recipient);
  assert.equal(decoded.args![3], false);
  let confirmations = 1n,
    changed = false;
  const client = {
    getChainId: async () => 1315,
    getBlockNumber: async () => 100n + confirmations,
    getTransactionReceipt: async () => ({
      status: "success",
      transactionHash: hash,
      blockNumber: 100n,
      blockHash,
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
            [asset, "Root asset", uri, 1000n],
          ),
        },
      ],
    }),
    getTransaction: async () => ({
      hash,
      chainId: 1315,
      from: signer,
      to: storyTestnet.workflow,
      value: 0n,
      input: changed ? "0x" : data,
      blockHash,
    }),
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "ipId"
        ? asset
        : functionName === "ownerOf"
          ? recipient
          : uri,
    getBlock: async () => ({ hash: blockHash }),
  } as unknown as PublicClient;
  const receipt = await observeRootRegistration(client, hash, signer, input);
  assert.equal(receipt!.assetId, asset);
  assert.equal(receipt!.recipient, recipient);
  assert.equal(receipt!.contentSha256, hash);
  confirmations = 0n;
  assert.equal(
    await observeRootRegistration(client, hash, signer, input),
    null,
  );
  confirmations = 1n;
  changed = true;
  await assert.rejects(
    observeRootRegistration(client, hash, signer, input),
    /registration_transaction_mismatch/,
  );
});

test("publication reconciliation binds the transaction, event, publisher, registry profile and stable post identity", async () => {
  const deployed = JSON.parse(
    await readFile(
      "docs/deployments/first-song-managed-20261105.configuration.json",
      "utf8",
    ),
  );
  const config = validateConfig(deployed.configuration),
    code = "0x6000",
    profile = {
      address: config.postsContract,
      runtimeCodeHash: keccak256(code),
      deploymentBlock: 1n,
    };
  const input = {
    communityId: config.communityId,
    postId: hash,
    configurationRevision: 1,
    authorId: hash,
    manifestSha256: hash,
    manifestURI: uri,
  };
  const data = publicationData(input);
  let changed = false;
  let receiptHash: typeof hash | typeof blockHash = hash;
  const client = {
    getChainId: async () => 6343,
    getBlockNumber: async () => 101n,
    getCode: async () => code,
    readContract: async () => config.directory,
    getTransactionReceipt: async () => ({
      status: "success",
      transactionHash: receiptHash,
      blockNumber: 100n,
      blockHash,
      logs: [
        {
          address: profile.address,
          topics: encodeEventTopics({
            abi: postsAbi,
            eventName: "PostRevisionPublished",
            args: {
              communityId: input.communityId,
              postId: input.postId,
              authorId: input.authorId,
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
            [0, 1n, 1n, changed ? blockHash : hash, uri],
          ),
        },
      ],
    }),
    getTransaction: async () => ({
      hash,
      chainId: 6343,
      from: config.publisher,
      to: profile.address,
      value: 0n,
      input: data,
      blockHash,
    }),
    getBlock: async () => ({ hash: blockHash }),
  } as unknown as PublicClient;
  const result = await observePublication(
    client,
    profile,
    config,
    hash,
    config.publisher,
    input,
  );
  assert.equal(result!.postId, hash);
  assert.equal(result!.revision, 1);
  changed = true;
  await assert.rejects(
    observePublication(client, profile, config, hash, config.publisher, input),
    /publication_event_mismatch/,
  );
  changed = false;
  receiptHash = blockHash;
  await assert.rejects(
    observePublication(client, profile, config, hash, config.publisher, input),
    /publication_transaction_mismatch/,
  );
  const otherKindClient = {
    ...client,
    getLogs: async () => [
      {
        args: { ...input, kind: 1, revision: 1n, configurationRevision: 1n },
        blockNumber: 100n,
        transactionHash: hash,
      },
    ],
  } as unknown as PublicClient;
  assert.deepEqual(
    await readCommunityPosts(otherKindClient, profile, [config], config),
    [],
  );
});
