// An independent reader of a learner's published grades
// (docs/learning-records-contract.md section 8). Its only inputs are the
// LearningRecords event logs, read over JSON-RPC, and public manifests
// resolved by content revision. It never calls a community or operator API,
// and it recomputes every completion summary instead of trusting the claim.
import { decodeEventLog, encodeEventTopics, pad, zeroHash, type Address, type Hex } from "viem";
import { digest } from "../protocol/index.ts";
import { rewardScore, type KaraokeManifest, type LineStatus } from "../protocol/payments.ts";
import {
  COMPLETION_STATUSES,
  LINE_STATUSES,
  lineKeyOf,
  linesRootOf,
  periodOf,
  recordHashOf,
  recordsAbi,
  recordsHashOf,
  songKeyOf,
  type CompletionStatus,
  type SongKey,
} from "../protocol/records.ts";

export interface ReaderSource {
  rpcUrl: string;
  records: Address;
  fromBlock?: bigint;
  /** Resolves a public manifest, for example from IPFS, by its content revision. */
  manifest: (contentRevision: Hex) => Promise<KaraokeManifest | undefined>;
}
export interface ReadLine {
  ordinal: number;
  lineId: string;
  lineVersion: number;
  status: LineStatus;
  scoreBps: number | null;
  final: boolean;
  revision: number;
  recordHash: Hex;
}
export interface ReadCompletion {
  revision: number;
  completedAt: number;
  periodId: number;
  qualificationPolicy: Hex;
  status: CompletionStatus;
  recordsHash: Hex;
  /** Recomputed from `lines`, the exact records this completion covers. */
  linesTotal: number;
  unmeasuredCount: number;
  rewardScoreBps: number | null;
  claim: { unmeasuredCount: number; rewardScoreBps: number | null };
  claimMatches: boolean;
  lines: ReadLine[];
}
export interface ReadAttempt {
  attemptId: Hex;
  learner: Address;
  grader: Address;
  activity: Hex;
  scoringPolicy: Hex;
  songKey: Hex;
  song: SongKey;
  contentRevision: Hex;
  linesTotal: number;
  /** False when the manifest or any record failed a check; such an attempt is no grade. */
  verified: boolean;
  problems: string[];
  /** The latest record of each line, including corrections not yet completed. */
  lines: ReadLine[];
  completions: ReadCompletion[];
  /** The latest completion, the attempt's grade; null until one exists. */
  grade: ReadCompletion | null;
  /** Line records no completion covers yet: written after the latest one, or before any. */
  uncoveredRecords: number;
}

interface RawLog {
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
  address: Address;
}
async function rpc<T>(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const value = (await response.json()) as { result?: T; error?: { message?: string } };
  if (value.error) throw new Error(value.error.message ?? "rpc_error");
  return value.result as T;
}

const eventTopic = (eventName: "AttemptOpened" | "LineAssessed" | "AttemptCompleted") =>
  encodeEventTopics({ abi: recordsAbi, eventName })[0];

/** Every record for one learner, in chain order: block number, then log index. */
async function learnerLogs(source: ReaderSource, learner: Address) {
  const logs = await rpc<RawLog[]>(source.rpcUrl, "eth_getLogs", [
    {
      address: source.records,
      fromBlock: `0x${(source.fromBlock ?? 0n).toString(16)}`,
      toBlock: "latest",
      // The learner is the second indexed topic of all three events.
      topics: [
        [eventTopic("AttemptOpened"), eventTopic("LineAssessed"), eventTopic("AttemptCompleted")],
        null,
        pad(learner),
      ],
    },
  ]);
  return logs
    .filter((log) => log.address.toLowerCase() === source.records.toLowerCase())
    .sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? Number(BigInt(a.logIndex) - BigInt(b.logIndex))
        : Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)),
    )
    .map((log) => decodeEventLog({ abi: recordsAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }));
}

