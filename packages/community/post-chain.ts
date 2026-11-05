// Owned V1 interface from contracts/interfaces/community/ICommunityPostsV1.sol.
import {
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  parseAbi,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { bytes32, insist } from "./common.ts";
import { address, ipfsUri } from "./manifest-core.ts";
import type { CommunityConfig } from "./config-manifest.ts";
import { fetchPublicIpfs } from "./ipfs.ts";
import {
  validatePostForEvent,
  quarantined,
  type PublicationEvent,
} from "./post-manifest.ts";

export const postsAbi = parseAbi([
  "function directory() view returns (address)",
  "function publishRevision(bytes32 communityId,bytes32 postId,uint64 expectedRevision,uint64 configurationRevision,bytes32 authorId,uint8 kind,bytes32 manifestSha256,string manifestURI)",
  "function getPost(bytes32 communityId,bytes32 postId) view returns ((bytes32 authorId,uint8 kind,uint64 revision,uint64 configurationRevision,bytes32 manifestSha256,string manifestURI))",
  "event PostRevisionPublished(bytes32 indexed communityId,bytes32 indexed postId,bytes32 indexed authorId,uint8 kind,uint64 revision,uint64 configurationRevision,bytes32 manifestSha256,string manifestURI)",
]);
export interface PostsProfile {
  address: Address;
  runtimeCodeHash: Hex;
  deploymentBlock: bigint;
}
export interface FirstPublication {
  communityId: Hex;
  postId: Hex;
  configurationRevision: number;
  authorId: Hex;
  manifestSha256: Hex;
  manifestURI: string;
}
export function publicationData(input: FirstPublication) {
  return encodeFunctionData({
    abi: postsAbi,
    functionName: "publishRevision",
    args: [
      bytes32(input.communityId),
      bytes32(input.postId),
      0n,
      BigInt(input.configurationRevision),
      bytes32(input.authorId),
      0,
      bytes32(input.manifestSha256),
      ipfsUri(input.manifestURI),
    ],
  });
}
async function confirmedHead(
  client: PublicClient,
  profile: PostsProfile,
  config: CommunityConfig,
) {
  insist(
    (await client.getChainId()) === 6343 &&
      config.chainId === 6343 &&
      config.postsContract === profile.address,
    "wrong_posts_profile",
    503,
  );
  const head = await client.getBlockNumber({ cacheTime: 0 });
  insist(head >= profile.deploymentBlock + 1n, "posts_not_confirmed", 503);
  const blockNumber = head - 1n;
  const code = await client.getCode({ address: profile.address, blockNumber });
  insist(
    code && keccak256(code) === profile.runtimeCodeHash,
    "posts_code_changed",
    503,
  );
  const directory = await client.readContract({
    address: profile.address,
    abi: postsAbi,
    functionName: "directory",
    blockNumber,
  });
  insist(
    directory.toLowerCase() === config.directory,
    "posts_directory_changed",
    503,
  );
  return blockNumber;
}
function event(
  args: Record<string, unknown>,
  profile: PostsProfile,
): PublicationEvent {
  insist(
    args.kind === 0 &&
      typeof args.revision === "bigint" &&
      typeof args.configurationRevision === "bigint" &&
      args.revision <= BigInt(Number.MAX_SAFE_INTEGER) &&
      args.configurationRevision <= BigInt(Number.MAX_SAFE_INTEGER),
    "unsupported_post_event",
    503,
  );
  return {
    chainId: 6343,
    postsContract: profile.address,
    communityId: bytes32(args.communityId),
    postId: bytes32(args.postId),
    authorId: bytes32(args.authorId),
    kind: 0,
    revision: Number(args.revision),
    configurationRevision: Number(args.configurationRevision),
    manifestSha256: bytes32(args.manifestSha256),
    manifestURI: ipfsUri(args.manifestURI),
  };
}
/** Reconcile only the persisted signed transaction. This function never sends. */
export async function observePublication(
  client: PublicClient,
  profile: PostsProfile,
  config: CommunityConfig,
  hash: Hex,
  publisher: Address,
  input: FirstPublication,
) {
  insist(
    input.communityId === config.communityId &&
      input.configurationRevision === config.configurationRevision &&
      address(publisher) === config.publisher,
    "publication_authority_mismatch",
    503,
  );
  const head = await confirmedHead(client, profile, config);
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: bytes32(hash) });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  }
  insist(receipt.status === "success", "publication_reverted", 409);
  if (receipt.blockNumber > head) return null;
  const tx = await client.getTransaction({ hash });
  insist(
    tx.hash === hash &&
      tx.chainId === 6343 &&
      tx.from.toLowerCase() === address(publisher) &&
      tx.to?.toLowerCase() === profile.address &&
      tx.value === 0n &&
      tx.input === publicationData(input) &&
      tx.blockHash === receipt.blockHash,
    "publication_transaction_mismatch",
    503,
  );
  const publications = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== profile.address) continue;
    try {
      publications.push(
        event(
          decodeEventLog({
            abi: postsAbi,
            eventName: "PostRevisionPublished",
            topics: log.topics,
            data: log.data,
            strict: true,
          }).args,
          profile,
        ),
      );
    } catch {
      /* Other event kinds cannot supply evidence. */
    }
  }
  insist(
    publications.length === 1,
    "publication_event_missing_or_ambiguous",
    503,
  );
  const published = publications[0]!;
  insist(
    published.communityId === input.communityId &&
      published.postId === input.postId &&
      published.authorId === input.authorId &&
      published.configurationRevision === input.configurationRevision &&
      published.revision === 1 &&
      published.manifestSha256 === input.manifestSha256 &&
      published.manifestURI === input.manifestURI,
    "publication_event_mismatch",
    503,
  );
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  insist(block.hash === receipt.blockHash, "publication_block_changed", 503);
  return {
    transactionHash: hash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    postId: published.postId,
    revision: 1,
  };
}
/** Reconstruct from confirmed public chain events and validated public content.
 * Missing content is an unavailable feed, never a fabricated successful post. */
export async function readCommunityPosts(
  client: PublicClient,
  profile: PostsProfile,
  history: CommunityConfig[],
  current: CommunityConfig,
) {
  const head = await confirmedHead(client, profile, current);
  const latest = new Map<
    string,
    { publication: PublicationEvent; block: bigint; transactionHash: Hex }
  >();
  for (let from = profile.deploymentBlock; from <= head; from += 10000n) {
    const logs = await client.getLogs({
      address: profile.address,
      event: postsAbi[3],
      args: { communityId: current.communityId },
      fromBlock: from,
      toBlock: from + 9999n < head ? from + 9999n : head,
      strict: true,
    });
    for (const log of logs) {
      const publication = event(log.args, profile),
        prior = latest.get(publication.postId);
      if (!prior || publication.revision > prior.publication.revision)
        latest.set(publication.postId, {
          publication,
          block: log.blockNumber,
          transactionHash: log.transactionHash,
        });
    }
  }
  insist(latest.size <= 100, "feed_page_required", 503);
  const result = [];
  for (const { publication, block, transactionHash } of latest.values()) {
    if (quarantined(publication, block, history, current)) continue;
    const config = history.find(
      (c) => c.configurationRevision === publication.configurationRevision,
    );
    insist(config, "publication_configuration_missing", 503);
    const { bytes } = await fetchPublicIpfs(
      publication.manifestURI,
      publication.manifestSha256,
      1024 * 1024,
    );
    const post = validatePostForEvent(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      publication,
      config,
    );
    result.push({ post, transactionHash, blockNumber: block.toString() });
  }
  return result.sort((a, b) => b.post.publishedAt - a.post.publishedAt);
}
