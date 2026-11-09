import {
  createPublicClient,
  http,
  keccak256,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { check, digest } from "../protocol/index.ts";
import {
  orderedExercisesHash,
  unpackOutcomes,
} from "../protocol/learning-results.ts";
import {
  resultsV3Abi,
  resultCommitment,
  resultPeriod,
  studyExercisesHash,
  unpackStudyOutcomes,
  type StudyOutcome,
  type TerminalResult,
} from "../protocol/learning-results-v3.ts";
import { songKeyOf } from "../protocol/records.ts";
import type { KaraokeManifest } from "../protocol/payments.ts";
import type { LyricManifest } from "../community/lyric-manifest.ts";
import { studySourceSelection } from "../study/public-source.ts";
import { publicResultManifest } from "./result-manifest.ts";
import type { PublicResult, ResultEvidence } from "./results-v2.ts";

export type ResultAssessment =
  | { activity: 1; lines: PublicResult["lines"] }
  | { activity: 2; outcomes: StudyOutcome[] };
export interface PublicResultV3 {
  result: TerminalResult;
  commitment: Hex;
  period: bigint;
  verified: boolean;
  problems: string[];
  assessment: ResultAssessment | null;
}
export interface V3SourcePorts {
  communityId: Hex;
  karaokeManifest?(hash: Hex): Promise<KaraokeManifest | undefined>;
  studyManifest?(
    hash: Hex,
    song: TerminalResult["song"],
  ): Promise<LyricManifest | undefined>;
  authenticateKaraoke?(manifest: KaraokeManifest): Promise<boolean>;
  authenticateStudy?(manifest: LyricManifest): Promise<boolean>;
}
const context = (r: TerminalResult) =>
  resultCommitment(
    { ...r, revision: 1, supersedes: zeroHash, status: 1 },
    "0x",
  );

/** Events must come from one authenticated V3 contract at one canonical head. */
export async function reducePublicResultsV3(
  events: readonly ResultEvidence[],
  ports: V3SourcePorts,
) {
  const sessions = new Map<Hex, PublicResultV3>(),
    seen = new Set<string>();
  const ordered = [...events].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
  for (const event of ordered) {
    const identity = `${event.blockNumber}:${event.logIndex}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const { result: r, commitment, outcomes } = event,
      prior = sessions.get(r.sessionId),
      problems: string[] = [];
    if (resultCommitment(r, outcomes) !== commitment)
      problems.push("commitment_mismatch");
    if (
      r.revision === 1
        ? !!prior || r.supersedes !== zeroHash
        : !prior ||
          r.revision !== prior.result.revision + 1 ||
          r.supersedes !== prior.commitment ||
          context(r) !== context(prior.result)
    )
      problems.push("revision_mismatch");
    // Once a revision chain cannot be reconstructed, later self-consistent
    // metadata cannot silently repair the gap or regain a favorable old result.
    if (
      prior?.problems.some(
        (x) =>
          x === "revision_mismatch" ||
          x === "commitment_mismatch" ||
          x === "revision_chain_unverified",
      )
    )
      problems.push("revision_chain_unverified");
    if (
      r.song.communityId !== ports.communityId ||
      r.status < 1 ||
      r.status > 5 ||
      r.startedAt > r.completedAt
    )
      problems.push("invalid_result_context");
    let period = -1n,
      assessment: ResultAssessment | null = null;
    try {
      period = resultPeriod(r.completedAt);
    } catch {
      problems.push("invalid_result_time");
    }
    try {
      if (r.activity === 1) {
        const lines = unpackOutcomes(
          outcomes,
          r.linesTotal,
        ) as PublicResult["lines"];
        check(
          orderedExercisesHash(r.linesTotal) === r.exercisesHash,
          "wrong_exercises",
        );
        assessment = { activity: 1, lines };
        const source = await (ports.karaokeManifest ?? publicResultManifest)(
          r.contentRevision,
        );
        if (!source) problems.push("manifest_unavailable");
        else {
          if (
            digest(source) !== r.contentRevision ||
            source.lines.length !== r.linesTotal ||
            !source.song ||
            songKeyOf(source.song) !==
              songKeyOf({ ...r.song, chainId: Number(r.song.chainId) })
          )
            problems.push("manifest_mismatch");
          if (
            !ports.authenticateKaraoke ||
            !(await ports.authenticateKaraoke(source))
          )
            problems.push("source_unverified");
        }
      } else if (r.activity === 2) {
        const decoded = unpackStudyOutcomes(outcomes, r.linesTotal);
        check(
          studyExercisesHash(decoded.map((x) => x.sourceOrdinal)) ===
            r.exercisesHash,
          "wrong_exercises",
        );
        check(
          r.status !== 1 ||
            decoded.every(
              (x) => x.status === "correct" || x.status === "incorrect",
            ),
          "incomplete_study",
        );
        assessment = { activity: 2, outcomes: decoded };
        const source = await ports.studyManifest?.(r.contentRevision, r.song);
        if (!source) problems.push("manifest_unavailable");
        else {
          const selected = studySourceSelection(
            source,
            decoded.map((x) => x.sourceOrdinal),
          );
          if (
            selected.hash !== r.contentRevision ||
            BigInt(source.chainId) !== r.song.chainId ||
            source.postsContract !== r.song.posts.toLowerCase() ||
            source.communityId !== r.song.communityId ||
            source.postId !== r.song.postId
          )
            problems.push("manifest_mismatch");
          if (
            !ports.authenticateStudy ||
            !(await ports.authenticateStudy(selected.source))
          )
            problems.push("source_unverified");
        }
      } else problems.push("unsupported_activity");
    } catch {
      problems.push("invalid_outcomes_or_source");
    }
    sessions.set(r.sessionId, {
      result: r,
      commitment,
      period,
      assessment,
      verified: problems.length === 0 && r.status !== 5,
      problems,
    });
  }
  return [...sessions.values()].sort((a, b) =>
    a.result.sessionId.localeCompare(b.result.sessionId),
  );
}

export async function readPublicResultsV3(
  input: V3SourcePorts & {
    rpcUrl: string;
    chainId: 31337 | 6343;
    contract: Address;
    runtimeCodeHash: Hex;
    fromBlock: bigint;
    toBlock: bigint;
    /** V4 keeps V3's Result struct and ResultPublished event; only its
     * permission model differs, so the same verification applies. */
    version?: 3 | 4;
  },
) {
  const expectedVersion = input.version ?? 3;
  check(expectedVersion === 3 || expectedVersion === 4, "unsupported_results_version");
  check(input.chainId === 31337 || input.chainId === 6343, "unsupported_chain");
  check(
    input.fromBlock >= 0n && input.toBlock >= input.fromBlock,
    "invalid_block_range",
  );
  const client = createPublicClient({ transport: http(input.rpcUrl) });
  check((await client.getChainId()) === input.chainId, "wrong_result_chain");
  const before = await client.getBlock({ blockNumber: input.toBlock });
  const code = await client.getCode({
    address: input.contract,
    blockNumber: input.toBlock,
  });
  check(
    code && keccak256(code) === input.runtimeCodeHash,
    "result_code_changed",
  );
  const [version, communityId] = await Promise.all([
    client.readContract({
      address: input.contract,
      abi: resultsV3Abi,
      functionName: "VERSION",
      blockNumber: input.toBlock,
    }),
    client.readContract({
      address: input.contract,
      abi: resultsV3Abi,
      functionName: "communityId",
      blockNumber: input.toBlock,
    }),
  ]);
  check(
    version === expectedVersion && communityId === input.communityId,
    "wrong_result_contract",
  );
  const events: ResultEvidence[] = [];
  for (let from = input.fromBlock; from <= input.toBlock; from += 10000n) {
    const logs = await client.getContractEvents({
      address: input.contract,
      abi: resultsV3Abi,
      eventName: "ResultPublished",
      fromBlock: from,
      toBlock: from + 9999n < input.toBlock ? from + 9999n : input.toBlock,
      strict: true,
    });
    for (const log of logs)
      if (!log.removed)
        events.push({
          result: log.args.result,
          outcomes: log.args.outcomes,
          commitment: log.args.commitment,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        });
  }
  const results = await reducePublicResultsV3(events, input);
  const after = await client.getBlock({ blockNumber: input.toBlock });
  check(before.hash === after.hash, "canonical_head_changed_retry");
  return results;
}

/** A results contract an offer accepts, pinned at attach time. */
export interface PublicResultSource {
  contract: Address;
  codeHash: Hex;
  version: 3 | 4;
}
/** Version-agnostic entry: the same verified-result output for V3 and V4. */
export const readPublicResults = (
  source: PublicResultSource,
  input: V3SourcePorts & {
    rpcUrl: string;
    chainId: 31337 | 6343;
    fromBlock: bigint;
    toBlock: bigint;
  },
) =>
  readPublicResultsV3({
    ...input,
    contract: source.contract,
    runtimeCodeHash: source.codeHash,
    version: source.version,
  });