export async function readLearner(source: ReaderSource, learner: Address): Promise<ReadAttempt[]> {
  const attempts = new Map<Hex, ReadAttempt & { manifest?: KaraokeManifest; state: Map<number, ReadLine> }>();
  for (const event of await learnerLogs(source, learner)) {
    if (event.eventName === "AttemptOpened") {
      const a = event.args;
      const song = { ...a.song, chainId: Number(a.song.chainId) };
      const attempt = {
        attemptId: a.attemptId,
        learner: a.learner,
        grader: a.grader,
        activity: a.activity,
        scoringPolicy: a.scoringPolicy,
        songKey: a.songKey,
        song,
        contentRevision: a.contentRevision,
        linesTotal: a.linesTotal,
        verified: true,
        problems: [] as string[],
        lines: [],
        completions: [],
        grade: null,
        uncoveredRecords: 0,
        manifest: await source.manifest(a.contentRevision).catch(() => undefined),
        state: new Map<number, ReadLine>(),
      };
      const problem = (code: string) => {
        attempt.problems.push(code);
        attempt.verified = false;
      };
      if (songKeyOf(song) !== a.songKey) problem("song_key_mismatch");
      if (!attempt.manifest) problem("manifest_unavailable");
      else if (digest(attempt.manifest) !== a.contentRevision) problem("manifest_digest_mismatch");
      else if (
        attempt.manifest.lines.length !== a.linesTotal ||
        linesRootOf(attempt.manifest) !== a.linesRoot
      )
        problem("lines_root_mismatch");
      attempts.set(a.attemptId, attempt);
      continue;
    }
    const attempt = attempts.get(event.args.attemptId);
    if (!attempt) continue; // The contract never emits records before the attempt opens.
    const problem = (code: string) => {
      attempt.problems.push(code);
      attempt.verified = false;
    };
    if (event.eventName === "LineAssessed") {
      const l = event.args;
      const line = attempt.verified ? attempt.manifest!.lines[l.ordinal - 1] : undefined;
      const previous = attempt.state.get(l.ordinal);
      const status = LINE_STATUSES[l.status];
      const recordHash = recordHashOf({
        attemptId: l.attemptId,
        ordinal: l.ordinal,
        lineKey: l.lineKey,
        lineVersion: l.lineVersion,
        status: l.status,
        scoreBps: l.scoreBps,
        final: l.final_,
        revision: l.revision,
      });
      if (attempt.verified && (!line || lineKeyOf(line.lineId) !== l.lineKey || line.lineVersion !== l.lineVersion))
        problem(`line_not_in_manifest:${l.ordinal}`);
      if (recordHash !== l.recordHash) problem(`record_hash_mismatch:${l.ordinal}:${l.revision}`);
      if (l.supersedes !== (previous?.recordHash ?? zeroHash) || l.revision !== (previous?.revision ?? 0) + 1)
        problem(`revision_chain_broken:${l.ordinal}:${l.revision}`);
      attempt.state.set(l.ordinal, {
        ordinal: l.ordinal,
        lineId: line?.lineId ?? "",
        lineVersion: l.lineVersion,
        status,
        scoreBps: status === "assessed" ? l.scoreBps : null,
        final: l.final_,
        revision: l.revision,
        recordHash,
      });
      attempt.uncoveredRecords += 1;
      continue;
    }
    // AttemptCompleted: verify against the line records as of this position.
    const c = event.args;
    const covered = Array.from({ length: attempt.linesTotal }, (_, i) => attempt.state.get(i + 1));
    if (covered.some((l) => !l?.final)) {
      problem(`completion_without_final_lines:${c.revision}`);
      continue;
    }
    const lines = covered as ReadLine[];
    if (recordsHashOf(lines.map((l) => l.recordHash)) !== c.recordsHash)
      problem(`records_hash_mismatch:${c.revision}`);
    const completedAt = Number(c.completedAt);
    if (periodOf(completedAt) !== Number(c.periodId)) problem(`period_mismatch:${c.revision}`);
    const reward = rewardScore(lines);
    const claim = {
      unmeasuredCount: c.unmeasuredCount,
      rewardScoreBps: c.hasRewardScore ? c.rewardScoreBps : null,
    };
    const claimMatches =
      claim.unmeasuredCount === reward.unmeasuredCount && claim.rewardScoreBps === reward.rewardScoreBps;
    if (!claimMatches) attempt.problems.push(`claim_mismatch:${c.revision}`);
    attempt.completions.push({
      revision: c.revision,
      completedAt,
      periodId: Number(c.periodId),
      qualificationPolicy: c.qualificationPolicy,
      status: COMPLETION_STATUSES[c.status],
      recordsHash: c.recordsHash,
      ...reward,
      claim,
      claimMatches,
      lines: lines.map((l) => ({ ...l })),
    });
    attempt.uncoveredRecords = 0;
  }
  return [...attempts.values()].map(({ manifest: _manifest, state, ...attempt }) => ({
    ...attempt,
    lines: [...state.values()].sort((a, b) => a.ordinal - b.ordinal),
    grade: attempt.verified ? (attempt.completions.at(-1) ?? null) : null,
  }));
}
