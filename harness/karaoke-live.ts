// Local journey for the published first song. The community application of
// services/community-application.ts runs in Node on Miniflare D1 and R2,
// seeded with the real published post and lyric manifests
// (fixtures/first-song/) through a simulated posts contract. The operator with
// the audio relay and a simulated ElevenLabs run in Miniflare, and anvil holds
// OperatorPayments and LearningRecords. The stems are generated stand-ins.
// Local acceptance only; nothing here is packaged or deployed.
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, sha256, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  communityFetch,
  type CommunityDependencies,
  type CommunityEnv,
} from "../services/community-application.ts";
import { firstSong } from "../services/first-song-profile.ts";
import {
  alignmentRequestMessage,
  KARAOKE_MAX_SEGMENT_MS,
  type AlignmentRequest,
} from "../services/karaoke-song.ts";
import { alignmentResult } from "../packages/alignment/elevenlabs-response.ts";
import { publishedKaraokeManifest } from "../packages/karaoke/published-manifest.ts";
import type { KaraokeManifest } from "../packages/protocol/payments.ts";
import { validateConfig } from "../packages/community/config-manifest.ts";
import { postsAbi } from "../packages/community/post-chain.ts";
import { readMp3Probe } from "../packages/moderation/mp3-windows.ts";
import { releasePostsFixture } from "../test/fixtures/release-posts.ts";
import type { chain } from "./chain.ts";
import { keys, accounts } from "./runtime.ts";
import {
  DEFAULT_ALIGNMENT,
  simulatedAlignment,
  type SimulatedAlignment,
  type SimulatedAlignmentLog,
  type SimulatedStream,
  type SimulatedStreamLog,
} from "./karaoke-elevenlabs-simulator.ts";

export type LocalChain = Awaited<ReturnType<typeof chain>>;
const root = (path: string) =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path));

/** The published first song's public documents, byte for byte. */
export const firstSongFixture = (() => {
  const lyricBytes = read("fixtures/first-song/lyrics-manifest.json"),
    postBytes = read("fixtures/first-song/post-manifest.json"),
    post = JSON.parse(postBytes.toString("utf8"));
  return {
    lyricBytes,
    postBytes,
    lyrics: JSON.parse(lyricBytes.toString("utf8")),
    post,
    postId: post.postId as Hex,
    communityId: post.communityId as Hex,
    lyricsUri:
      "ipfs://bafkreif42jl3w5sfjqelqdqlbd4zqol6e53eriuziihqo25m5hanowj4ee",
    lyricsSha256:
      "0xbcd257bb76454c08b80e0b08f998397e277648a299420f076bace9c0d7593c21" as Hex,
    postUri:
      "ipfs://bafkreifdc2ncikvfghhltuzclx5lxujb4qtevrml6yd6ypor6aucyichey",
    postSha256:
      "0xa3169a242aa531ceb9d3225dfabbd121e4264ac58bf607ec3dd1f0282c204726" as Hex,
  };
})();

/**
 * A constant-bitrate MP3 of at least `minimumMs`, made by repeating the audio
 * frames of fixtures/original-tone.mp3 without its ID3 tag and Xing frame.
 */
export async function syntheticMp3(minimumMs: number) {
  const tone = read("fixtures/original-tone.mp3"),
    id3 =
      10 + ((tone[6]! << 21) | (tone[7]! << 14) | (tone[8]! << 7) | tone[9]!),
    rates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    frames: Uint8Array[] = [];
  for (let o = id3; o + 4 <= tone.length; ) {
    const h =
      ((tone[o]! << 24) |
        (tone[o + 1]! << 16) |
        (tone[o + 2]! << 8) |
        tone[o + 3]!) >>>
      0;
    if (h >>> 21 !== 0x7ff) break;
    const length =
      Math.floor((144 * rates[(h >>> 12) & 15]! * 1000) / 44100) +
      ((h >>> 9) & 1);
    const frame = tone.subarray(o, o + length);
    if (!/Xing|Info/.test(Buffer.from(frame).toString("latin1")))
      frames.push(frame);
    o += length;
  }
  const once = frames.reduce((n, f) => n + f.length, 0),
    copies = Math.ceil(minimumMs / 287) + 1,
    bytes = new Uint8Array(once * copies);
  let offset = 0;
  for (let i = 0; i < copies; i++)
    for (const frame of frames) {
      bytes.set(frame, offset);
      offset += frame.length;
    }
  const probe = await readMp3Probe(
    new Blob([bytes]).stream(),
    3600000,
    AbortSignal.timeout(30000),
  );
  return { bytes, durationMs: probe.durationMs, sha256: sha256(bytes) };
}

