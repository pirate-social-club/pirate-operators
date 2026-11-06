// Public chain/IPFS transport only. Captures raw bytes and metadata, not reduced
// results or qualification decisions. No wallet, operator API or private store.
import {
  decodeEventLog,
  hexToBytes,
  keccak256,
  toHex,
  type Hex,
  type PublicClient,
} from "viem";
import { directoryAbi } from "../../packages/community/directory-reader.ts";
import { postsAbi } from "../../packages/community/post-chain.ts";
import { fetchPublicIpfs } from "../../packages/community/ipfs.ts";
import {
  abi,
  resultManifestUri,
  type RawBlock,
  type RawLog,
  type ReferenceProfile,
  type ReferenceSnapshot,
} from "./facts.ts";
import { integer, learningDay, lower, requireFact } from "./checks.ts";

const rawLog = (log: any): RawLog => {
  requireFact(
    log.blockNumber !== null &&
      log.blockHash &&
      log.transactionHash &&
      Number.isSafeInteger(log.logIndex) &&
      Number.isSafeInteger(log.transactionIndex),
    "pending_log",
  );
  return {
    address: log.address,
    blockNumber: String(log.blockNumber),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    data: log.data,
    topics: [...log.topics] as [Hex, ...Hex[]],
    removed: !!log.removed,
  };
};
const rawBlock = (block: any): RawBlock => {
  requireFact(block.number !== null && block.hash, "pending_block");
  return {
    number: String(block.number),
    hash: block.hash,
    timestamp: String(block.timestamp),
  };
};
async function groups<T, R>(items: T[], work: (item: T) => Promise<R>) {
  const rows: R[] = [];
  for (let i = 0; i < items.length; i += 8)
    rows.push(...(await Promise.all(items.slice(i, i + 8).map(work))));
  return rows;
}

