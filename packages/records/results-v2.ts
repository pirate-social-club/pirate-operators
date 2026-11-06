// Rebuild from canonical logs and public manifests. No operator database dependency.
import {
  createPublicClient,
  http,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { check, digest } from "../protocol/index.ts";
import {
  resultCommitment,
  resultPeriod,
  resultsAbi,
  unpackOutcomes,
  type TerminalResult,
} from "../protocol/learning-results.ts";
import {
  rewardScore,
  type KaraokeManifest,
  type LineStatus,
} from "../protocol/payments.ts";
import { songKeyOf } from "../protocol/records.ts";

export interface ResultEvidence {
  result: TerminalResult;
  outcomes: Hex;
  commitment: Hex;
  blockNumber: bigint;
  logIndex: number;
}
export interface PublicResult {
  result: TerminalResult;
  commitment: Hex;
  verified: boolean;
  problems: string[];
  period: bigint;
  lines: { ordinal: number; status: LineStatus; scoreBps: number | null }[];
  scoreBps: number | null;
}
const context = (r: TerminalResult) =>
  resultCommitment(
    { ...r, revision: 1, supersedes: zeroHash, status: 1 },
    "0x",
  );
export async function reducePublicResults(
  events: readonly ResultEvidence[],
  manifest: (revision: Hex) => Promise<KaraokeManifest | undefined>,
  authenticateSource?: (manifest: KaraokeManifest) => Promise<boolean>,
): Promise<PublicResult[]> {
  const sessions = new Map<Hex, PublicResult>();
  const ordered = [...events].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
  const seen = new Set<string>();
  for (const event of ordered) {
    const { result: r, outcomes, commitment } = event;
    const identity = `${event.blockNumber}:${event.logIndex}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const prior = sessions.get(r.sessionId),
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
    let lines: PublicResult["lines"] = [];
    try {
      lines = unpackOutcomes(outcomes, r.linesTotal) as PublicResult["lines"];
    } catch {
      problems.push("invalid_outcomes");
    }
    const source = await manifest(r.contentRevision);
    if (!source) problems.push("manifest_unavailable");
    else if (
      digest(source) !== r.contentRevision ||
      source.lines.length !== r.linesTotal ||
      !source.song ||
      songKeyOf(source.song) !==
        songKeyOf({ ...r.song, chainId: Number(r.song.chainId) })
    )
      problems.push("manifest_mismatch");
    if (source && (!authenticateSource || !(await authenticateSource(source))))
      problems.push("source_unverified");
    if (r.activity !== 1 || r.status < 1 || r.status > 5)
      problems.push("unsupported_result");
    // Never fall back to an older favorable revision when newer evidence is invalid.
    sessions.set(r.sessionId, {
      result: r,
      commitment,
      verified: problems.length === 0 && r.status !== 5,
      problems,
      period: resultPeriod(r.completedAt),
      lines,
      scoreBps: lines.length ? rewardScore(lines).rewardScoreBps : null,
    });
  }
  return [...sessions.values()].sort((a, b) =>
    a.result.sessionId.localeCompare(b.result.sessionId),
  );
}
export async function readPublicResults(source: {
  rpcUrl: string;
  contract: Address;
  fromBlock: bigint;
  toBlock: bigint;
  manifest: (revision: Hex) => Promise<KaraokeManifest | undefined>;
  authenticateSource?: (manifest: KaraokeManifest) => Promise<boolean>;
}) {
  const client = createPublicClient({ transport: http(source.rpcUrl) });
  const before = await client.getBlock({ blockNumber: source.toBlock });
  const logs = await client.getContractEvents({
    address: source.contract,
    abi: resultsAbi,
    eventName: "ResultPublished",
    fromBlock: source.fromBlock,
    toBlock: source.toBlock,
    strict: true,
  });
  const results = await reducePublicResults(
    logs
      .filter((log) => !log.removed)
      .map((log) => ({
        result: log.args.result,
        outcomes: log.args.outcomes,
        commitment: log.args.commitment,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
      })),
    source.manifest,
    source.authenticateSource,
  );
  const after = await client.getBlock({ blockNumber: source.toBlock });
  check(before.hash === after.hash, "canonical_head_changed_retry");
  return results;
}
