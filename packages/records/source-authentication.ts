// Authenticate the exercise set through historical public post revisions, not a grader's hash alone.
import { keccak256, type PublicClient } from "viem";
import { canonical } from "../community/common.ts";
import type { CommunityConfig } from "../community/config-manifest.ts";
import { fetchPublicIpfs, type IpfsTransport } from "../community/ipfs.ts";
import { validateLyrics } from "../community/lyric-manifest.ts";
import { postsAbi, publicationEvent, type PostsProfile } from "../community/post-chain.ts";
import { validatePostForEvent } from "../community/post-manifest.ts";
import { isSectionCue } from "../alignment/elevenlabs-response.ts";
import type { KaraokeManifest } from "../protocol/payments.ts";

export function sourceAuthenticator(input: { client: PublicClient; posts: PostsProfile; head: bigint;
  history: readonly CommunityConfig[]; transport?: IpfsTransport }) {
  return async (manifest: KaraokeManifest): Promise<boolean> => {
    if (!manifest.song || !manifest.source || manifest.song.chainId !== 6343 ||
      manifest.song.posts.toLowerCase() !== input.posts.address.toLowerCase() || await input.client.getChainId() !== 6343) return false;
    const code = await input.client.getCode({ address: input.posts.address, blockNumber: input.head });
    if (!code || keccak256(code) !== input.posts.runtimeCodeHash) return false;
    for (let from = input.posts.deploymentBlock; from <= input.head; from += 10000n) {
      const logs = await input.client.getLogs({ address: input.posts.address, event: postsAbi[3],
        args: { communityId: manifest.song.communityId, postId: manifest.song.postId },
        fromBlock: from, toBlock: from + 9999n < input.head ? from + 9999n : input.head, strict: true });
      for (const log of logs) {
        if (log.removed || log.args.kind !== 0) continue;
        const event = publicationEvent(log.args, input.posts);
        const configuration = input.history.find((x) => x.communityId === event.communityId && x.configurationRevision === event.configurationRevision);
        if (!configuration) continue;
        const document = await fetchPublicIpfs(event.manifestURI, event.manifestSha256, 1024 * 1024, input.transport);
        const post = validatePostForEvent(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(document.bytes)), event, configuration);
        const lyric = post.media.find((media) => media.role === "lyrics" && media.sha256 === manifest.source!.lyricsSha256);
        if (!lyric) continue;
        const content = await fetchPublicIpfs(lyric.uri, lyric.sha256, lyric.byteLength, input.transport);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content.bytes), lyrics = validateLyrics(JSON.parse(text));
        if (text !== canonical(lyrics) || lyrics.revision !== manifest.source.lyricsRevision ||
          lyrics.chainId !== manifest.song.chainId || lyrics.postsContract !== manifest.song.posts ||
          lyrics.communityId !== manifest.song.communityId || lyrics.postId !== manifest.song.postId) continue;
        const expected = lyrics.lines.filter((line) => !isSectionCue(line.text));
        return expected.length === manifest.lines.length && expected.every((line, i) =>
          line.lineId === manifest.lines[i].lineId && line.lineVersion === manifest.lines[i].lineVersion && line.text === manifest.lines[i].text);
      }
    }
    return false;
  };
}
