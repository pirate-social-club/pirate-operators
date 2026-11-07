import {
  hashJson,
  bytes32,
  exact,
  insist,
  object,
} from "../packages/community/common.ts";
import {
  readPublicResultsV3,
  type PublicResultV3,
} from "../packages/records/results-v3.ts";
import { sourceAuthenticator } from "../packages/records/source-authentication.ts";
import {
  studySourceReader,
  studySourceAuthenticator,
} from "../packages/records/study-source-authentication.ts";
import { studyFirstPassScore } from "../packages/protocol/learning-results-v3.ts";
import { rewardScore } from "../packages/protocol/payments.ts";
import { songKeyOf, textKey } from "../packages/protocol/records.ts";
import { STUDY_SCORING_POLICY_HASH } from "../packages/protocol/learning-results-v3.ts";
import { rewardAddress, rewardAmount } from "../packages/rewards/validation.ts";
import {
  megapotPurchase,
  megapotWinnings,
} from "../packages/rewards/megapot.ts";
import type {
  QualificationEntry,
  RewardOfferInput,
  RewardSources,
  RewardsProfile,
} from "../packages/rewards/contracts.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { PublicReadPorts } from "./community-public.ts";
import type { Hex } from "viem";

export interface RewardResultSource {
  schema: "pirate.reward-result-source/1";
  contract: string;
  codeHash: string;
  fromBlock: string;
  grader: string;
  karaokePolicy: string;
  studyPolicy: string;
}
/** Greatest canonical block strictly before the offer cutoff, bounded by a confirmed head. */
export async function rewardCutoffBlock(
  from: bigint,
  head: { number: bigint; timestamp: bigint },
  cutoffAt: number,
  read: (
    number: bigint,
  ) => Promise<{ number: bigint; timestamp: bigint; hash: Hex }>,
) {
  insist(
    head.timestamp * 1000n >= BigInt(cutoffAt),
    "reward_cutoff_not_confirmed",
    409,
  );
  let low = from,
    high = head.number,
    found: Awaited<ReturnType<typeof read>> | undefined;
  for (let step = 0; low <= high && step < 64; step++) {
    const mid = (low + high) / 2n,
      block = await read(mid);
    insist(block.number === mid, "reward_cutoff_block_mismatch", 503);
    if (block.timestamp * 1000n < BigInt(cutoffAt)) {
      found = block;
      low = mid + 1n;
    } else high = mid - 1n;
  }
  insist(found && low > high, "reward_cutoff_not_indexable", 503);
  return found;
}
/** Include publication blocks in the advertised window, independent of program age. */
export async function rewardOfferBlocks(
  from: bigint,
  confirmed: { number: bigint; timestamp: bigint },
  offer: Pick<RewardOfferInput, "opensAt" | "cutoffAt">,
  read: (
    number: bigint,
  ) => Promise<{ number: bigint; timestamp: bigint; hash: Hex }>,
) {
  const first = await read(from);
  insist(
    first.number === from && first.timestamp * 1000n <= BigInt(offer.opensAt),
    "reward_history_starts_after_offer",
    409,
  );
  const head = await rewardCutoffBlock(from, confirmed, offer.cutoffAt, read);
  const before =
    first.timestamp * 1000n < BigInt(offer.opensAt)
      ? await rewardCutoffBlock(from, confirmed, offer.opensAt, read)
      : null;
  const start = before ? before.number + 1n : from;
  insist(start <= head.number, "reward_window_has_no_confirmed_blocks", 409);
  insist(head.number - start <= 5000000n, "reward_results_scan_limit", 503);
  return { fromBlock: start, head };
}
export function resultSource(
  raw: string,
  profile: RewardsProfile,
): RewardResultSource {
  const p = object(JSON.parse(raw));
  exact(p, [
    "schema",
    "contract",
    "codeHash",
    "fromBlock",
    "grader",
    "karaokePolicy",
    "studyPolicy",
  ]);
  insist(
    hashJson(p) === profile.resultSourceHash &&
      p.schema === "pirate.reward-result-source/1",
    "reward_result_profile_changed",
    503,
  );
  const fromBlock = rewardAmount(p.fromBlock).toString();
  return {
    schema: "pirate.reward-result-source/1",
    contract: rewardAddress(p.contract),
    codeHash: bytes32(p.codeHash),
    fromBlock,
    grader: rewardAddress(p.grader),
    karaokePolicy: bytes32(p.karaokePolicy),
    studyPolicy: bytes32(p.studyPolicy),
  };
}
/** Uses the latest reconstructed revision; an earlier favorable result cannot be revived. */
export function qualifiesRewardResult(
  e: PublicResultV3,
  offer: RewardOfferInput,
  source: RewardResultSource,
): boolean {
  const r = e.result,
    completed = Number(r.completedAt) * 1000;
  if (
    !e.verified ||
    !e.assessment ||
    r.grader.toLowerCase() !== source.grader ||
    completed < offer.opensAt ||
    completed >= offer.cutoffAt ||
    songKeyOf({ ...r.song, chainId: Number(r.song.chainId) }) !== offer.songKey
  )
    return false;
  if (e.assessment.activity === 2)
    return (
      r.activity === 2 &&
      r.status === 1 &&
      r.qualificationPolicy === source.studyPolicy &&
      r.scoringPolicy === STUDY_SCORING_POLICY_HASH &&
      studyFirstPassScore(e.assessment.outcomes).qualifies
    );
  if (
    r.activity !== 1 ||
    ![1, 2, 3, 4].includes(r.status) ||
    r.qualificationPolicy !== source.karaokePolicy ||
    r.scoringPolicy !== textKey("karaoke-scoring/5")
  )
    return false;
  const score = rewardScore(e.assessment.lines);
  return (
    score.rewardScoreBps !== null &&
    score.rewardScoreBps >= 7000 &&
    score.linesTotal > 0 &&
    score.unmeasuredCount * 10000 <= 1000 * score.linesTotal
  );
}
export function liveRewardSources(input: {
  db: D1Database;
  profile: RewardsProfile;
  source: RewardResultSource;
  config: CommunityConfig;
  reads: PublicReadPorts;
}): RewardSources {
  const { profile, source, reads, config, db } = input;
  insist(
    profile.mode === "live-testnet" &&
      source.contract === config.learningRecords.toLowerCase(),
    "reward_results_contract_changed",
    503,
  );
  return {
    mode: "live-testnet",
    purchase: megapotPurchase,
    winnings: megapotWinnings,
    async qualifiers(offer) {
      const confirmed = await reads.client.getBlock({ blockTag: "safe" });
      const range = await rewardOfferBlocks(
        BigInt(source.fromBlock),
        confirmed,
        offer,
        async (number) => {
          const b = await reads.client.getBlock({ blockNumber: number });
          return { number: b.number, timestamp: b.timestamp, hash: b.hash };
        },
      );
      const head = range.head;
      const history = await (reads.configurationHistory?.() ??
        Promise.resolve([config]));
      const context = {
        client: reads.client,
        posts: reads.profile,
        head: head.number,
        history,
        transport: reads.transport,
      };
      const evidence = await readPublicResultsV3({
        communityId: config.communityId,
        rpcUrl: profile.rpcUrl,
        chainId: 6343,
        contract: source.contract as Hex,
        runtimeCodeHash: source.codeHash as Hex,
        fromBlock: range.fromBlock,
        toBlock: head.number,
        authenticateKaraoke: sourceAuthenticator(context),
        studyManifest: studySourceReader(context),
        authenticateStudy: studySourceAuthenticator(context),
      });
      const entries: QualificationEntry[] = [];
      for (const result of evidence) {
        if (!qualifiesRewardResult(result, offer, source)) continue;
        const owner = await db
          .prepare(
            "SELECT account_id FROM credential_bindings WHERE namespace='moss' AND network=6343 AND subject=?",
          )
          .bind(result.result.learner.toLowerCase())
          .first<{ account_id: string }>();
        if (owner)
          entries.push({
            accountId: owner.account_id,
            wallet: result.result.learner.toLowerCase(),
            evidenceHash: result.commitment,
            completedAt: Number(result.result.completedAt) * 1000,
          });
      }
      insist(
        (await reads.client.getBlock({ blockNumber: head.number })).hash ===
          head.hash,
        "reward_results_head_changed",
        503,
      );
      return entries;
    },
  };
}
