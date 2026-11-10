// Adapted from the independent review's post-authentication counterexamples.
// Production validators appear only in this test-side comparison, never in
// the independent reference implementation.
import {
  decodeEventLog,
  encodeEventTopics,
  encodeAbiParameters,
  getAbiItem,
  hexToBytes,
  sha256,
  toHex,
  type Hex,
} from "viem";
import { canonical } from "../../packages/community/common.ts";
import { postsAbi } from "../../packages/community/post-chain.ts";
import {
  readConfigurationHistory,
  directoryAbi,
} from "../../packages/community/directory-reader.ts";
import { studySourceAuthenticator } from "../../packages/records/study-source-authentication.ts";
import { evidenceClient } from "../../harness/public-evidence-client.ts";
import { resultManifestUri } from "../../harness/reference-results/facts.ts";
import { rewriteLastStudy } from "./reference-study-rewrite.ts";
import type { studyTrace } from "./reference-study.ts";
type Fixture = ReturnType<typeof studyTrace>;
export function alterStudyPosts(f: Fixture, change: (post: any) => void) {
  const event = getAbiItem({ abi: postsAbi, name: "PostRevisionPublished" }),
    inputs = event.inputs.filter(
      (input) => !("indexed" in input && input.indexed),
    );
  for (const log of f.snapshot.logs) {
    if (
      log.address.toLowerCase() !==
      f.snapshot.profile.posts.address.toLowerCase()
    )
      continue;
    const decoded = decodeEventLog({
      abi: postsAbi,
      eventName: "PostRevisionPublished",
      data: log.data,
      topics: log.topics,
    });
    if (decoded.args.postId !== f.source.postId || decoded.args.kind !== 0)
      continue;
    const post = JSON.parse(
      new TextDecoder().decode(
        hexToBytes(f.snapshot.documents[decoded.args.manifestURI]),
      ),
    );
    change(post);
    const wire = toHex(canonical(post)),
      hash = sha256(wire),
      uri = resultManifestUri(hash);
    f.snapshot.documents[uri] = wire;
    const args = { ...decoded.args, manifestSha256: hash, manifestURI: uri },
      patch = {
        topics: encodeEventTopics({
          abi: postsAbi,
          eventName: "PostRevisionPublished",
          args,
        }),
        data: encodeAbiParameters(
          inputs,
          inputs.map((input) => args[input.name as keyof typeof args]),
        ),
      };
    const receipt = f.snapshot.receipts[log.transactionHash].logs.find(
      (row) => row.logIndex === log.logIndex,
    )!;
    Object.assign(log, patch);
    Object.assign(receipt, patch);
  }
}
export function alterStudyLyrics(f: Fixture, change: (source: any) => void) {
  change(f.source);
  const wire = toHex(canonical(f.source)),
    hash = sha256(wire),
    uri = resultManifestUri(hash);
  f.snapshot.documents[uri] = wire;
  alterStudyPosts(f, (post) =>
    Object.assign(
      post.media.find((media: any) => media.role === "lyrics"),
      { uri, sha256: hash, byteLength: (wire.length - 2) / 2 },
    ),
  );
  rewriteLastStudy(f, (header, outcomes) => ({
    header: { ...header, contentRevision: hash },
    wire: outcomes,
  }));
}
export async function productionStudySourceAccepts(f: Fixture) {
  const p = f.snapshot.profile,
    { client, transport } = evidenceClient(f.snapshot);
  try {
    const history = await readConfigurationHistory(
      client,
      {
        chainId: p.chainId,
        directory: p.directory.address,
        registry: p.registry,
        communityId: p.communityId,
        deploymentBlock: BigInt(p.directory.fromBlock),
        directoryCodeHash: p.directory.codeHash,
      },
      transport,
    );
    return await studySourceAuthenticator({
      client,
      transport,
      history,
      head: BigInt(f.snapshot.head.number),
      posts: {
        address: p.posts.address,
        deploymentBlock: BigInt(p.posts.fromBlock),
        runtimeCodeHash: p.posts.codeHash,
      },
    })(f.source);
  } catch {
    return false;
  }
}

export function alterStudyConfiguration(
  f: Fixture,
  mutate: (config: any) => void,
) {
  const log = [...f.snapshot.logs]
    .reverse()
    .find(
      (log) =>
        log.address.toLowerCase() ===
        f.snapshot.profile.directory.address.toLowerCase(),
    )!;
  const args = decodeEventLog({
    abi: directoryAbi,
    eventName: "ConfigurationPublished",
    data: log.data,
    topics: log.topics,
  }).args;
  const config = JSON.parse(
    new TextDecoder().decode(hexToBytes(f.snapshot.documents[args.uri])),
  );
  mutate(config);
  const wire = toHex(canonical(config)),
    hash = sha256(wire),
    uri = resultManifestUri(hash);
  f.snapshot.documents[uri] = wire;
  const values = { ...args, sha256Digest: hash, uri },
    event = getAbiItem({ abi: directoryAbi, name: "ConfigurationPublished" }),
    inputs = event.inputs.filter(
      (input) => !("indexed" in input && input.indexed),
    );
  const patch = {
    topics: encodeEventTopics({
      abi: directoryAbi,
      eventName: "ConfigurationPublished",
      args: values,
    }),
    data: encodeAbiParameters(
      inputs,
      inputs.map((input) => values[input.name as keyof typeof values]),
    ),
  };
  Object.assign(log, patch);
  Object.assign(
    f.snapshot.receipts[log.transactionHash].logs.find(
      (row) => row.logIndex === log.logIndex,
    )!,
    patch,
  );
  Object.assign(f.snapshot.directoryState.configuration!, {
    sha256Digest: hash,
    uri,
  });
  return config;
}
