// Read-only source authentication. Synthetic timing is not a provider measurement or public grade.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { megaethReadClient } from "../packages/community/chain.ts";
import { readConfigurationHistory } from "../packages/community/directory-reader.ts";
import { validateLyrics } from "../packages/community/lyric-manifest.ts";
import { isSectionCue } from "../packages/alignment/elevenlabs-response.ts";
import { publishedKaraokeManifest } from "../packages/karaoke/published-manifest.ts";
import { sourceAuthenticator } from "../packages/records/source-authentication.ts";
import { firstSong } from "../services/first-song-profile.ts";

const client = megaethReadClient();
const history = await readConfigurationHistory(client, { ...firstSong.directoryProfile,
  deploymentBlock: BigInt(firstSong.directoryProfile.deploymentBlock) });
const head = await client.getBlockNumber({ cacheTime: 0 });
const lyrics = validateLyrics(JSON.parse(readFileSync("fixtures/first-song/lyrics-manifest.json", "utf8")));
const words = lyrics.lines.filter((line) => !isSectionCue(line.text)).flatMap((line, i) => line.text.trim().split(/\s+/).map((text, wordIndex) => ({
  lineId: line.lineId, lineVersion: line.lineVersion, wordIndex, text, startMs: i * 10000 + wordIndex * 100,
  endMs: i * 10000 + wordIndex * 100 + 90,
})));
const manifest = publishedKaraokeManifest(lyrics, { words }, 10000);
const authenticate = sourceAuthenticator({ client, history, head, posts: {
  address: firstSong.posts.address, runtimeCodeHash: firstSong.posts.runtimeCodeHash, deploymentBlock: BigInt(firstSong.posts.deploymentBlock),
} });
const authentic = await authenticate(manifest);
const shortened = await authenticate({ ...manifest, lines: manifest.lines.slice(0, -1) });
if (!authentic || shortened) throw new Error("source_authentication_failed");
const result = { chainId: 6343, head: String(head), communityId: lyrics.communityId, postId: lyrics.postId,
  source: manifest.source, scoredLines: manifest.lines.length, authentic, shortenedRejected: !shortened,
  timing: "synthetic fixture only", network: "read-only RPC and public IPFS documents", publicTransactions: 0 };
mkdirSync(".local/learning-testnet", { recursive: true });
writeFileSync(".local/learning-testnet/source-qualification.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
