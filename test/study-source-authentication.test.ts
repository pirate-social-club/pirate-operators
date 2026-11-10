import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { encodeFunctionData, zeroHash } from "viem";
import { accounts } from "../harness/runtime.ts";
import { canonical, digest } from "../packages/protocol/index.ts";
import {
  createLyrics,
  validateLyrics,
} from "../packages/community/lyric-manifest.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { postsAbi } from "../packages/community/post-chain.ts";
import {
  studySourceAuthenticator,
  studySourceReader,
} from "../packages/records/study-source-authentication.ts";
import { resultManifestUri } from "../packages/records/result-manifest.ts";
import { releasePostsFixture } from "./fixtures/release-posts.ts";

async function fixture(large = false) {
  const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const first = validateConfig(
    (
      await load(
        "docs/deployments/first-song-managed-20261105.configuration.json",
      )
    ).configuration,
  );
  const config = validateConfig(
    (
      await load(
        "docs/deployments/first-song-managed-20261105.curated-configuration.json",
      )
    ).configuration,
    [first],
  );
  const post = await load("fixtures/first-song/post-manifest.json");
  const original = validateLyrics(
    await load("fixtures/first-song/lyrics-manifest.json"),
  );
  const source = large
    ? createLyrics(
        {
          chainId: original.chainId,
          postsContract: original.postsContract,
          communityId: original.communityId,
          postId: original.postId,
        },
        Array.from({ length: 2000 }, (_, i) => `Line ${i}`).join("\n"),
        "en",
      )
    : original;
  const sourceBytes = new TextEncoder().encode(canonical(source)),
    sourcePin = await preparePin(sourceBytes, "application/json");
  const lyrics = post.media.find((x: { role: string }) => x.role === "lyrics");
  Object.assign(lyrics, {
    uri: sourcePin.uri,
    sha256: sourcePin.sha256,
    byteLength: sourcePin.byteLength,
  });
  const postBytes = new TextEncoder().encode(canonical(post)),
    postPin = await preparePin(postBytes, "application/json");
  const simulated = releasePostsFixture(accounts[3], config);
  // This signature is consumed only by the local mock, never a public RPC.
  const raw = await accounts[3].signTransaction({
    chainId: 6343,
    nonce: 3,
    to: config.postsContract,
    value: 0n,
    gas: 300000n,
    maxFeePerGas: 1000000n,
    maxPriorityFeePerGas: 0n,
    data: encodeFunctionData({
      abi: postsAbi,
      functionName: "publishRevision",
      args: [
        post.communityId,
        post.postId,
        BigInt(post.revision - 1),
        BigInt(post.configurationRevision),
        post.authorId,
        0,
        postPin.sha256,
        postPin.uri,
      ],
    }),
  });
  await simulated.client.sendRawTransaction({ serializedTransaction: raw });
  simulated.mine();
  const documents = new Map([
    [postPin.uri.slice(7), postBytes],
    [sourcePin.uri.slice(7), sourceBytes],
  ]);
  const input = {
    client: simulated.client,
    posts: simulated.profile,
    head: 101n,
    history: [first, config],
    transport: async (request: Request) => {
      const bytes = documents.get(
        new URL(request.url).pathname.split("/").at(-1)!,
      );
      return bytes
        ? new Response(bytes)
        : new Response("missing", { status: 404 });
    },
  };
  const song = {
    chainId: BigInt(source.chainId),
    posts: source.postsContract,
    communityId: source.communityId,
    postId: source.postId,
  };
  return { input, source, song, sourceBytes, sourcePin, documents };
}

test("Study source is independently authenticated through historical post and configuration bytes", async () => {
  const f = await fixture();
  const reader = studySourceReader(f.input);
  assert.deepEqual(await reader(digest(f.source), f.song), f.source);
  assert.equal(await studySourceAuthenticator(f.input)(f.source), true);
  assert.equal(
    await studySourceReader({ ...f.input, history: [] })(
      digest(f.source),
      f.song,
    ),
    undefined,
  );
  assert.equal(
    await reader(digest(f.source), { ...f.song, postId: digest("other post") }),
    undefined,
  );
  assert.equal(
    await studySourceReader({
      ...f.input,
      posts: { ...f.input.posts, runtimeCodeHash: zeroHash },
    })(digest(f.source), f.song),
    undefined,
  );
  const changed = structuredClone(f.source);
  changed.lines[0].lineVersion++;
  assert.equal(await studySourceAuthenticator(f.input)(changed), false);
  f.documents.set(
    f.sourcePin.uri.slice(7),
    new TextEncoder().encode("altered bytes"),
  );
  await assert.rejects(() => reader(digest(f.source), f.song));
});

test("large full manifests follow the published multi-block URI instead of assuming a raw CID", async () => {
  const f = await fixture(true);
  assert(f.sourceBytes.length > 262144);
  assert.notEqual(f.sourcePin.uri, resultManifestUri(digest(f.source)));
  const read = await studySourceReader(f.input)(digest(f.source), f.song);
  assert.equal(read?.lines.length, 2000);
  assert.equal(digest(read!), digest(f.source));
});