export async function captureReference(
  client: PublicClient,
  profile: ReferenceProfile,
  requestedHead?: bigint,
  evaluationTimestamp?: number,
): Promise<ReferenceSnapshot> {
  requireFact(
    [6343, 31337].includes(profile.chainId) &&
      (await client.getChainId()) === profile.chainId,
    "wrong_capture_chain",
  );
  const confirmed = (await client.getBlockNumber({ cacheTime: 0 })) - 1n;
  const headNumber = requestedHead ?? confirmed;
  requireFact(headNumber <= confirmed, "unconfirmed_capture_head");
  const head = rawBlock(await client.getBlock({ blockNumber: headNumber }));
  const snapshot: ReferenceSnapshot = {
    schema: "pirate.reference-public-evidence/1",
    profile,
    head,
    checkedHeadHash: head.hash,
    evaluationTimestamp: evaluationTimestamp ?? integer(head.timestamp),
    codes: {},
    logs: [],
    blocks: {},
    receipts: {},
    documents: {},
    unavailable: [],
    directoryState: {},
    contractStates: [],
  };
  requireFact(
    snapshot.evaluationTimestamp >= integer(head.timestamp),
    "evaluation_before_head",
  );
  snapshot.blocks[head.number] = head;
  const contracts = [profile.directory, profile.posts, ...profile.results];
  await groups(contracts, async (c) => {
    const code = await client.getCode({
      address: c.address,
      blockNumber: headNumber,
    });
    requireFact(
      code &&
        keccak256(code) === c.codeHash &&
        BigInt(c.fromBlock) <= headNumber,
      "capture_code_changed",
    );
    snapshot.codes[lower(c.address)] = code;
    for (
      let fromBlock = BigInt(c.fromBlock);
      fromBlock <= headNumber;
      fromBlock += 10000n
    ) {
      const toBlock =
        fromBlock + 9999n < headNumber ? fromBlock + 9999n : headNumber;
      const logs =
        lower(c.address) === lower(profile.directory.address)
          ? await client.getLogs({
              address: c.address,
              event: directoryAbi[1],
              args: { communityId: profile.communityId },
              fromBlock,
              toBlock,
              strict: true,
            })
          : lower(c.address) === lower(profile.posts.address)
            ? await client.getLogs({
                address: c.address,
                event: postsAbi[3],
                args: { communityId: profile.communityId },
                fromBlock,
                toBlock,
                strict: true,
              })
            : await client.getLogs({ address: c.address, fromBlock, toBlock });
      snapshot.logs.push(...logs.map(rawLog));
      requireFact(snapshot.logs.length <= 50000, "reference_capture_too_large");
    }
  });
  await Promise.all([
    groups(
      [...new Set(snapshot.logs.map((l) => l.blockNumber))],
      async (number) => {
        snapshot.blocks[number] = rawBlock(
          await client.getBlock({ blockNumber: BigInt(number) }),
        );
      },
    ),
    groups(
      [...new Set(snapshot.logs.map((l) => l.transactionHash))],
      async (hash) => {
        const r = await client.getTransactionReceipt({ hash });
        snapshot.receipts[hash] = {
          hash: r.transactionHash,
          blockNumber: String(r.blockNumber),
          blockHash: r.blockHash,
          status: r.status,
          logs: r.logs.map(rawLog),
        };
      },
    ),
  ]);
  const requests = new Map<string, { hash: Hex; maximum: number }>();
  const queue = (uri: string, hash: Hex, maximum: number) => {
    if (
      typeof uri === "string" &&
      uri.startsWith("ipfs://") &&
      /^0x[0-9a-f]{64}$/.test(hash)
    )
      requests.set(uri, { hash, maximum });
  };
  const sessions = new Map<string, Set<Hex>>();
  const periods = new Map<string, Set<number>>();
  for (const log of snapshot.logs) {
    if (lower(log.address) === lower(profile.directory.address)) {
      const e = decodeEventLog({
        abi: directoryAbi,
        eventName: "ConfigurationPublished",
        data: log.data,
        topics: log.topics,
        strict: true,
      }).args;
      queue(e.uri, e.sha256Digest, 65536);
    } else if (lower(log.address) === lower(profile.posts.address)) {
      const e = decodeEventLog({
        abi: postsAbi,
        eventName: "PostRevisionPublished",
        data: log.data,
        topics: log.topics,
        strict: true,
      }).args;
      if (e.kind === 0) queue(e.manifestURI, e.manifestSha256, 1024 * 1024);
    } else {
      const e = decodeEventLog({
        abi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (e.eventName === "PolicyActivated")
        queue(e.args.policyURI, e.args.policyHash, 65536);
      if (e.eventName === "ResultPublished") {
        const r = e.args.result;
        queue(resultManifestUri(r.contentRevision), r.contentRevision, 262144);
        const key = lower(log.address);
        if (!sessions.has(key)) sessions.set(key, new Set());
        if (!periods.has(key)) periods.set(key, new Set());
        sessions.get(key)!.add(r.sessionId);
        periods.get(key)!.add(learningDay(r.completedAt));
      }
    }
  }
  const retrieve = async ([uri, { hash, maximum }]: [
    string,
    { hash: Hex; maximum: number },
  ]) => {
    try {
      const content = await fetchPublicIpfs(uri, hash, maximum);
      snapshot.documents[uri] = toHex(content.bytes);
    } catch {
      snapshot.unavailable.push(uri);
    }
  };
  await groups([...requests], retrieve);
  const lyrics = new Map<string, { hash: Hex; maximum: number }>();
  for (const bytes of Object.values(snapshot.documents)) {
    try {
      const doc = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(bytes)),
      );
      if (!Array.isArray(doc.media)) continue;
      for (const media of doc.media)
        if (
          media.role === "lyrics" &&
          typeof media.uri === "string" &&
          /^0x[0-9a-f]{64}$/.test(media.sha256)
        )
          lyrics.set(media.uri, {
            hash: media.sha256,
            maximum: Math.min(1024 * 1024, integer(media.byteLength)),
          });
    } catch {
      /* Raw malformed documents remain available to the independent checks. */
    }
  }
  await groups([...lyrics], retrieve);
  snapshot.directoryState = JSON.parse(
    JSON.stringify(
      await client.readContract({
        address: profile.directory.address,
        abi: directoryAbi,
        functionName: "getCommunity",
        args: [profile.communityId],
        blockNumber: headNumber,
      }),
      (_key, value) => (typeof value === "bigint" ? String(value) : value),
    ),
  );
  snapshot.contractStates = await groups(profile.results, async (c) => {
    const [communityId, publicityPolicy, commitments, policyValues] =
      await Promise.all([
        client.readContract({
          address: c.address,
          abi,
          functionName: "communityId",
          blockNumber: headNumber,
        }),
        client.readContract({
          address: c.address,
          abi,
          functionName: "publicityPolicy",
          blockNumber: headNumber,
        }),
        groups(
          [...(sessions.get(lower(c.address)) ?? [])],
          async (id) =>
            [
              id,
              await client.readContract({
                address: c.address,
                abi,
                functionName: "commitments",
                args: [id],
                blockNumber: headNumber,
              }),
            ] as const,
        ),
        groups(
          [...(periods.get(lower(c.address)) ?? [])],
          async (period) =>
            [
              String(period),
              await client.readContract({
                address: c.address,
                abi,
                functionName: "policyFor",
                args: [BigInt(period)],
                blockNumber: headNumber,
              }),
            ] as const,
        ),
      ]);
    return {
      address: c.address,
      communityId,
      publicityPolicy,
      commitments: Object.fromEntries(commitments),
      policies: Object.fromEntries(policyValues),
    };
  });
  snapshot.checkedHeadHash = rawBlock(
    await client.getBlock({ blockNumber: headNumber }),
  ).hash;
  requireFact(
    snapshot.head.hash === snapshot.checkedHeadHash,
    "capture_reorganized",
  );
  return snapshot;
}
