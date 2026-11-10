import type { Address, Hex } from "viem";
import { bytes32, hashJson, insist } from "../packages/community/common.ts";
import {
  fetchPublicIpfs,
  type IpfsTransport,
} from "../packages/community/ipfs.ts";
import {
  postsAbi,
  publicationEvent,
  type PostsProfile,
} from "../packages/community/post-chain.ts";
import { validatePostForEvent } from "../packages/community/post-manifest.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type {
  DanceCapture as StoredDanceCapture,
  DanceConsentReceipt,
} from "../packages/dance/contracts.ts";
import {
  qualifyDanceVerdict,
  type DanceQualificationProofs,
} from "../packages/dance-chain/qualification.ts";
import {
  verifyDanceSourceAt,
  verifyDanceVerdict,
  type DanceCanonicalSource,
} from "../packages/dance-chain/reader.ts";
import { danceReadPort } from "../packages/dance-chain/rpc.ts";
import { rewardAddress, rewardId } from "../packages/rewards/validation.ts";
import type { PublicReadPorts } from "./community-public.ts";
import type { CategoricalRewardReader } from "./reward-sources.ts";

const same = (a: string | null | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase();

/** DanceStore freezes capture and consent before outbox admission. No current
 * credential, current group, queue state, or media row is used here. */
export function retainedDanceAccount(
  db: D1Database,
  source: DanceCanonicalSource,
): DanceQualificationProofs["capturedAccount"] {
  return async (sourceHash, commitment, epoch, captureId, captureHash) => {
    if (!same(sourceHash, source.sourceHash)) return null;
    const row = await db
      .prepare(
        `SELECT c.account_id,c.capture_json,k.consent_json FROM dance_captures c
       JOIN dance_consents k ON k.capture_id=c.capture_id
       JOIN dance_reviews r ON r.review_id=c.capture_id
         AND r.community_id=c.community_id AND r.account_id=c.account_id
       WHERE c.capture_id=? AND c.community_id=?`,
      )
      .bind(bytes32(captureId).slice(2), source.domain.communityId)
      .first<{
        account_id: string;
        capture_json: string;
        consent_json: string;
      }>();
    if (!row) return null;
    const capture: StoredDanceCapture = JSON.parse(row.capture_json);
    const consent: DanceConsentReceipt = JSON.parse(row.consent_json);
    const learner = capture.learner;
    insist(
      capture.communityId === source.domain.communityId &&
        same(capture.source.sourceHash, sourceHash) &&
        capture.captureId === captureId.slice(2) &&
        same(capture.captureHash, captureHash) &&
        learner.accountId === row.account_id &&
        learner.active === true &&
        same(learner.accountCommitment, commitment) &&
        Number.isSafeInteger(learner.identityEpoch) &&
        BigInt(learner.identityEpoch) === epoch &&
        consent.accepted === true &&
        consent.accountId === row.account_id &&
        consent.captureId === capture.captureId &&
        same(consent.captureHash, captureHash) &&
        same(consent.termsHash, source.pin.termsSha256) &&
        same(consent.publicityPolicyHash, source.pin.publicityPolicyHash),
      "dance_historical_account_unverified",
      503,
    );
    return {
      accountId: rewardId(row.account_id),
      wallet: rewardAddress(learner.wallet) as Address,
      accountCommitment: bytes32(learner.accountCommitment),
      identityEpoch: epoch,
    };
  };
}

export function historicalDanceSong(input: {
  client: PublicReadPorts["client"];
  posts: PostsProfile;
  history: () => Promise<readonly CommunityConfig[]>;
  transport?: IpfsTransport;
}): DanceQualificationProofs["authenticateSong"] {
  const { client, posts } = input;
  return async (song, number, blockHash) => {
    if (
      song.chainId !== 6343n ||
      !same(song.posts, posts.address) ||
      number < posts.deploymentBlock ||
      number - posts.deploymentBlock > 5_000_000n
    )
      return false;
    const history = await input.history();
    const media = [];
    for (let to = number; to >= posts.deploymentBlock; ) {
      const from =
        to - posts.deploymentBlock >= 9999n
          ? to - 9999n
          : posts.deploymentBlock;
      const logs = await client.getLogs({
        address: posts.address,
        event: postsAbi[3],
        args: { communityId: song.communityId, postId: song.postId },
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      for (const log of logs) {
        if (
          log.removed !== false ||
          log.blockNumber === null ||
          log.blockNumber < from ||
          log.blockNumber > to ||
          log.blockHash === null ||
          log.transactionHash === null ||
          log.transactionIndex === null ||
          log.logIndex === null ||
          !same(log.address, posts.address) ||
          !same(log.args.communityId, song.communityId) ||
          !same(log.args.postId, song.postId) ||
          log.args.kind !== 0 ||
          log.args.revision !== song.revision ||
          !same(log.args.manifestSha256, song.manifestSha256)
        )
          continue;
        const [published, receipt] = await Promise.all([
          client.getBlock({
            blockNumber: log.blockNumber,
            includeTransactions: false,
          }),
          client.getTransactionReceipt({ hash: log.transactionHash }),
        ]);
        const owned = receipt.logs.filter(
          (item) => item.logIndex === log.logIndex,
        );
        if (
          published.number !== log.blockNumber ||
          !same(published.hash, log.blockHash) ||
          !same(
            published.transactions[log.transactionIndex],
            log.transactionHash,
          ) ||
          receipt.status !== "success" ||
          receipt.blockNumber !== log.blockNumber ||
          !same(receipt.blockHash, log.blockHash) ||
          !same(receipt.transactionHash, log.transactionHash) ||
          receipt.transactionIndex !== log.transactionIndex ||
          owned.length !== 1 ||
          owned[0].removed !== false ||
          !same(owned[0].address, log.address) ||
          owned[0].blockNumber !== log.blockNumber ||
          !same(owned[0].blockHash, log.blockHash) ||
          !same(owned[0].transactionHash, log.transactionHash) ||
          owned[0].transactionIndex !== log.transactionIndex ||
          !same(owned[0].data, log.data) ||
          owned[0].topics.length !== log.topics.length ||
          !log.topics.every((topic, i) => same(owned[0].topics[i], topic))
        )
          return false;
        const event = publicationEvent(log.args, posts);
        const config = history.find(
          (entry) =>
            entry.communityId === event.communityId &&
            entry.configurationRevision === event.configurationRevision,
        );
        if (!config) return false;
        const document = await fetchPublicIpfs(
          event.manifestURI,
          event.manifestSha256,
          1024 * 1024,
          input.transport,
        );
        const manifest = validatePostForEvent(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(document.bytes),
          ),
          event,
          config,
        );
        media.push(
          ...manifest.media.filter(
            (item) =>
              item.role === "audio" && same(item.sha256, song.audioSha256),
          ),
        );
      }
      if (media.length > 0) break;
      to = from - 1n;
    }
    if (media.length !== 1) return false;
    const [audio] = media;
    const verified = await fetchPublicIpfs(
      audio.uri,
      audio.sha256,
      audio.byteLength,
      input.transport,
    );
    const head = await client.getBlock({ blockNumber: number });
    return (
      verified.bytes.length === audio.byteLength &&
      head.number === number &&
      same(head.hash, blockHash)
    );
  };
}

export function canonicalDanceRewardSource(input: {
  db: D1Database;
  source: DanceCanonicalSource;
  reads: PublicReadPorts;
  configuration: CommunityConfig;
}): CategoricalRewardReader {
  const { db, source, reads, configuration } = input;
  insist(
    source.domain.chainId === 6343n &&
      source.domain.communityId === configuration.communityId &&
      same(source.pin.directory, configuration.directory) &&
      same(source.pin.posts, reads.profile.address) &&
      same(source.pin.postsRuntimeHash, reads.profile.runtimeCodeHash),
    "dance_reward_source_unavailable",
    503,
  );
  const rpc = danceReadPort(reads.client);
  const proofs = {
    capturedAccount: retainedDanceAccount(db, source),
    authenticateSong: historicalDanceSong({
      client: reads.client,
      posts: reads.profile,
      transport: reads.transport,
      history: reads.configurationHistory ?? (async () => [configuration]),
    }),
  };
  return {
    fromBlock: source.pin.deploymentBlock,
    async verifyAt(cutoff) {
      await verifyDanceSourceAt(rpc, source, cutoff.number);
      return hashJson({
        schema: "pirate.dance-reward-policy-evidence/1",
        sourceHash: source.sourceHash,
        capturePolicy: source.capturePolicy,
        capturePolicyRuntimeHash: source.capturePolicyRuntimeHash,
      });
    },
    async read(offer, inputHash, fromBlock, cutoff) {
      const anchor = await rpc.block(cutoff.number);
      insist(
        anchor.number === cutoff.number &&
          same(anchor.hash, cutoff.hash) &&
          anchor.timestamp === cutoff.timestamp,
        "reward_results_head_changed",
        503,
      );
      const positions = new Set<string>();
      const entries = [];
      let count = 0;
      for (let from = fromBlock; from <= cutoff.number; from += 10000n) {
        const to = from + 9999n < cutoff.number ? from + 9999n : cutoff.number;
        for (const log of await rpc.verdictLogs(
          source.domain.verifier,
          from,
          to,
        )) {
          insist(++count <= 20000, "reward_entry_limit", 409);
          insist(
            log.blockNumber !== null &&
              log.blockNumber >= from &&
              log.blockNumber <= to,
            "dance_log_position_invalid",
            503,
          );
          const event = await verifyDanceVerdict(rpc, source, log, anchor);
          const key = event.evidenceHash;
          insist(!positions.has(key), "dance_duplicate_verdict_log", 503);
          positions.add(key);
          const candidate = await qualifyDanceVerdict(
            source,
            event,
            offer,
            inputHash,
            proofs,
          );
          if (candidate) entries.push(candidate);
        }
      }
      return entries;
    },
  };
}
