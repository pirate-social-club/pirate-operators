import { decodeEventLog, keccak256, type Hex, type PublicClient } from "viem";
import { canonical, insist } from "../packages/community/common.ts";
import { fetchPublicIpfs, readBounded, type IpfsTransport } from "../packages/community/ipfs.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { RecognitionProfile } from "../packages/recognition/intent.ts";
import { verifyCatalogSongPublicProof, type CatalogSongRecord } from "./catalog-song-public-proof.ts";
import { postsAbi, publicationEvent, type PostsProfile } from "../packages/community/post-chain.ts";
import { quarantined, validatePostForEvent, type PublicationEvent } from "../packages/community/post-manifest.ts";
import { directoryV3Abi, type Web2DirectoryProfile } from "../packages/community/web2-directory.ts";
import { evaluateWeb2Eligibility, readWeb2Community, type Web2EligibilityPolicy } from "../packages/community/web2-directory-reader.ts";

export const sharedSongFeedPath = "/api/public/shared-feed";
const openPath = /^\/api\/public\/shared-feed\/(0x[0-9a-f]{64})\/(0x[0-9a-f]{64})\/open$/;
// The pilot replays a single admitted Posts deployment. Fail closed before
// exposing a feed from a truncated history. A scaled index is a separate input.
const scanPageSize = 10_000n;
const scanPageLimit = 64n;
const feedLimit = 12;

interface SharedSongFeedPorts {
  client: PublicClient;
  directory: Web2DirectoryProfile;
  posts: PostsProfile;
  policy: Web2EligibilityPolicy;
  transport?: IpfsTransport;
  catalogReady(record: CatalogSongRecord, origin: string, issued: CommunityConfig, signal: AbortSignal): Promise<boolean>;
}

export async function remoteCatalogSongReady(
  origins: ReadonlySet<string>,
  origin: string,
  record: CatalogSongRecord,
  profile: RecognitionProfile,
  now: number,
  signal: AbortSignal,
  send: IpfsTransport = fetch,
) {
  if (!origins.has(origin)) return false;
  const response = await send(new Request(origin + "/api/public/posts/" + record.post.postId + "/catalog-proof", {
    redirect: "manual", credentials: "omit",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    headers: { accept: "application/json", "cache-control": "no-cache" },
  }));
  if (response.status !== 200) {
    await response.body?.cancel();
    return false;
  }
  const bytes = await readBounded(response, 16 * 1024);
  await verifyCatalogSongPublicProof(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), { record, profile, now },
  );
  return true;
}

