// Local-only multiblock public-media fixture. Computes CIDs without pinning.
import assert from "node:assert/strict";
import { decodeEventLog, hexToBytes } from "viem";
import { canonical } from "../../packages/community/common.ts";
import { createLyrics } from "../../packages/community/lyric-manifest.ts";
import { preparePin } from "../../packages/community/ipfs.ts";
import { postsAbi } from "../../packages/community/post-chain.ts";
import { resultManifestUri } from "../../harness/reference-results/facts.ts";
import { hash } from "./reference-results.ts";
import { studyTrace } from "./reference-study.ts";
export async function largeStudyTrace() {
  const base = studyTrace(),
    original = base.source;
  const source = createLyrics(
    {
      chainId: original.chainId,
      postsContract: original.postsContract,
      communityId: original.communityId,
      postId: original.postId,
    },
    Array.from({ length: 2000 }, (_, i) => `这是第${i}句歌词`).join("\n"),
    "zh",
  );
  source.revision = original.revision + 1;
  source.lines.forEach((line, i) => {
    line.lineId = hash("large-public-line-" + i);
  });
  const pin = await preparePin(
    new TextEncoder().encode(canonical(source)),
    "application/json",
  );
  assert.ok(pin.byteLength > 262144);
  assert.notEqual(pin.uri, resultManifestUri(pin.sha256));
  const postEvent = [...base.snapshot.logs]
    .reverse()
    .filter(
      (log) =>
        log.address.toLowerCase() ===
        base.snapshot.profile.posts.address.toLowerCase(),
    )
    .map(
      (log) =>
        decodeEventLog({
          abi: postsAbi,
          eventName: "PostRevisionPublished",
          data: log.data,
          topics: log.topics,
        }).args,
    )
    .find((event) => event.postId === source.postId)!;
  const post = JSON.parse(
    new TextDecoder().decode(
      hexToBytes(base.snapshot.documents[postEvent.manifestURI]),
    ),
  );
  post.revision = Number(postEvent.revision) + 1;
  post.configurationRevision = Number(
    base.snapshot.directoryState.configurationRevision,
  );
  Object.assign(
    post.media.find((media: any) => media.role === "lyrics"),
    { uri: pin.uri, sha256: pin.sha256, byteLength: pin.byteLength },
  );
  const postPin = await preparePin(
    new TextEncoder().encode(canonical(post)),
    "application/json",
  );
  return studyTrace({ source, pin, post, postPin });
}
