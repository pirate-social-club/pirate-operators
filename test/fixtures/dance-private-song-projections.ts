/** Offline Posts/RPC + decoder doubles around ACTUAL schema, CID/digest proof
 * and SQLite/D1 statements. Not a live producer, device or native D1 receipt. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type Hex,
  type PublicClient,
} from "viem";
import { canonical, hashJson } from "../../packages/community/common.ts";
import { validateConfig } from "../../packages/community/config-manifest.ts";
import { preparePin } from "../../packages/community/ipfs.ts";
import { postsAbi } from "../../packages/community/post-chain.ts";
import { validatePost } from "../../packages/community/post-manifest.ts";
import {
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../../packages/community/owner-policy.ts";
import type { DanceFence } from "../../packages/dance/contracts.ts";
import { DANCE_HOST_INPUTS_SCHEMA_PROPOSAL } from "../../services/dance-account-facts-store.ts";
import type { PublicReadPorts } from "../../services/community-public.ts";
import type { DancePrivateSongSelection } from "../../services/dance-private-song-projections.ts";
import { MemorySqliteD1 } from "../dance-sqlite-fixture.ts";

export const word = (n: number) =>
  `0x${n.toString(16).padStart(64, "0")}` as Hex;
export function pause() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    async wait() {
      entered();
      await done;
    },
  };
}

export async function privateSongFixture(t: { after(fn: () => void): void }) {
  const db = new MemorySqliteD1();
  t.after(() => db.close());
  db.sqlite.exec("CREATE TABLE setup_schema(version INTEGER)");
  db.sqlite.exec(
    readFileSync(
      new URL(
        "../../apps/community-wizard/infra/migrations/0002_first_song.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  db.sqlite.exec(
    readFileSync(
      new URL("../../packages/dance/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.sqlite.exec(DANCE_HOST_INPUTS_SCHEMA_PROPOSAL);
  // Test-only current producer. Production receives actual captured D1 fences.
  db.sqlite.exec(
    "CREATE TABLE private_song_fixture_generation(revision INTEGER); INSERT INTO private_song_fixture_generation VALUES(1)",
  );
  const config = validateConfig(
    JSON.parse(
      readFileSync(
        new URL(
          "../../docs/deployments/first-song-managed-20261105.configuration.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ).configuration,
  );
  config.policies.admission = {
    version: UNREGISTERED_OWNER_POLICY_VERSION,
    sha256: UNREGISTERED_OWNER_POLICY_HASH,
  };
  db.sqlite
    .prepare("INSERT INTO application_identity VALUES(1,?,?)")
    .run(config.communityId, config.app.origin);
  db.sqlite
    .prepare("INSERT INTO public_configurations VALUES(?,?,?,?,?,?,?,?,?)")
    .run(
      config.communityId,
      config.configurationRevision,
      config.publisher,
      "offline-config-uri",
      hashJson(config),
      canonical(config),
      "90",
      word(88),
      word(89),
    );
  const audioBytes = new TextEncoder().encode(
    "private song explicit offline audio bytes",
  );
  const audio = await preparePin(audioBytes, "audio/mpeg");
  const post = validatePost({
    schema: "pirate.community-post/3",
    chainId: 6343,
    postsContract: config.postsContract,
    communityId: config.communityId,
    postId: word(400),
    authorId: word(401),
    kind: "song",
    revision: 1,
    configurationRevision: config.configurationRevision,
    publishedAt: Date.now(),
    title: "Offline private dance song",
    language: "und",
    rating: "general",
    media: [{ role: "audio", ...audio }],
    admission: {
      policyVersion: UNREGISTERED_OWNER_POLICY_VERSION,
      policySha256: UNREGISTERED_OWNER_POLICY_HASH,
      decision: "publish",
      rating: "general",
      coverDisplayed: false,
      evidenceSha256: word(402),
      automatedContent: "deferred",
      declarationSource: "operator_declared",
    },
    registration: { status: "absent", reason: "deferred_for_launch" },
  });
  const manifest = await preparePin(
    new TextEncoder().encode(canonical(post)),
    "application/json",
  );
  db.sqlite
    .prepare(
      "INSERT INTO public_post_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)",
    )
    .run(
      config.communityId,
      post.postId,
      1,
      post.authorId,
      config.configurationRevision,
      manifest.uri,
      manifest.sha256,
      canonical(post),
      "100",
      word(500),
      word(501),
      0,
    );
  db.sqlite
    .prepare("INSERT INTO chain_scan_state VALUES(6343,?,?,?)")
    .run(config.postsContract, "101", word(500));
  const selected: DancePrivateSongSelection = {
    version: "pirate.dance-selected-song/1",
    postId: post.postId,
    songRevision: 1,
    manifestSha256: manifest.sha256,
    audioSha256: audio.sha256,
    startSample: 48000,
    durationSamples: 480000,
    reference: null,
    offerProgramId: null,
    offer: null,
  };
  const code = "0x6000" as Hex,
    chainConfig = structuredClone(config);
  const log = {
    address: config.postsContract,
    blockNumber: 100n,
    blockHash: word(500),
    transactionHash: word(501),
    logIndex: 0,
    transactionIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: postsAbi,
      eventName: "PostRevisionPublished",
      args: {
        communityId: config.communityId,
        postId: post.postId,
        authorId: post.authorId,
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
        0,
        1n,
        BigInt(config.configurationRevision),
        manifest.sha256,
        manifest.uri,
      ],
    ),
  };
  const state = {
    chainId: 6343,
    receiptSuccess: true,
    checkpoint: word(500),
    corruptAudio: false,
    samples: 4800000,
    sampleRate: 48000,
    receiptBytes: "offline decoder receipt",
    currentMissing: false,
  };
  const calls = {
    current: 0,
    probe: 0,
    download: 0,
    contracts: [] as string[],
  };
  const hooks: {
    current?: () => Promise<void>;
    probe?: () => Promise<void>;
    download?: () => Promise<void>;
  } = {};
  const client = {
    async getChainId() {
      return state.chainId;
    },
    async getBlockNumber() {
      return 101n;
    },
    async getCode() {
      return code;
    },
    async getBlock() {
      return { number: 100n, hash: state.checkpoint };
    },
    async getTransactionReceipt() {
      return {
        status: state.receiptSuccess ? "success" : "reverted",
        transactionHash: word(501),
        blockHash: word(500),
        blockNumber: 100n,
        logs: [log],
      };
    },
    async readContract({
      functionName,
      args,
    }: {
      functionName: string;
      args?: readonly unknown[];
    }) {
      calls.contracts.push(functionName);
      if (functionName === "directory") return chainConfig.directory;
      assert.equal(
        functionName,
        "getPost",
        "no V4/owner/alias/grant contract read is admitted by this double",
      );
      assert.deepEqual(args, [chainConfig.communityId, post.postId]);
      return {
        authorId: post.authorId,
        kind: 0,
        revision: 1n,
        configurationRevision: BigInt(chainConfig.configurationRevision),
        manifestSha256: manifest.sha256,
        manifestURI: manifest.uri,
      };
    },
  } as unknown as PublicClient;
  const reads: PublicReadPorts = {
    client,
    profile: {
      address: config.postsContract,
      runtimeCodeHash: keccak256(code),
      deploymentBlock: 1n,
    },
    configurationHistory: async () => [structuredClone(chainConfig)],
    async transport(request) {
      calls.download++;
      assert.ok(new URL(request.url).pathname.endsWith(audio.uri.slice(7)));
      await hooks.download?.();
      return new Response(
        state.corruptAudio ? new Uint8Array([1]) : audioBytes.slice(),
      );
    },
  };
  const fence: DanceFence = {
    sql: "EXISTS(SELECT 1 FROM private_song_fixture_generation WHERE revision=?)",
    values: [1],
  };
  const input = {
    db: db.asD1(),
    config,
    reads,
    async current() {
      calls.current++;
      await hooks.current?.();
      return state.currentMissing ? [] : [structuredClone(fence)];
    },
    async probe(bytes: Uint8Array) {
      calls.probe++;
      assert.deepEqual(bytes, audioBytes);
      await hooks.probe?.();
      return {
        sampleRate: state.sampleRate as 48000,
        samples: state.samples,
        receiptBytes: state.receiptBytes,
      };
    },
  };
  const counts = () =>
    [
      "dance_host_song_keys",
      "dance_host_audio_probes",
      "dance_host_selections",
    ].map((name) => db.count(name));
  const lose = () =>
    db.sqlite.exec("UPDATE private_song_fixture_generation SET revision=2");
  return {
    db,
    config,
    reads,
    input,
    selected,
    state,
    calls,
    hooks,
    counts,
    lose,
    post,
    audio,
    manifest,
    log,
  };
}