async function sharedSongs(
  ports: SharedSongFeedPorts,
  signal: AbortSignal,
  target?: { communityId: Hex; postId: Hex },
) {
  const { client, directory, posts, policy } = ports;
  const started = policy.now();
  signal.throwIfAborted();
  insist(directory.chainId === 6343 && await client.getChainId() === 6343, "wrong_application_chain", 503);
  const safe = await client.getBlock({ blockTag: "safe" });
  insist(
    safe.hash && typeof safe.number === "bigint" && safe.number >= directory.deploymentBlock &&
      safe.number >= posts.deploymentBlock && safe.timestamp <= started &&
      started - safe.timestamp <= policy.maxSafeBlockAgeSeconds &&
      safe.number - directory.deploymentBlock < scanPageSize * scanPageLimit &&
      safe.number - posts.deploymentBlock < scanPageSize * scanPageLimit,
    "shared_song_feed_head_unavailable",
    503,
  );
  const [directoryCode, postCode, postDirectory] = await Promise.all([
    client.getCode({ address: directory.directory, blockNumber: safe.number }),
    client.getCode({ address: posts.address, blockNumber: safe.number }),
    client.readContract({ address: posts.address, abi: postsAbi, functionName: "directory", blockNumber: safe.number }),
  ]);
  insist(directoryCode && keccak256(directoryCode) === directory.directoryCodeHash &&
    postCode && keccak256(postCode) === posts.runtimeCodeHash && postDirectory.toLowerCase() === directory.directory,
    "shared_song_feed_deployment_changed", 503);

  const fetchLogs = (fromBlock: bigint, toBlock: bigint) => client.getLogs({
    address: posts.address, event: postsAbi[3], fromBlock, toBlock, strict: true,
    ...(target ? { args: target } : {}),
  });
  type PostLog = Awaited<ReturnType<typeof fetchLogs>>[number];
  const newest = new Map<string, PostLog>();
  for (let from = posts.deploymentBlock; from <= safe.number; from += scanPageSize) {
    signal.throwIfAborted();
    const to = from + scanPageSize - 1n < safe.number ? from + scanPageSize - 1n : safe.number;
    const logs = await fetchLogs(from, to);
    insist(logs.length <= 1000, "shared_song_feed_replay_too_large", 503);
    for (const log of logs) {
      if (log.args.kind !== 0) continue;
      const event = publicationEvent(log.args, posts);
      insist(log.address.toLowerCase() === posts.address && !log.removed &&
        log.blockNumber >= from && log.blockNumber <= to &&
        log.blockHash && log.transactionHash && Number.isSafeInteger(log.logIndex) &&
        (!target || event.communityId === target.communityId && event.postId === target.postId),
        "shared_song_feed_log_changed", 503);
      const key = event.communityId + event.postId;
      const prior = newest.get(key);
      if (prior && log.args.revision === prior.args.revision)
        insist(log.blockHash === prior.blockHash && log.transactionHash === prior.transactionHash &&
          log.logIndex === prior.logIndex && canonical(publicationEvent(prior.args, posts)) === canonical(event),
          "shared_song_feed_log_conflict", 503);
      if (!prior || log.args.revision > prior.args.revision) newest.set(key, log);
    }
    insist(newest.size <= 1000, "shared_song_feed_replay_too_large", 503);
  }

  const directoryCall = { address: directory.directory, abi: directoryV3Abi } as const;
  const authorities = new Map<Hex, Awaited<ReturnType<typeof readWeb2Community>> | null>();
  const visible: { record: CatalogSongRecord; authority: Awaited<ReturnType<typeof readWeb2Community>>; event: PublicationEvent }[] = [];
  // Reverse canonical log order; the arrival order and manifest timestamp never
  // select a current revision. Feed remains bounded to the recent pilot page.
  const ordered = [...newest.values()].sort((a, b) =>
    a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1);
  for (const log of ordered.slice(0, target ? 1 : 48)) {
    signal.throwIfAborted();
    if (visible.length === feedLimit) break;
    const event = publicationEvent(log.args, posts);
    const query = { ...directoryCall, args: [event.communityId], blockNumber: safe.number } as const;
    if (!authorities.has(event.communityId)) {
      let authority = null;
      if (await client.readContract({ ...query, functionName: "isDiscoverable" })) {
        const binding = await client.readContract({ ...query, functionName: "getBinding" });
        const read = await readWeb2Community(client, {
          ...directory, ...binding, communityId: event.communityId,
        }, policy, ports.transport);
        if (read.config.postsContract === posts.address && read.blockNumber >= safe.number &&
            read.eligibility.status === "available" && read.eligibility.discoverable) authority = read;
      }
      authorities.set(event.communityId, authority);
    }
    const authority = authorities.get(event.communityId);
    if (!authority) continue;
    const history = [...authority.history];
    if (quarantined(event, log.blockNumber, history, authority.config)) continue;
    const config = history.find(c => c.configurationRevision === event.configurationRevision);
    insist(config, "publication_configuration_missing", 503);
    const [block, receipt] = await Promise.all([
      client.getBlock({ blockNumber: log.blockNumber }),
      client.getTransactionReceipt({ hash: log.transactionHash }),
    ]);
    const included = receipt.logs.find(included => included.logIndex === log.logIndex &&
      included.address.toLowerCase() === posts.address);
    if (block.hash !== log.blockHash || receipt.status !== "success" ||
        receipt.transactionHash !== log.transactionHash || receipt.blockHash !== log.blockHash ||
        receipt.blockNumber !== log.blockNumber || !included || included.removed ||
        included.transactionHash !== log.transactionHash || included.blockHash !== log.blockHash ||
        included.blockNumber !== log.blockNumber) continue;
    const decoded = decodeEventLog({
      abi: postsAbi, eventName: "PostRevisionPublished", strict: true, topics: included.topics, data: included.data,
    });
    if (canonical(publicationEvent(decoded.args, posts)) !== canonical(event)) continue;
    try {
      const { bytes } = await fetchPublicIpfs(event.manifestURI, event.manifestSha256, 1024 * 1024, ports.transport);
      const post = validatePostForEvent(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), event, config);
      const record = {
        post, transactionHash: log.transactionHash, blockNumber: String(log.blockNumber), blockHash: log.blockHash,
      };
      if (post.rating === "general" &&
          (post.schema !== "pirate.community-post/4" || await ports.catalogReady(record, authority.config.app.origin, config, signal)))
        visible.push({ record, authority, event });
    } catch {
      // A withheld, malformed, or temporarily unavailable song has no feed row.
    }
  }

  signal.throwIfAborted();
  const tip = await client.getBlock({ blockTag: "latest" });
  insist(tip.hash && tip.number >= safe.number && tip.timestamp >= safe.timestamp, "shared_song_feed_tip_unavailable", 503);
  const currentListing = new Map<Hex, boolean>();
  const current = [];
  for (const item of visible) {
    signal.throwIfAborted();
    const { authority, record } = item;
    const { communityId, postId } = record.post;
    if (!currentListing.has(communityId)) {
      const query = { ...directoryCall, args: [communityId], blockNumber: tip.number } as const;
      const [row, discoverable, authorityBlock] = await Promise.all([
        client.readContract({ ...query, functionName: "getCommunity" }),
        client.readContract({ ...query, functionName: "isDiscoverable" }),
        client.getBlock({ blockNumber: authority.blockNumber }),
      ]);
      currentListing.set(communityId, row.listed && discoverable &&
        row.listingRevision === authority.verificationSnapshot.listingRevision &&
        row.configurationRevision === BigInt(authority.config.configurationRevision) &&
        row.configuration.sha256Digest === authority.configurationEvidence.log.args.sha256Digest &&
        authorityBlock.hash === authority.blockHash && authority.blockNumber <= tip.number);
    }
    if (!currentListing.get(communityId)) continue;
    const post = await client.readContract({
      address: posts.address, abi: postsAbi, functionName: "getPost",
      args: [communityId, postId], blockNumber: tip.number,
    });
    if (post.kind === 0 &&
        canonical(publicationEvent({ ...post, communityId, postId }, posts)) === canonical(item.event))
      current.push(item);
  }
  const [confirmed, tipAgain] = await Promise.all([
    client.getBlock({ blockNumber: safe.number }),
    client.getBlock({ blockNumber: tip.number }),
  ]);
  const now = policy.now();
  signal.throwIfAborted();
  insist(confirmed.hash === safe.hash && tipAgain.hash === tip.hash && now >= started &&
    now >= tip.timestamp && now - safe.timestamp <= policy.maxSafeBlockAgeSeconds,
    "shared_song_feed_head_changed", 503);
  return current.filter(({ authority }) => {
    const status = evaluateWeb2Eligibility(authority.verificationSnapshot, now, policy.maxSafeBlockAgeSeconds);
    return status.status === "available" && status.discoverable;
  });
}

export async function sharedSongFeedResponse(request: Request, ports: SharedSongFeedPorts) {
  const url = new URL(request.url);
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
  const error = (code: string, status: number) => Response.json({ error: code }, { status, headers });
  const open = openPath.exec(url.pathname);
  if (!open && url.pathname !== sharedSongFeedPath) return error("not_found", 404);
  if (request.method !== "GET" || url.search) return error("method_not_allowed", 405);
  try {
    const songs = await sharedSongs(ports, request.signal,
      open ? { communityId: open[1] as Hex, postId: open[2] as Hex } : undefined);
    if (open) {
      const song = songs[0];
      if (!song) return error("shared_song_not_found", 404);
      return new Response(null, { status: 302, headers: {
        ...headers, location: song.authority.config.app.origin + "/#song-" + song.record.post.postId,
      } });
    }
    return Response.json({ schema: "pirate.shared-song-feed/1", songs: songs.map(({ authority, record }) => ({
      communityId: record.post.communityId,
      communityName: authority.config.app.label,
      postId: record.post.postId,
      title: record.post.title,
    })) }, { headers });
  } catch {
    return error("shared_song_feed_unavailable", 503);
  }
}
