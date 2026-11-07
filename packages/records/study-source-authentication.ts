// Authenticate the complete Study source through published historical media.
import { keccak256, type Hex, type PublicClient } from "viem";
import type { TerminalResult } from "../protocol/learning-results-v3.ts";
import { canonical, digest } from "../protocol/index.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { fetchPublicIpfs, type IpfsTransport } from "../community/ipfs.ts";
import {
  validateLyrics,
  type LyricManifest,
} from "../community/lyric-manifest.ts";
import {
  postsAbi,
  publicationEvent,
  type PostsProfile,
} from "../community/post-chain.ts";
import { validatePostForEvent } from "../community/post-manifest.ts";
import { STUDY_SOURCE_MAX_BYTES } from "../study/public-source.ts";

export interface StudySourceContext {
  client: PublicClient;
  posts: PostsProfile;
  head: bigint;
  history: readonly CommunityConfig[];
  transport?: IpfsTransport;
}

/** The published post supplies the URI, including multi-block IPFS manifests. */
export function studySourceReader(input: StudySourceContext) {
  return async (
    hash: Hex,
    song: TerminalResult["song"],
  ): Promise<LyricManifest | undefined> => {
    if (
      song.chainId !== 6343n ||
      song.posts.toLowerCase() !== input.posts.address.toLowerCase() ||
      (await input.client.getChainId()) !== 6343
    )
      return undefined;
    const before = await input.client.getBlock({ blockNumber: input.head });
    const code = await input.client.getCode({
      address: input.posts.address,
      blockNumber: input.head,
    });
    if (!code || keccak256(code) !== input.posts.runtimeCodeHash)
      return undefined;
    let matched: LyricManifest | undefined;
    for (
      let from = input.posts.deploymentBlock;
      from <= input.head && !matched;
      from += 10000n
    ) {
      const logs = await input.client.getLogs({
        address: input.posts.address,
        event: postsAbi[3],
        args: { communityId: song.communityId, postId: song.postId },
        fromBlock: from,
        toBlock: from + 9999n < input.head ? from + 9999n : input.head,
        strict: true,
      });
      for (const log of logs) {
        if (log.removed || log.args.kind !== 0) continue;
        const event = publicationEvent(log.args, input.posts);
        if (
          event.communityId !== song.communityId ||
          event.postId !== song.postId
        )
          continue;
        const config = input.history.find(
          (x) =>
            x.communityId === event.communityId &&
            x.configurationRevision === event.configurationRevision,
        );
        if (!config) continue;
        const document = await fetchPublicIpfs(
          event.manifestURI,
          event.manifestSha256,
          1024 * 1024,
          input.transport,
        );
        const post = validatePostForEvent(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(document.bytes),
          ),
          event,
          config,
        );
        const lyric = post.media.find(
          (m) => m.role === "lyrics" && m.sha256 === hash,
        );
        if (!lyric || lyric.byteLength > STUDY_SOURCE_MAX_BYTES) continue;
        const content = await fetchPublicIpfs(
          lyric.uri,
          hash,
          lyric.byteLength,
          input.transport,
        );
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          content.bytes,
        );
        const published = validateLyrics(JSON.parse(text));
        if (
          text === canonical(published) &&
          digest(published) === hash &&
          published.chainId === event.chainId &&
          published.postsContract === event.postsContract &&
          published.communityId === event.communityId &&
          published.postId === event.postId
        ) {
          matched = published;
          break;
        }
      }
    }
    const after = await input.client.getBlock({ blockNumber: input.head });
    return before.hash === after.hash ? matched : undefined;
  };
}

export function studySourceAuthenticator(input: StudySourceContext) {
  const read = studySourceReader(input);
  return async (value: LyricManifest): Promise<boolean> => {
    const source = validateLyrics(value);
    return !!(await read(digest(source), {
      chainId: BigInt(source.chainId),
      posts: source.postsContract,
      communityId: source.communityId,
      postId: source.postId,
    }));
  };
}
