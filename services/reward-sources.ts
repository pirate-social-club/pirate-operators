import {
  hashJson,
  bytes32,
  exact,
  insist,
  object,
} from "../packages/community/common.ts";
import {
  readPublicResults,
  type PublicResultV3,
  type V3SourcePorts,
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
import { keccak256, parseAbi, type Hex } from "viem";
import type { RewardClosureEvidence } from "../packages/rewards/closure.ts";
import { withRewardRehearsal } from "../packages/rewards/rehearsal.ts";

export interface RewardResultSource {
  schema: "pirate.reward-result-source/1";
  contract: string;
  codeHash: string;
  fromBlock: string;
  grader: string;
  karaokePolicy: string;
  studyPolicy: string;
}
/**
 * A source appended after the original. Same reading rules, plus the results
 * contract version; the original keeps its schema and profile-pinned hash.
 */
export interface RewardResultSuccessor {
  schema: "pirate.reward-result-source/2";
  version: 4;
  contract: string;
  codeHash: string;
  fromBlock: string;
  grader: string;
  karaokePolicy: string;
  studyPolicy: string;
}
export type AnyRewardResultSource = RewardResultSource | RewardResultSuccessor;
/** Successors appended so far, in order; each release may append one. */
export const MAX_RESULT_SUCCESSORS = 7;
const sourceVersion = (s: AnyRewardResultSource): 3 | 4 =>
  s.schema === "pirate.reward-result-source/2" ? s.version : 3;
type Cutoff = { number: bigint; timestamp: bigint; hash: Hex };

export interface CategoricalRewardReader {
  fromBlock: bigint;
  /** Returns the exact historical source and policy digest at the cutoff. */
  verifyAt(cutoff: Cutoff): Promise<Hex>;
  /** Entries have authenticated immutable captured bindings. */
  read(
    offer: RewardOfferInput,
    inputHash: string,
    fromBlock: bigint,
    cutoff: Cutoff,
  ): Promise<QualificationEntry[]>;
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
export function resultSuccessor(value: unknown): RewardResultSuccessor {
  const p = object(value);
  exact(p, [
    "schema",
    "version",
    "contract",
    "codeHash",
    "fromBlock",
    "grader",
    "karaokePolicy",
    "studyPolicy",
  ]);
  insist(
    p.schema === "pirate.reward-result-source/2" && p.version === 4,
    "reward_result_successor_invalid",
    503,
  );
  const successor: RewardResultSuccessor = {
    schema: "pirate.reward-result-source/2",
    version: 4,
    contract: rewardAddress(p.contract),
    codeHash: bytes32(p.codeHash),
    fromBlock: rewardAmount(p.fromBlock).toString(),
    grader: rewardAddress(p.grader),
    karaokePolicy: bytes32(p.karaokePolicy),
    studyPolicy: bytes32(p.studyPolicy),
  };
  insist(
    hashJson(p) === hashJson(successor),
    "reward_result_successor_invalid",
    503,
  );
  return successor;
}
/**
 * The original source followed by its successors, keyed by content hash. The
 * original's hash is the profile's; contracts never repeat.
 */
export function rewardResultSources(
  original: RewardResultSource,
  successorsJson: string | undefined,
): Map<string, AnyRewardResultSource> {
  const raw = successorsJson === undefined ? [] : JSON.parse(successorsJson);
  insist(
    Array.isArray(raw) && raw.length <= MAX_RESULT_SUCCESSORS,
    "reward_result_successor_invalid",
    503,
  );
  const all: AnyRewardResultSource[] = [original, ...raw.map(resultSuccessor)];
  insist(
    new Set(all.map((s) => s.contract)).size === all.length,
    "reward_result_successor_invalid",
    503,
  );
  return new Map(all.map((s) => [hashJson(s), s]));
}
/** Uses the latest reconstructed revision; an earlier favorable result cannot be revived. */
export function qualifiesRewardResult(
  e: PublicResultV3,
  offer: RewardOfferInput,
  source: AnyRewardResultSource,
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
/**
 * Each wallet's earliest qualifying result, resolved to accounts in batched
 * reads so repeated results cannot exhaust per-request queries.
 */
export async function resolveRewardQualifiers(
  db: D1Database,
  results: Omit<QualificationEntry, "accountId">[],
): Promise<QualificationEntry[]> {
  const earliest = new Map<string, Omit<QualificationEntry, "accountId">>();
  for (const r of results) {
    const prior = earliest.get(r.wallet);
    if (
      !prior ||
      r.completedAt < prior.completedAt ||
      (r.completedAt === prior.completedAt &&
        r.evidenceHash < prior.evidenceHash)
    )
      earliest.set(r.wallet, r);
  }
  const wallets = [...earliest.keys()];
  const entries: QualificationEntry[] = [];
  for (let i = 0; i < wallets.length; i += 90) {
    const chunk = wallets.slice(i, i + 90);
    const owners = await db
      .prepare(
        `SELECT account_id,subject FROM credential_bindings WHERE namespace='moss' AND network=6343 AND subject IN (${chunk.map(() => "?").join(",")})`,
      )
      .bind(...chunk)
      .all<{ account_id: string; subject: string }>();
    for (const owner of owners.results)
      entries.push({
        ...earliest.get(owner.subject)!,
        accountId: owner.account_id,
      });
  }
  return entries;
}
const policyAbi = parseAbi([
  "function periodOf(uint64 timestamp) pure returns (uint64)",
  "function policyFor(uint8 activity,uint64 period) view returns (bytes32)",
]);
/** Longest window whose daily policies are checked one by one. */
export const MAX_POLICY_PERIODS = 32n;
/**
 * A V4 contract can schedule a new policy for a later period. Results under a
 * policy the source does not pin never qualify, so a rotation inside the
 * window stops the close instead of silently emptying the offer.
 */
async function assertWindowPolicies(
  client: Pick<PublicReadPorts["client"], "readContract">,
  source: AnyRewardResultSource,
  offer: Pick<RewardOfferInput, "opensAt" | "cutoffAt">,
  blockNumber: bigint,
) {
  const address = source.contract as Hex;
  const period = (ms: number) =>
    client.readContract({
      address,
      abi: policyAbi,
      functionName: "periodOf",
      args: [BigInt(Math.floor(ms / 1000))],
      blockNumber,
    });
  const [first, last] = await Promise.all([
    period(offer.opensAt),
    period(offer.cutoffAt - 1),
  ]);
  insist(
    last >= first && last - first < MAX_POLICY_PERIODS,
    "reward_window_policy_span",
    409,
  );
  const schedule: { period: string; activity: number; policy: string }[] = [];
  for (let p = first; p <= last; p++)
    for (const [activity, expected] of [
      [1, source.karaokePolicy],
      [2, source.studyPolicy],
    ] as const) {
      const policy = await client.readContract({
        address,
        abi: policyAbi,
        functionName: "policyFor",
        args: [activity, p],
        blockNumber,
      });
      // Zero is a period before the first activation; no result qualifies
      // under it, and activations never return to zero.
      insist(
        policy.toLowerCase() === expected || BigInt(policy) === 0n,
        "reward_result_policy_rotated",
        503,
      );
      schedule.push({
        period: p.toString(),
        activity,
        policy: policy.toLowerCase(),
      });
    }
  return schedule;
}
export function liveRewardSources(input: {
  db: D1Database;
  profile: RewardsProfile;
  /** The original source first, then successors, from rewardResultSources. */
  sources: Map<string, AnyRewardResultSource>;
  /** Separately admitted categorical sources. Never inserted into old offers. */
  categorical?: ReadonlyMap<string, CategoricalRewardReader>;
  config: CommunityConfig;
  reads: PublicReadPorts;
  /** The verified public results reader; replaced only in tests. */
  readResults?: typeof readPublicResults;
  /**
   * Song and lyric source authentication for the reader. Defaults to the
   * community's posts and IPFS; replaced only where no posts contract exists.
   */
  sourcePorts?: Pick<
    V3SourcePorts,
    | "karaokeManifest"
    | "authenticateKaraoke"
    | "studyManifest"
    | "authenticateStudy"
  >;
}): RewardSources {
  const { profile, sources, reads, config, db } = input;
  const readResults = input.readResults ?? readPublicResults;
  const original = [...sources.keys()][0];
  insist(
    profile.mode === "live-testnet" && original === profile.resultSourceHash,
    "reward_result_profile_changed",
    503,
  );
  // Rewards stay live only while the community publishes to a known source.
  const current = [...sources].find(
    ([, s]) => s.contract === config.learningRecords.toLowerCase(),
  )?.[0];
  insist(current, "reward_results_contract_changed", 503);
  const categorical =
    input.categorical ?? new Map<string, CategoricalRewardReader>();
  for (const hash of categorical.keys())
    insist(!sources.has(bytes32(hash)), "reward_result_source_overlap", 503);
  const pinnedFor = (offer: RewardOfferInput) => {
    const pins = offer.resultSources ?? [profile.resultSourceHash];
    insist(
      pins.length > 0 && new Set(pins).size === pins.length,
      "reward_offer_sources_invalid",
      503,
    );
    return pins;
  };
  const requires = (offer: RewardOfferInput) =>
    pinnedFor(offer).some((hash) => categorical.has(hash));
  const read = async (number: bigint): Promise<Cutoff> => {
    const b = await reads.client.getBlock({ blockNumber: number });
    return { number: b.number, timestamp: b.timestamp, hash: b.hash };
  };
  const snapshot = async (
    offer: RewardOfferInput,
    head: Cutoff,
  ): Promise<RewardClosureEvidence> => {
    const evidence: RewardClosureEvidence["sources"] = [];
    for (const hash of pinnedFor(offer)) {
      const category = categorical.get(hash),
        source = sources.get(hash);
      insist(category || source, "reward_result_source_unavailable", 503);
      let policyEvidenceHash;
      if (category) {
        policyEvidenceHash = await category.verifyAt(head);
      } else {
        const scored = source!;
        const code = await reads.client.getCode({
          address: scored.contract as Hex,
          blockNumber: head.number,
        });
        insist(
          code && code !== "0x" && keccak256(code) === scored.codeHash,
          "reward_result_runtime_changed",
          503,
        );
        const schedule =
          sourceVersion(scored) === 4
            ? await assertWindowPolicies(
                reads.client,
                scored,
                offer,
                head.number,
              )
            : [];
        policyEvidenceHash = hashJson({ source: scored, schedule });
      }
      evidence.push({ sourceHash: hash, policyEvidenceHash });
    }
    const after = await read(head.number);
    insist(
      after.number === head.number &&
        after.hash === head.hash &&
        after.timestamp === head.timestamp,
      "reward_results_head_changed",
      503,
    );
    return {
      chainId: 6343,
      cutoffNumber: head.number.toString(),
      cutoffHash: head.hash,
      cutoffTimestampSeconds: head.timestamp.toString(),
      sources: evidence,
    };
  };
  const collect = async (offer: RewardOfferInput, inputHash?: string) => {
    const confirmed = await reads.client.getBlock({ blockTag: "safe" });
    const history = await (reads.configurationHistory?.() ??
      Promise.resolve([config]));
    const scoredEntries: Omit<QualificationEntry, "accountId">[] = [];
    const capturedEntries: QualificationEntry[] = [];
    let head: Cutoff | null = null;
    for (const hash of pinnedFor(offer)) {
      const source = sources.get(hash),
        category = categorical.get(hash);
      insist(source || category, "reward_result_source_unavailable", 503);
      const range = await rewardOfferBlocks(
        category?.fromBlock ?? BigInt(source!.fromBlock),
        confirmed,
        offer,
        read,
      );
      insist(
        !head ||
          (head.number === range.head.number &&
            head.hash === range.head.hash &&
            head.timestamp === range.head.timestamp),
        "reward_results_head_changed",
        503,
      );
      head = range.head;
      if (category) {
        insist(inputHash, "reward_closure_unavailable", 503);
        const found = await category.read(
          offer,
          inputHash,
          range.fromBlock,
          head,
        );
        insist(
          found.length + capturedEntries.length <= 20000,
          "reward_entry_limit",
          409,
        );
        for (const entry of found) capturedEntries.push(entry);
        continue;
      }
      const scored = source!;
      if (sourceVersion(scored) === 4)
        await assertWindowPolicies(reads.client, scored, offer, head.number);
      const context = {
        client: reads.client,
        posts: reads.profile,
        head: head.number,
        history,
        transport: reads.transport,
      };
      const results = await readResults(
        {
          contract: scored.contract as Hex,
          codeHash: scored.codeHash as Hex,
          version: sourceVersion(scored),
        },
        {
          communityId: config.communityId,
          rpcUrl: profile.rpcUrl,
          chainId: 6343,
          fromBlock: range.fromBlock,
          toBlock: head.number,
          ...(input.sourcePorts ?? {
            authenticateKaraoke: sourceAuthenticator(context),
            studyManifest: studySourceReader(context),
            authenticateStudy: studySourceAuthenticator(context),
          }),
        },
      );
      for (const result of results)
        if (qualifiesRewardResult(result, offer, scored))
          scoredEntries.push({
            wallet: result.result.learner.toLowerCase(),
            evidenceHash: result.commitment,
            completedAt: Number(result.result.completedAt) * 1000,
          });
    }
    const scored = await resolveRewardQualifiers(db, scoredEntries);
    insist(
      head && (await read(head.number)).hash === head.hash,
      "reward_results_head_changed",
      503,
    );
    return {
      head,
      entries: [...scored, ...capturedEntries],
      captured: new Set(capturedEntries.map(hashJson)),
    };
  };
  const defaults = [...sources.keys()];
  return withRewardRehearsal(profile, {
    mode: "live-testnet",
    resultSources: {
      accepted: [...defaults, ...categorical.keys()],
      current,
      ...(categorical.size ? { defaults } : {}),
    },
    purchase: async (...args) => ({
      ...(await megapotPurchase(...args)),
      mode: "live-testnet",
    }),
    winnings: async (...args) => ({
      ...(await megapotWinnings(...args)),
      mode: "live-testnet",
    }),
    async qualifiers(offer) {
      return (await collect(offer)).entries;
    },
    ...(categorical.size
      ? {
          closure: {
            requires,
            async admit(offer: RewardOfferInput) {
              insist(
                requires(offer) && (await reads.client.getChainId()) === 6343,
                "reward_closure_unavailable",
                503,
              );
              const safe = await reads.client.getBlock({ blockTag: "safe" });
              const head = {
                number: safe.number,
                timestamp: safe.timestamp,
                hash: safe.hash,
              };
              for (const hash of pinnedFor(offer)) {
                const category = categorical.get(hash),
                  source = sources.get(hash);
                insist(
                  category || source,
                  "reward_result_source_unavailable",
                  503,
                );
                const start = category?.fromBlock ?? BigInt(source!.fromBlock);
                insist(
                  start <= head.number,
                  "reward_result_source_unavailable",
                  503,
                );
                const first = await read(start);
                insist(
                  first.number === start &&
                    first.timestamp * 1000n <= BigInt(offer.opensAt),
                  "reward_history_starts_after_offer",
                  409,
                );
              }
              await snapshot(offer, head);
            },
            async scan(offer: RewardOfferInput, inputHash: string) {
              insist(
                requires(offer) && (await reads.client.getChainId()) === 6343,
                "reward_closure_unavailable",
                503,
              );
              const { head, ...result } = await collect(offer, inputHash);
              return { ...result, evidence: await snapshot(offer, head) };
            },
            async verify(
              offer: RewardOfferInput,
              expected: RewardClosureEvidence,
            ) {
              insist(
                requires(offer) && (await reads.client.getChainId()) === 6343,
                "reward_closure_unavailable",
                503,
              );
              const n = rewardAmount(expected.cutoffNumber);
              const [head, next, safe] = await Promise.all([
                read(n),
                read(n + 1n),
                reads.client.getBlock({ blockTag: "safe" }),
              ]);
              insist(
                head.number === n &&
                  next.number === n + 1n &&
                  next.number <= safe.number &&
                  head.hash === expected.cutoffHash &&
                  head.timestamp.toString() ===
                    expected.cutoffTimestampSeconds &&
                  head.timestamp * 1000n < BigInt(offer.cutoffAt) &&
                  next.timestamp * 1000n >= BigInt(offer.cutoffAt),
                "reward_results_head_changed",
                503,
              );
              insist(
                hashJson(await snapshot(offer, head)) === hashJson(expected),
                "reward_closure_sources_changed",
                503,
              );
            },
          },
        }
      : {}),
  });
}
