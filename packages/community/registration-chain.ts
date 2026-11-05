// Independently owned interface declarations from api-next a5c63b8,
// packages/platform-cf/src/data/registration-aeneid-chain.ts. Root lineage
// selects this workflow; it makes no claim about composition or copyright.
import {
  createPublicClient,
  http,
  parseAbi,
  encodeFunctionData,
  decodeEventLog,
  encodeEventTopics,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { bytes32, insist } from "./common.ts";
import { address, ipfsUri } from "./manifest-core.ts";
import {
  validateRegistration,
  type RegistrationReceipt,
} from "./post-manifest.ts";

export const storyTestnet = {
  chainId: 1315,
  rpc: "https://aeneid.storyrpc.io",
  workflow: "0xbe39e1c756e921bd25df86e7aaa31106d1eb0424",
  nft: "0xc32a8a0ff3beddda58393d022af433e78739fabc",
  registry: "0x77319b4031e6ef1250907aa00018b8b1c67a244b",
} as const;
export const rootRegistrationAbi = parseAbi([
  "function mintAndRegisterIp(address spgNftContract,address recipient,(string ipMetadataURI,bytes32 ipMetadataHash,string nftMetadataURI,bytes32 nftMetadataHash) ipMetadata,bool allowDuplicates) returns (address ipId,uint256 tokenId)",
  "event IPRegistered(address ipId,uint256 indexed chainId,address indexed tokenContract,uint256 indexed tokenId,string name,string uri,uint256 registrationDate)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
  "function ipId(uint256 chainId,address tokenContract,uint256 tokenId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);
export interface RootRegistrationInput {
  recipient: Address;
  contentSha256: Hex;
  metadata: { uri: string; sha256: Hex };
  nftMetadata: { uri: string; sha256: Hex };
}
export function rootRegistrationData(input: RootRegistrationInput) {
  return encodeFunctionData({
    abi: rootRegistrationAbi,
    functionName: "mintAndRegisterIp",
    args: [
      storyTestnet.nft,
      address(input.recipient),
      {
        ipMetadataURI: ipfsUri(input.metadata.uri),
        ipMetadataHash: bytes32(input.metadata.sha256),
        nftMetadataURI: ipfsUri(input.nftMetadata.uri),
        nftMetadataHash: bytes32(input.nftMetadata.sha256),
      },
      false,
    ],
  });
}
export function storyReadClient(): PublicClient {
  return createPublicClient({
    transport: http(storyTestnet.rpc, {
      retryCount: 0,
      timeout: 15000,
      fetchOptions: { redirect: "manual" },
    }),
  });
}

/** Observe the captured transaction. Never sends, replaces, or allocates a
 * nonce. Missing/unconfirmed receipts remain pending under the original hash. */
export async function observeRootRegistration(
  client: PublicClient,
  transactionHash: Hex,
  signer: Address,
  input: RootRegistrationInput,
): Promise<RegistrationReceipt | null> {
  insist(
    (await client.getChainId()) === storyTestnet.chainId,
    "wrong_registration_chain",
    503,
  );
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({
      hash: bytes32(transactionHash),
    });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  }
  insist(receipt.status === "success", "registration_reverted", 409);
  const head = await client.getBlockNumber({ cacheTime: 0 });
  if (head < receipt.blockNumber + 1n) return null;
  const transaction = await client.getTransaction({ hash: transactionHash });
  insist(
    receipt.transactionHash === transactionHash &&
      transaction.hash === transactionHash &&
      transaction.chainId === storyTestnet.chainId &&
      transaction.from.toLowerCase() === address(signer) &&
      transaction.to?.toLowerCase() === storyTestnet.workflow &&
      transaction.value === 0n &&
      transaction.input === rootRegistrationData(input) &&
      transaction.blockNumber === receipt.blockNumber &&
      transaction.blockHash === receipt.blockHash,
    "registration_transaction_mismatch",
    503,
  );
  const registered = [],
    transfers = [],
    transferTopic = encodeEventTopics({
      abi: rootRegistrationAbi,
      eventName: "Transfer",
    })[0],
    registeredTopic = encodeEventTopics({
      abi: rootRegistrationAbi,
      eventName: "IPRegistered",
    })[0];
  let lastIndex = -1;
  for (const log of receipt.logs) {
    const isTransfer =
        log.address.toLowerCase() === storyTestnet.nft &&
        log.topics[0] === transferTopic,
      isRegistered =
        log.address.toLowerCase() === storyTestnet.registry &&
        log.topics[0] === registeredTopic;
    if (!isTransfer && !isRegistered) continue;
    insist(
      log.transactionHash === transactionHash &&
        log.blockHash === receipt.blockHash &&
        log.blockNumber === receipt.blockNumber &&
        log.removed === false &&
        Number.isSafeInteger(log.logIndex) &&
        log.logIndex! > lastIndex,
      "registration_log_binding_mismatch",
      503,
    );
    lastIndex = log.logIndex!;
    if (isTransfer) {
      transfers.push({
        ...decodeEventLog({
          abi: rootRegistrationAbi,
          eventName: "Transfer",
          topics: log.topics,
          data: log.data,
          strict: true,
        }).args,
        index: log.logIndex,
      });
      continue;
    }
    registered.push(
      decodeEventLog({
        abi: rootRegistrationAbi,
        eventName: "IPRegistered",
        topics: log.topics,
        data: log.data,
        strict: true,
      }).args,
    );
  }
  insist(
    registered.length === 1,
    "registration_event_missing_or_ambiguous",
    503,
  );
  const event = registered[0]!;
  insist(
    event.chainId === 1315n &&
      event.tokenContract.toLowerCase() === storyTestnet.nft &&
      event.uri === input.nftMetadata.uri,
    "registration_asset_mismatch",
    503,
  );
  // Prove initial delivery from the canonical mint receipt. Public testnet RPCs
  // prune historical state within minutes; current ownership is not evidence
  // of ownership at mint. The exact workflow call and IPRegistered URI above
  // bind both metadata inputs, and these two ordered ERC721 events bind the
  // initial token and creator without an archival eth_call or another mint.
  const [mint, delivery] = transfers;
  insist(
    transfers.length === 2 &&
      mint &&
      delivery &&
      mint.tokenId === event.tokenId &&
      delivery.tokenId === event.tokenId &&
      mint.from === "0x0000000000000000000000000000000000000000" &&
      mint.to.toLowerCase() === storyTestnet.workflow &&
      delivery.from.toLowerCase() === storyTestnet.workflow &&
      delivery.to.toLowerCase() === address(input.recipient) &&
      Number.isSafeInteger(mint.index) &&
      Number.isSafeInteger(delivery.index) &&
      mint.index! >= 0 &&
      delivery.index! > mint.index!,
    "registration_delivery_mismatch",
    503,
  );
  const [block, retained] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }),
    client.getTransactionReceipt({ hash: transactionHash }),
  ]);
  const logIdentity = (logs: typeof receipt.logs) =>
    JSON.stringify(
      logs.map((l) => [
        l.address,
        l.topics,
        l.data,
        l.logIndex,
        l.transactionHash,
        l.blockHash,
        l.blockNumber?.toString(),
        l.removed,
      ]),
    );
  insist(
    block.hash === receipt.blockHash &&
      retained.status === "success" &&
      retained.transactionHash === transactionHash &&
      retained.blockHash === receipt.blockHash &&
      retained.blockNumber === receipt.blockNumber &&
      logIdentity(retained.logs) === logIdentity(receipt.logs),
    "registration_receipt_binding_mismatch",
    503,
  );
  return validateRegistration({
    protocol: "story",
    network: "aeneid",
    chainId: 1315,
    assetId: event.ipId.toLowerCase(),
    nftContract: storyTestnet.nft,
    tokenId: event.tokenId.toString(),
    recipient: input.recipient,
    transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    metadataUri: input.metadata.uri,
    metadataSha256: input.metadata.sha256,
    contentSha256: input.contentSha256,
    status: "confirmed",
  });
}
