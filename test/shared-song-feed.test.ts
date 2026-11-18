import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonical, hashJson } from "../packages/community/common.ts";
import { preparePin } from "../packages/community/ipfs.ts";
import { postsAbi, publicationData } from "../packages/community/post-chain.ts";
import { CATALOG_OWNER_POLICY_HASH, CATALOG_OWNER_POLICY_VERSION } from "../packages/community/owner-policy.ts";
import { directoryInstanceId } from "../packages/community/shared-identity.ts";
import { validateWeb2Profile, web2ProfileDocument } from "../packages/community/web2-directory.ts";
import { communityFetch, type CommunityEnv } from "../services/community-application.ts";
import { web2DirectoryFixture, h, a } from "./fixtures/web2-directory.ts";
import { signReservation } from "../packages/recognition/reservation-receipt.ts";
import { catalogSongPublicProof, type CatalogSongRecord } from "../services/catalog-song-public-proof.ts";
import { sharedSongFeedResponse, remoteCatalogSongReady } from "../services/shared-song-feed.ts";

// A delayed listing change or reorg during hydration can leak an old listing.
// A renewal must preserve a delist. Bad manifests, unsupported video, and stale
// public URLs must never surface. RPC facts and IPFS bodies are fixture inputs.
for (const isCatalog of [false, true]) test(
  (isCatalog ? "/4 catalog " : "/3 public ") + "shared feed obeys listing revisions, canonical history and verified visibility",
  async (t) => {
  const signer = privateKeyToAccount(h("7"));
  const profile = {
    schema: "pirate.recognition-profile/1" as const,
    namespace: h("8"),
    origin: "https://recognition.example",
    signer: signer.address.toLowerCase(),
    providerBindingSha256: h("d"),
  };
  const recognition = { ...profile, sha256: hashJson(profile) };
  const f = await web2DirectoryFixture(1, "", isCatalog ? {
    admission: { version: CATALOG_OWNER_POLICY_VERSION, sha256: CATALOG_OWNER_POLICY_HASH },
    moderationSigner: a("6"), recognition,
  } : undefined, 6343);
  const config = f.records[0]!.c;
  const media = await preparePin(new Uint8Array([4, 5, 6]), "audio/mpeg");
  const manifest = {
    schema: isCatalog ? "pirate.community-post/4" : "pirate.community-post/3",
    ...(isCatalog ? {
      terms: { revision: 1, allowsDerivatives: true },
      recognition: {
        namespace: recognition.namespace, profileSha256: recognition.sha256, intentSha256: h("d"),
        reservationId: h("e"), recordingId: h("f"),
      },
    } : {}),
    chainId: 6343,
    postsContract: config.postsContract,
    communityId: config.communityId,
    postId: h("2"),
    authorId: h("3"),
    kind: "song",
    revision: 1,
    configurationRevision: 1,
    publishedAt: 65536,
    title: "Public song",
    language: "en",
    rating: "general",
    media: [{ ...media, role: "audio" }],
    admission: {
      policyVersion: config.policies.admission.version,
      policySha256: config.policies.admission.sha256,
      decision: "publish",
      rating: "general",
      coverDisplayed: false,
      evidenceSha256: h("9"),
      automatedContent: "deferred",
      declarationSource: "operator_declared",
    },
    registration: { status: "absent", reason: "deferred_for_launch" },
  };
  const json = canonical(manifest);
  const pin = await preparePin(new TextEncoder().encode(json), "application/json");
  const args = {
    communityId: config.communityId,
    postId: manifest.postId,
    authorId: manifest.authorId,
    kind: 0,
    revision: 1n,
    configurationRevision: 1n,
    manifestURI: pin.uri,
    manifestSha256: pin.sha256,
  };
  const raw = await privateKeyToAccount(h("5")).signTransaction({
    data: publicationData({ ...args, configurationRevision: 1 }), to: config.postsContract, type: "legacy",
    chainId: 6343, gas: 50_000n, gasPrice: 7n, nonce: 0,
  });
  const posting = {
    transactionHash: keccak256(raw), signedTransaction: raw, nonce: 0,
    operationId: h("5"), requestHash: h("6"),
  };
  const log = {
    address: config.postsContract,
    args,
    blockNumber: 57n,
    blockHash: f.state.hash,
    transactionHash: posting.transactionHash,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({ abi: postsAbi, eventName: "PostRevisionPublished", args }),
    data: encodeAbiParameters(
      postsAbi[3].inputs.slice(3),
      [0, 1n, 1n, pin.sha256, pin.uri],
    ),
  };
  const row = isCatalog ? {
    posting_json: canonical(posting),
    chain_receipt_json: canonical({
      blockHash: log.blockHash, blockNumber: String(log.blockNumber),
      transactionHash: log.transactionHash, postId: manifest.postId, revision: 1,
    }),
    promotion_receipt_json: canonical(await signReservation(signer, {
      schema: "pirate.recognition-reservation-receipt/1", purpose: "publication_promoted",
      namespace: profile.namespace, profileSha256: recognition.sha256, communityId: config.communityId,
      configurationRevision: 1, requestSha256: h("f"),
      intentSha256: h("d"), reservationId: h("e"), recordingId: h("f"),
      state: "committed", recordingState: "ready", postingSha256: hashJson(posting),
      publicationSha256: h("1"), issuedAt: Number(f.state.now) - 600, expiresAt: Number(f.state.now) - 570,
    })),
  } : undefined;
  const video = { ...log, args: { ...args, kind: 1, postId: h("7") }, logIndex: 1 };
  let latestHidden = false, orphaned = false, tampered = false, promoted = false;
  let delistOnHydration = false, corruptPeerProof = false;
  let latestListingRevision = 1n, reads = 0;
  const latestNumber = f.state.safe + 1n;
  const client = {
    ...f.client,
    getBlockNumber: async () => latestNumber,
    getBlock: async (params: Parameters<PublicClient["getBlock"]>[0]) => {
      const block = await f.client.getBlock(params?.blockTag === "latest" ? { blockNumber: latestNumber } : params);
      return params?.blockNumber === log.blockNumber && orphaned ? { ...block, hash: h("b") } : block;
    },
    getLogs: async (params: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }) =>
      params.address === config.postsContract
        ? [video, log, log].filter(item => item.blockNumber >= params.fromBlock && item.blockNumber <= params.toBlock)
        : f.client.getLogs(params),
    getCode: async (params: { address: `0x${string}`; blockNumber: bigint }) =>
      params.address === config.postsContract ? "0x6000" : f.client.getCode(params),
    getTransactionReceipt: async (params: { hash: `0x${string}` }) =>
      params.hash === log.transactionHash
        ? { ...log, status: "success", logs: [log] }
        : f.client.getTransactionReceipt(params),
    readContract: async (params: Parameters<PublicClient["readContract"]>[0]) => {
      if (params.functionName === "getPost") return args;
      if (params.functionName === "directory") return config.directory;
      const value = await f.client.readContract(params);
      if (params.blockNumber !== latestNumber) return value;
      if (params.functionName === "getCommunity")
        return { ...(value as object), listed: !latestHidden, listingRevision: latestListingRevision };
      if (params.functionName === "isDiscoverable") return !latestHidden;
      return value;
    },
  } as unknown as PublicClient;
  const options = {
    client,
    directory: f.profile,
    posts: { address: config.postsContract, deploymentBlock: 55n, runtimeCodeHash: keccak256("0x6000") },
    policy: f.policy,
    transport: async (request: Request) => {
      if (request.url.endsWith("/" + media.uri.slice(7))) return new Response(new Uint8Array([4, 5, 6]));
      if (!request.url.endsWith("/" + pin.uri.slice(7))) return f.transport(request);
      reads++;
      if (delistOnHydration) {
        latestHidden = true;
        latestListingRevision = 2n;
      }
      return new Response(tampered ? json.replace("Public song", "Other title") : json);
    },
    catalogReady: (record: CatalogSongRecord, origin: string) =>
      remoteCatalogSongReady(new Set([config.app.origin]), origin, record, recognition,
        Number(f.state.now), new AbortController().signal, async request => {
          assert.equal(isCatalog, true);
          assert.equal(request.url, config.app.origin + "/api/public/posts/" + manifest.postId + "/catalog-proof");
          assert.equal(request.headers.has("cookie"), false);
          assert.equal(request.redirect, "manual");
          if (!promoted) return Response.json({ error: "catalog_pending" }, { status: 503 });
          const proof = await catalogSongPublicProof(row!, { record, profile: recognition, now: Number(f.state.now) });
          return Response.json(corruptPeerProof ? {
            ...proof, posting: { ...proof.posting, requestHash: h("0") },
          } : proof);
        }),
  };
  const api = "https://shared.example/api/public/shared-feed";
  const open = [api, config.communityId, manifest.postId, "open"].join("/");
  const feed = async () => {
    const response = await sharedSongFeedResponse(new Request(api), options);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return (await response.json() as { songs: { title: string }[] }).songs;
  };
  if (isCatalog) {
    assert.deepEqual(await feed(), []);
    promoted = true;
    corruptPeerProof = true;
    assert.deepEqual(await feed(), []);
    corruptPeerProof = false;
  }
  assert.deepEqual((await feed()).map(s => s.title), ["Public song"]);
  let go = await sharedSongFeedResponse(new Request(open), options);
  assert.equal(go.status, 302);
  assert.equal(go.headers.get("location"), config.app.origin + "/#song-" + manifest.postId);
  assert.equal(go.headers.get("cache-control"), "no-store");

  delistOnHydration = true;
  assert.deepEqual(await feed(), []);
  delistOnHydration = false;
  go = await sharedSongFeedResponse(new Request(open), options);
  assert.equal(go.status, 404);
  assert.equal(go.headers.get("location"), null);

  f.state.listed = false;
  f.state.listingRevision = 2n;
  f.state.web2ValidUntil += 100n;
  const readsBeforeDelisted = reads;
  assert.deepEqual(await feed(), []);
  assert.equal(reads, readsBeforeDelisted);

  latestHidden = false;
  latestListingRevision = 3n;
  assert.deepEqual(await feed(), []);
  f.state.listed = true;
  f.state.listingRevision = 3n;
  assert.equal((await feed()).length, 1);

  const deployment = {
    schema: "pirate.community-deployment/2" as const,
    directoryProfile: web2ProfileDocument(f.profile),
    origin: config.app.origin,
    name: config.app.label,
    planId: "1".repeat(64),
    postingPeriod: "fixture",
    rpcUrl: "https://rpc.example",
    ipfsGateways: ["https://ipfs.example"],
    managedOrigin: "https://managed.example",
    freshness: { maxSafeBlockAgeSeconds: String(f.policy.maxSafeBlockAgeSeconds) },
    posts: { ...options.posts, deploymentBlock: String(options.posts.deploymentBlock) },
  };
  const dependencies = {
    deployment,
    publicReads: { client, profile: options.posts, transport: options.transport },
    now: () => Number(f.state.now) * 1000,
    async configuration(): Promise<never> { throw new Error("feed used local session configuration"); },
    async freshConfiguration(): Promise<never> { throw new Error("feed used local private authority"); },
    async verifyLogin(): Promise<never> { throw new Error("feed asked for login"); },
    async creatorHealth(): Promise<never> { throw new Error("feed read creator credentials"); },
  };
  const localFeed = new Request(config.app.origin + "/api/public/shared-feed");
  const db = {
    withSession() { return this; },
    prepare(sql: string) {
      return { bind(...params: string[]) {
        return {
          first: async () => sql.includes("FROM chain_scan_state")
            ? { next_block: String(f.state.safe + 1n), checkpoint_hash: f.state.hash }
            : promoted ? row : null,
          all: async () => ({ results: params[2] && params[2] !== manifest.postId ? [] : [{
            community_id: config.communityId, post_id: manifest.postId, revision: 1,
            author_id: manifest.authorId, configuration_revision: 1, manifest_uri: pin.uri,
            manifest_sha256: pin.sha256, manifest_json: json, block_number: String(log.blockNumber),
            block_hash: log.blockHash, transaction_hash: log.transactionHash, log_index: 0, quarantined: 0,
          }] }),
        };
      }};
    },
  };
  const env = { DB: db } as unknown as CommunityEnv;
  const feedProfile = (proofOrigins: string[]) => canonical({
    schema: "pirate.shared-song-feed-profile/1", recognition: isCatalog ? recognition : null, proofOrigins,
  });
  const selected = { ...env, COMMUNITY_SHARED_SONG_FEED_JSON: feedProfile([]) };
  assert.equal((await communityFetch(localFeed, env, dependencies)).status, 404);
  const mounted = await communityFetch(localFeed, selected, dependencies);
  assert.equal(mounted.status, 200);
  assert.deepEqual((await mounted.json() as { songs: { title: string }[] }).songs.map(song => song.title), ["Public song"]);

  if (isCatalog) {
    const sourcePorts = {
      ...dependencies, configuration: async () => config,
      freshConfiguration: async () => config,
    };
    const source = (request: Request) => communityFetch(request, selected, sourcePorts);
    const catalogURL = config.app.origin + "/api/public/posts/" + manifest.postId + "/catalog-proof";
    const targetKey = h("8");
    const receiverProfile = validateWeb2Profile({
      ...f.profile, communityId: directoryInstanceId(6343, targetKey),
      communityKey: targetKey, installationId: h("a"),
    });
    const receiverOrigin = "https://feed-reader.example";
    const receiverPorts = { ...dependencies, deployment: {
      ...deployment, origin: receiverOrigin, directoryProfile: web2ProfileDocument(receiverProfile),
    } };
    const receiver = {
      ...selected,
      DB: undefined as unknown as D1Database,
      COMMUNITY_SHARED_SONG_FEED_JSON: feedProfile([config.app.origin]),
    };
    const receiverFeed = () => communityFetch(
      new Request(receiverOrigin + "/api/public/shared-feed"), receiver, receiverPorts,
    );
    const fetch = t.mock.method(globalThis, "fetch", async (request: Request) => {
      assert.equal(request.url, catalogURL);
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers.has("cookie"), false);
      return source(request);
    });
    const catalogRequest = () => new Request(catalogURL);
    assert.equal((await source(new Request(catalogURL.replace(manifest.postId, h("9"))))).status, 404);
    promoted = false;
    const pending = await source(catalogRequest());
    assert.equal(pending.status, 503);
    assert.deepEqual(await pending.json(), { error: "catalog_pending" });
    assert.deepEqual((await (await receiverFeed()).json() as { songs: unknown[] }).songs, []);
    promoted = true;
    const portable = await source(catalogRequest());
    assert.equal(portable.status, 200);
    assert.equal(portable.headers.get("cache-control"), "no-store");
    assert.deepEqual(Object.keys(await portable.json() as object).sort(), ["posting", "receipt", "schema"]);
    const readback = await receiverFeed();
    assert.equal(readback.status, 200);
    assert.deepEqual((await readback.json() as { songs: { communityId: string }[] }).songs.map(song => song.communityId), [config.communityId]);
    assert.equal(fetch.mock.callCount(), 2);
    const unapproved = await communityFetch(
      new Request(receiverOrigin + "/api/public/shared-feed"),
      { ...receiver, COMMUNITY_SHARED_SONG_FEED_JSON: canonical({
        schema: "pirate.shared-song-feed-profile/1", recognition: null, proofOrigins: [],
      }) },
      receiverPorts,
    );
    assert.deepEqual((await unapproved.json() as { songs: unknown[] }).songs, []);
    assert.equal(fetch.mock.callCount(), 2);
    const open = receiverOrigin + "/api/public/shared-feed/" + config.communityId + "/" + manifest.postId + "/open";
    const target = await communityFetch(new Request(open), receiver, receiverPorts);
    assert.equal(target.headers.get("location"), config.app.origin + "/#song-" + manifest.postId);
    const mediaReadback = await source(new Request(config.app.origin + "/api/public/posts/" + manifest.postId + "/audio", {
      headers: { range: "bytes=1-2" },
    }));
    assert.equal(mediaReadback.status, 206);
    assert.equal(mediaReadback.headers.get("content-range"), "bytes 1-2/3");
    assert.deepEqual([...new Uint8Array(await mediaReadback.arrayBuffer())], [5, 6]);
    latestHidden = true;
    latestListingRevision = 4n;
    const delistedOpen = await communityFetch(new Request(open), receiver, receiverPorts);
    assert.equal(delistedOpen.status, 404);
    assert.equal(delistedOpen.headers.get("location"), null);
    assert.equal((await source(catalogRequest())).status, 200);
    latestHidden = false;
    latestListingRevision = 5n;
    f.state.listingRevision = 5n;
    assert.equal((await communityFetch(new Request(open), receiver, receiverPorts)).status, 302);
    fetch.mock.restore();
  }

  tampered = true;
  assert.deepEqual(await feed(), []);
  tampered = false;
  orphaned = true;
  assert.deepEqual(await feed(), []);
  orphaned = false;
  f.state.web2ValidUntil = f.state.now + 1n;
  f.state.now += 1n;
  assert.deepEqual(await feed(), []);
  f.state.now += f.policy.maxSafeBlockAgeSeconds + 1n;
  assert.equal((await sharedSongFeedResponse(new Request(api), options)).status, 503);
});