const bundle = async (entry: string) =>
  (
    await build({
      entryPoints: [root(entry)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers"],
      target: "es2022",
    })
  ).outputFiles[0]!.text;

async function migrate(db: D1Database) {
  for (const name of [
    "0001_setup.sql",
    "0002_first_song.sql",
    "0003_publication_journal.sql",
    "0004_creator_connection.sql",
    "0005_input_capabilities.sql",
    "0006_song_stems.sql",
    "0007_owner_curated.sql",
    "0008_karaoke.sql",
  ]) {
    const sql = read(`apps/community-wizard/infra/migrations/${name}`).toString(
      "utf8",
    );
    await db.batch(
      sql
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
}

// Public local fixture keys. Never fund or deploy them.
export const publisher = privateKeyToAccount(`0x${"12".repeat(32)}`);
export const controller = privateKeyToAccount(`0x${"13".repeat(32)}`);
export const SIMULATED_KEY = "simulated-elevenlabs-key";

export interface LiveOptions {
  evm: LocalChain;
  now: number;
  streams: SimulatedStream[];
  alignment?: SimulatedAlignment;
  /** Null runs the operator and the alignment without a provider key. */
  providerKey?: string | null;
  /** Miniflare routes that reach the operator directly, for a browser. */
  operatorRoutes?: string[];
  /** The operator's public origin that the learner's socket uses. */
  operatorOrigin?: string;
  /** Static assets for the browser journey. */
  assets?: (request: Request) => Promise<Response>;
  /** Shortest stand-in stems, so every simulated timing fits. */
  stemMs?: number;
}

export async function karaokeLive(
  options: LiveOptions,
  persist = mkdtempSync(join(tmpdir(), "pirate-karaoke-live-")),
) {
  const { evm } = options,
    providerKey =
      options.providerKey === null
        ? undefined
        : (options.providerKey ?? SIMULATED_KEY),
    rpcOrigin = new URL(evm.rpcUrl).origin,
    curated = JSON.parse(
      read(
        "docs/deployments/first-song-managed-20261105.curated-configuration.json",
      ).toString("utf8"),
    ),
    original = JSON.parse(
      read(
        "docs/deployments/first-song-managed-20261105.configuration.json",
      ).toString("utf8"),
    ),
    // The published revision-2 configuration, with local keys and contracts.
    config = validateConfig(
      {
        ...curated.configuration,
        publisher: publisher.address.toLowerCase(),
        controller: controller.address.toLowerCase(),
        operatorPayments: evm.paymentsContract.toLowerCase(),
        learningRecords: evm.recordsContract.toLowerCase(),
      },
      [
        validateConfig({
          ...original.configuration,
          publisher: publisher.address.toLowerCase(),
        }),
      ],
    );
  const [operator, simulator] = await Promise.all([
    bundle("services/karaoke-audio-runtime.ts"),
    bundle("harness/karaoke-elevenlabs-simulator.ts"),
  ]);
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    durableObjectsPersist: persist,
    d1Persist: persist,
    r2Persist: persist,
    workers: [
      {
        name: "operator",
        modules: true,
        script: operator,
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ROLE: "operator",
          LOCAL_ONLY: "pirate-local-skeleton",
          PRIVATE_KEY: keys[2]!,
          ISSUER: accounts[1]!.address,
          OPERATOR_ADDRESS: accounts[2]!.address,
          COMMUNITY_ID: config.communityId,
          COMMUNITY_DOMAIN: new URL(firstSong.origin).host,
          CUTOFF: String(options.now + 10_000_000),
          INITIAL_NOW: String(options.now),
          SIGNATURE_CHAIN_ID: "31337",
          RPC_URL: evm.rpcUrl,
          PAYMENT_CHAIN_ID: "31337",
          PAYMENT_TOKEN: evm.paymentToken,
          PAYMENTS_CONTRACT: evm.paymentsContract,
          RECORDS_CONTRACT: evm.recordsContract,
          COMMUNITY_ADDRESS: accounts[3]!.address,
          ACCOUNT_DELEGATE: evm.mockAccount,
          ACCOUNT_INITIALIZER: evm.mockInitializer,
          ...(providerKey ? { ELEVENLABS_API_KEY: providerKey } : {}),
        },
        durableObjects: {
          STATE: { className: "ServiceState", useSQLite: true },
        },
        outboundService: "elevenlabs",
        ...(options.operatorRoutes ? { routes: options.operatorRoutes } : {}),
      },
      {
        name: "elevenlabs",
        modules: true,
        script: simulator,
        compatibilityDate: "2026-07-30",
        bindings: {
          SIM_API_KEY: SIMULATED_KEY,
          SIM_STREAMS: JSON.stringify(options.streams),
          SIM_ALIGNMENT: JSON.stringify(options.alignment ?? DEFAULT_ALIGNMENT),
          RPC_ORIGIN: rpcOrigin,
        },
      },
      {
        name: "storage",
        modules: true,
        script: "export default {fetch(){return new Response('storage')}}",
        compatibilityDate: "2026-07-30",
        d1Databases: ["DB"],
        r2Buckets: ["MEDIA"],
      },
    ],
  });
  try {
    const mfUrl = await mf.ready;
    const db = await mf.getD1Database("DB", "storage"),
      media = (await mf.getR2Bucket("MEDIA", "storage")) as unknown as R2Bucket,
      operatorWorker = (await mf.getWorker("operator")) as unknown as Fetcher,
      simulatorWorker = await mf.getWorker("elevenlabs");
    await migrate(db);
    let now = options.now;
    const posts = releasePostsFixture(publisher, config),
      ipfs = new Map<string, Uint8Array>([
        [firstSongFixture.lyricsUri.slice(7), firstSongFixture.lyricBytes],
        [firstSongFixture.postUri.slice(7), firstSongFixture.postBytes],
      ]);
    const env = {
      DB: db,
      MEDIA: media,
      JOBS: { send: async () => {} },
      ASSETS: {
        fetch: (request: Request) =>
          options.assets?.(request) ??
          Promise.resolve(new Response("not_found", { status: 404 })),
      },
      COMMUNITY_NAME: firstSong.name,
      PLAN_ID: firstSong.planId,
      APPLICATION_PROFILE_HASH: `0x${"a".repeat(64)}`,
      CREATOR_PROFILE_HASH: `0x${"b".repeat(64)}`,
      COMMUNITY_PUBLISHER_PRIVATE_KEY: `0x${"12".repeat(32)}`,
      KARAOKE_OPERATOR: operatorWorker,
      KARAOKE_OPERATOR_ADDRESS: accounts[2]!.address,
      // A browser reaches the operator at Miniflare's address through its routes.
      KARAOKE_OPERATOR_ORIGIN:
        options.operatorOrigin ??
        (options.operatorRoutes ? mfUrl.origin : "https://operator.localhost"),
      KARAOKE_SIGNER_PRIVATE_KEY: keys[1]!,
      KARAOKE_COMMUNITY_ADDRESS: accounts[3]!.address,
      KARAOKE_PAYMENT_CHAIN_ID: "31337",
      KARAOKE_PAYMENT_TOKEN: evm.paymentToken,
      KARAOKE_RPC_URL: evm.rpcUrl,
      KARAOKE_SIGNATURE_CHAIN_ID: "31337",
      ...(providerKey ? { ALIGNMENT_ELEVENLABS_API_KEY: providerKey } : {}),
    } as unknown as CommunityEnv;
    const ports: CommunityDependencies = {
      configuration: async () => config,
      // Through the chain, so a smart account's signature verifies as on MegaETH.
      verifyLogin: (address, message, signature) =>
        evm.publicClient.verifyMessage({ address, message, signature }),
      creatorHealth: async () => false,
      publicReads: {
        client: posts.client,
        profile: posts.profile,
        transport: async (request) => {
          const cid = new URL(request.url).pathname.split("/").pop()!,
            bytes = ipfs.get(cid);
          return bytes
            ? new Response(Uint8Array.from(bytes), {
                headers: { "content-type": "application/json" },
              })
            : new Response("not_found", { status: 404 });
        },
      },
      // Miniflare's fetcher takes a URL and init, not a Node Request.
      alignmentTransport: {
        request: async (r) =>
          (await simulatorWorker.fetch(r.url, {
            method: r.method,
            headers: [...r.headers],
            body: await r.arrayBuffer(),
            redirect: "manual",
          })) as unknown as Response,
      },
      now: () => now * 1000,
    };
    const app = (path: string, init: RequestInit = {}) =>
      communityFetch(new Request(firstSong.origin + path, init), env, ports);
    const json = async <T>(response: Response) => ({
      status: response.status,
      value: (await response.json()) as T,
    });

    /** The published submission, its sealed stems and its on-chain post. */
    const publish = async () => {
      const minimum = options.stemMs ?? 120000,
        vocals = await syntheticMp3(minimum),
        instrumental = await syntheticMp3(minimum),
        created = now * 1000,
        p = firstSongFixture.post,
        stems: [string, Awaited<ReturnType<typeof syntheticMp3>>][] = [
          ["vocals", vocals],
          ["instrumental", instrumental],
        ];
      await db.batch([
        db
          .prepare(
            "INSERT INTO community_accounts(account_id,author_id,created_at) VALUES(?,?,?)",
          )
          .bind("owner", p.authorId, created),
        db
          .prepare(
            `INSERT INTO media_submissions(submission_id,account_id,author_id,post_id,idempotency_key,
            request_hash,metadata_json,captured_wallet,creator_json,audio_sha256,audio_bytes,object_key,
            upload_state,created_at,sealed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'sealed',?,?)`,
          )
          .bind(
            "first-song",
            "owner",
            p.authorId,
            p.postId,
            "first-song",
            `0x${"0".repeat(64)}`,
            "{}",
            publisher.address.toLowerCase(),
            "{}",
            p.media[0].sha256,
            p.media[0].byteLength,
            "audio/first-song",
            created,
            created,
          ),
        db
          .prepare(
            `INSERT INTO publication_jobs(job_id,submission_id,input_hash,authority_json,phase,due_at,created_at,updated_at)
            VALUES(?,?,?,?,'published',?,?,?)`,
          )
          .bind(
            "first-song-job",
            "first-song",
            `0x${"0".repeat(64)}`,
            JSON.stringify({ communityId: config.communityId }),
            created,
            created,
            created,
          ),
      ]);
      for (const [slot, stem] of stems) {
        const key = `stems/first-song/${slot}`,
          object = await media.put(key, stem.bytes, {
            customMetadata: { sha256: stem.sha256 },
          });
        await db
          .prepare(
            `INSERT INTO media_stems(submission_id,slot,sha256,byte_length,state,object_key,object_etag,duration_ms,created_at,sealed_at)
            VALUES(?,?,?,?,'sealed',?,?,?,?,?)`,
          )
          .bind(
            "first-song",
            slot,
            stem.sha256,
            stem.bytes.byteLength,
            key,
            object!.etag,
            stem.durationMs,
            created,
            created,
          )
          .run();
      }
      const raw = await publisher.signTransaction({
        chainId: 6343,
        type: "legacy",
        nonce: 3,
        gas: 300000n,
        gasPrice: 1000000n,
        to: config.postsContract,
        data: encodeFunctionData({
          abi: postsAbi,
          functionName: "publishRevision",
          args: [
            p.communityId,
            p.postId,
            0n,
            BigInt(p.configurationRevision),
            p.authorId,
            0,
            firstSongFixture.postSha256,
            firstSongFixture.postUri,
          ],
        }),
      });
      await posts.client.sendRawTransaction({ serializedTransaction: raw });
      posts.mine();
      return { vocals, instrumental };
    };

    /** The controller's signed request for the song's one forced alignment. */
    const align = async (
      signer: PrivateKeyAccount = controller,
      overrides: Partial<AlignmentRequest> = {},
    ) => {
      const vocal = await db
        .prepare(
          "SELECT sha256 FROM media_stems WHERE submission_id='first-song' AND slot='vocals'",
        )
        .first<{ sha256: Hex }>();
      const request: AlignmentRequest = {
        schema: "pirate.song-alignment-request/1",
        communityId: config.communityId,
        postId: firstSongFixture.postId,
        lyricsRevision: 1,
        lyricsSha256: firstSongFixture.lyricsSha256,
        vocalSha256: vocal!.sha256,
        expiresAt: now + 300,
        ...overrides,
      };
      return json<Record<string, unknown>>(
        await app("/api/operator/song-alignment", {
          method: "POST",
          headers: {
            origin: firstSong.origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            request,
            signature: await signer.signMessage({
              message: alignmentRequestMessage(request),
            }),
          }),
        }),
      );
    };

    /** SIWE sign-in through the application, as the browser does it. */
    const signIn = async (wallet: {
      address: Address;
      signMessage: PrivateKeyAccount["signMessage"];
    }) => {
      const challenge = await json<{ id: string; message: string }>(
        await app("/api/auth/challenge", {
          method: "POST",
          headers: {
            origin: firstSong.origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({ address: wallet.address }),
        }),
      );
      const verified = await app("/api/auth/verify", {
        method: "POST",
        headers: {
          origin: firstSong.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: challenge.value.id,
          signature: await wallet.signMessage({
            message: challenge.value.message,
          }),
        }),
      });
      const body = (await verified.json()) as { csrf: string };
      return {
        cookie: verified.headers.get("set-cookie")!.split(";")[0]!,
        csrf: body.csrf,
        wallet: wallet.address.toLowerCase() as Address,
      };
    };
    type Session = Awaited<ReturnType<typeof signIn>>;
    const get = <T>(session: Session | null, path: string) =>
      app(path, session ? { headers: { cookie: session.cookie } } : {}).then(
        (r) => json<T>(r),
      );
    const post = <T>(session: Session, path: string, body: unknown) =>
      app(path, {
        method: "POST",
        headers: {
          origin: firstSong.origin,
          "content-type": "application/json",
          cookie: session.cookie,
          "x-csrf-token": session.csrf,
        },
        body: JSON.stringify(body),
      }).then((r) => json<T>(r));

    /** Moves the operator's and the application's clocks, and the chain if behind. */
    const at = async (t: number) => {
      now = t;
      const head = Number((await evm.publicClient.getBlock()).timestamp);
      if (t > head) {
        await evm.rpc("evm_setNextBlockTimestamp", [t]);
        await evm.rpc("evm_mine", []);
      }
      const response = await operatorWorker.fetch("http://service/__clock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ now: t }),
      });
      if (!response.ok) throw new Error(`clock: ${await response.text()}`);
    };
    const operatorState = async (prefix: string) =>
      (
        (await (
          await operatorWorker.fetch("http://service/__state")
        ).json()) as {
          key: string;
          value: unknown;
        }[]
      ).filter((r) => r.key.startsWith(prefix));
    const simulatorLog = async () =>
      (await (
        await simulatorWorker.fetch("http://simulator/__simulator/log")
      ).json()) as {
        minted: number;
        streams: SimulatedStreamLog[];
        alignment: SimulatedAlignmentLog;
      };
    return {
      mf,
      persist,
      config,
      env,
      ports,
      db,
      media,
      app,
      json,
      get,
      post,
      signIn,
      publish,
      align,
      at,
      now: () => now,
      operator: operatorWorker,
      operatorState,
      simulatorLog,
      dispose: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
export type KaraokeLive = Awaited<ReturnType<typeof karaokeLive>>;

/** The timed manifest the simulated provider yields for the published lyrics. */
export async function expectedKaraoke(
  alignment: SimulatedAlignment = DEFAULT_ALIGNMENT,
  stemMs = 120000,
) {
  const { durationMs } = await syntheticMp3(stemMs);
  return publishedKaraokeManifest(
    firstSongFixture.lyrics,
    alignmentResult(
      simulatedAlignment(firstSongFixture.lyrics.sourceText, alignment),
      firstSongFixture.lyrics,
      durationMs,
    ),
    KARAOKE_MAX_SEGMENT_MS,
  );
}
/** What the simulated provider hears: every word as written, or chosen lines mumbled. */
export function sungStream(
  manifest: KaraokeManifest,
  options: { mumbled?: number[]; fromMs?: number; toMs?: number } = {},
): SimulatedStream {
  const from = options.fromMs ?? 0;
  return {
    words: manifest.lines
      .filter((l) => l.startMs >= from && l.endMs <= (options.toMs ?? Infinity))
      .flatMap((line) =>
        line.words.map((w) => ({
          text: options.mumbled?.includes(line.ordinal) ? "mumble" : w.text,
          start: (w.startMs - from) / 1000,
          end: (w.endMs - from) / 1000,
        })),
      ),
  };
}
