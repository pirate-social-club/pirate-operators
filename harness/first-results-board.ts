// The original JS reader/reducer, with its own public policy/history assembly.
// The reference SQL reader is never called and supplies no derived rows here.
import { createHash } from "node:crypto";
import {
  decodeEventLog,
  keccak256,
  hexToBytes,
  zeroHash,
  type Hex,
} from "viem";
import { readConfigurationHistory } from "../packages/community/directory-reader.ts";
import { canonical } from "../packages/community/common.ts";
import { sourceAuthenticator } from "../packages/records/source-authentication.ts";
import { reducePublicResults } from "../packages/records/results-v2.ts";
import {
  learningBoard,
  type LearningPolicy,
} from "../packages/records/learning-board.ts";
import { resultsAbi } from "../packages/protocol/learning-results.ts";
import { songKeyOf } from "../packages/protocol/records.ts";
import type { KaraokeManifest } from "../packages/protocol/payments.ts";
import { evidenceClient } from "./public-evidence-client.ts";
import {
  resultManifestUri,
  type ReferenceSnapshot,
} from "./reference-results/facts.ts";

function policy(
  snapshot: ReferenceSnapshot,
  uri: string,
  hash: Hex,
): LearningPolicy | undefined {
  try {
    const wire = snapshot.documents[uri];
    const bytes = hexToBytes(wire),
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (`0x${createHash("sha256").update(bytes).digest("hex")}` !== hash)
      return;
    const p = JSON.parse(text);
    if (
      canonical(p) !== text ||
      p.schema !== "pirate.learning-policy/2" ||
      p.clockVersion !== 1 ||
      p.activity !== 1 ||
      typeof p.version !== "string" ||
      typeof p.rewards !== "boolean" ||
      Object.keys(p).length !== 10
    )
      return;
    if (
      !Array.isArray(p.graders) ||
      !p.graders.length ||
      !p.graders.every((x: any) => /^0x[0-9a-f]{40}$/.test(x)) ||
      !Array.isArray(p.scoringPolicies) ||
      !p.scoringPolicies.length ||
      !p.scoringPolicies.every((x: any) => /^0x[0-9a-f]{64}$/.test(x)) ||
      !Array.isArray(p.terminalStatuses) ||
      !p.terminalStatuses.every((x: any) => [1, 2, 3, 4].includes(x)) ||
      !Number.isInteger(p.minScoreBps) ||
      p.minScoreBps < 0 ||
      p.minScoreBps > 10000 ||
      !Number.isInteger(p.maxUnmeasuredBps) ||
      p.maxUnmeasuredBps < 0 ||
      p.maxUnmeasuredBps > 10000
    )
      return;
    return p;
  } catch {
    return;
  }
}
export async function firstResultsBoard(snapshot: ReferenceSnapshot) {
  if (
    snapshot.head.hash !== snapshot.checkedHeadHash ||
    snapshot.evaluationTimestamp < Number(snapshot.head.timestamp)
  )
    throw Error("first_snapshot_changed");
  const p = snapshot.profile,
    { client, transport } = evidenceClient(snapshot);
  for (const c of [p.directory, p.posts, ...p.results])
    if (
      !snapshot.codes[c.address.toLowerCase()] ||
      keccak256(snapshot.codes[c.address.toLowerCase()]) !== c.codeHash
    )
      throw Error("first_contract_changed");
  for (const l of snapshot.logs) {
    const r = snapshot.receipts[l.transactionHash],
      b = snapshot.blocks[l.blockNumber];
    if (
      l.removed ||
      BigInt(l.blockNumber) > BigInt(snapshot.head.number) ||
      r?.status !== "success" ||
      r.blockHash !== l.blockHash ||
      b?.hash !== l.blockHash ||
      !r.logs.some(
        (x) =>
          x.address.toLowerCase() === l.address.toLowerCase() &&
          x.logIndex === l.logIndex &&
          x.data === l.data &&
          JSON.stringify(x.topics) === JSON.stringify(l.topics),
      )
    )
      throw Error("first_noncanonical_event");
  }
  const history = await readConfigurationHistory(
    client,
    {
      chainId: p.chainId,
      directory: p.directory.address,
      registry: p.registry,
      communityId: p.communityId,
      deploymentBlock: BigInt(p.directory.fromBlock),
      directoryCodeHash: p.directory.codeHash,
    },
    transport,
  );
  const authenticateSource = sourceAuthenticator({
    client,
    head: BigInt(snapshot.head.number),
    history,
    posts: {
      address: p.posts.address,
      deploymentBlock: BigInt(p.posts.fromBlock),
      runtimeCodeHash: p.posts.codeHash,
    },
    transport,
  });
  const evaluationPeriod = BigInt(
    Math.floor((snapshot.evaluationTimestamp - 1793552400) / 86400),
  );
  const all: {
    contract: string;
    result: Awaited<ReturnType<typeof reducePublicResults>>[number];
    qualifiable: boolean;
  }[] = [];
  const policyMap = new Map<Hex, LearningPolicy>();
  const eligibility: {
    who: string;
    allowed: boolean;
    at: bigint;
    block: bigint;
    tx: number;
    log: number;
  }[] = [];
  for (const c of p.results) {
    const contract = `${p.chainId}:${c.address.toLowerCase()}`;
    const logs = snapshot.logs
      .filter((l) => l.address.toLowerCase() === c.address.toLowerCase())
      .sort(
        (a, b) =>
          Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) ||
          a.transactionIndex - b.transactionIndex ||
          a.logIndex - b.logIndex,
      );
    const events = logs
      .flatMap((l) => {
        try {
          return [
            {
              log: l,
              decoded: decodeEventLog({
                abi: resultsAbi,
                data: l.data,
                topics: l.topics,
                strict: true,
              }),
            },
          ];
        } catch {
          return [];
        }
      })
      .filter((x) => x.decoded.eventName);
    const activations: { period: bigint; hash: Hex; known: boolean }[] = [];
    for (const { log, decoded } of events) {
      if (decoded.eventName === "PolicyActivated") {
        const a = decoded.args;
        const timestamp = BigInt(snapshot.blocks[log.blockNumber]!.timestamp);
        const now =
          timestamp < 1793552400n ? 0n : (timestamp - 1793552400n) / 86400n;
        if (
          a.clockVersion !== 1 ||
          a.effectivePeriod <= now ||
          (activations.length &&
            a.effectivePeriod <= activations.at(-1)!.period)
        )
          throw Error("first_retroactive_policy");
        const document = policy(snapshot, a.policyURI, a.policyHash);
        if (document) policyMap.set(a.policyHash, document);
        activations.push({
          period: a.effectivePeriod,
          hash: a.policyHash,
          known: !!document,
        });
      } else if (decoded.eventName === "EligibilityChanged") {
        const a = decoded.args;
        eligibility.push({
          who: a.learner.toLowerCase(),
          allowed: a.eligible,
          at: a.effectiveAt,
          block: BigInt(log.blockNumber),
          tx: log.transactionIndex,
          log: log.logIndex,
        });
      }
    }
    const publications = events
      .filter((x) => x.decoded.eventName === "ResultPublished")
      .map(({ log, decoded }) => {
        if (decoded.eventName !== "ResultPublished")
          throw Error("unexpected_event");
        return {
          result: decoded.args.result,
          outcomes: decoded.args.outcomes,
          commitment: decoded.args.commitment,
          blockNumber: BigInt(log.blockNumber),
          logIndex: log.logIndex,
        };
      });
    const results = await reducePublicResults(
      publications,
      async (hash) => {
        const wire = snapshot.documents[resultManifestUri(hash)];
        return wire
          ? (JSON.parse(
              new TextDecoder().decode(hexToBytes(wire)),
            ) as KaraokeManifest)
          : undefined;
      },
      authenticateSource,
    );
    for (const r of results) {
      const active = activations.filter((a) => a.period <= r.period).at(-1);
      const state = snapshot.contractStates.find(
        (s) => s.address.toLowerCase() === c.address.toLowerCase(),
      );
      if (
        r.result.qualificationPolicy !== (active?.hash ?? zeroHash) ||
        state?.commitments[r.result.sessionId] !== r.commitment
      )
        r.verified = false;
      all.push({ contract, result: r, qualifiable: !active || active.known });
    }
  }
  const ineligible = new Set<string>();
  eligibility.sort(
    (a, b) =>
      Number(a.at - b.at) ||
      Number(a.block - b.block) ||
      a.tx - b.tx ||
      a.log - b.log,
  );
  for (const e of eligibility)
    if (e.at <= BigInt(snapshot.evaluationTimestamp)) {
      if (e.allowed) ineligible.delete(e.who);
      else ineligible.add(e.who);
    }
  const boards = new Map<string, typeof all>();
  boards.set(`community:${p.chainId}:${p.communityId}`, all);
  for (const entry of all) {
    const r = entry.result.result;
    const id = `song:${songKeyOf({ ...r.song, chainId: Number(r.song.chainId) })}`;
    boards.set(id, [...(boards.get(id) ?? []), entry]);
  }
  const rows: any[] = [];
  const forBoard = (entry: (typeof all)[number]) =>
    entry.qualifiable ? entry.result : { ...entry.result, verified: false };
  const days = new Map<
    string,
    { board: string; learner: string; period: number }
  >();
  for (const [board, entries] of boards) {
    rows.push(
      ...learningBoard(
        entries.map(forBoard),
        evaluationPeriod,
        policyMap,
        ineligible,
      ).map((r) => ({
        board,
        ...r,
        eligible: ineligible.has(r.learner) ? 0 : 1,
      })),
    );
    for (const entry of entries) {
      const r = entry.result;
      if (
        learningBoard([forBoard(entry)], evaluationPeriod, policyMap).length
      ) {
        const learner = r.result.learner.toLowerCase();
        days.set(`${board}:${learner}:${r.period}`, {
          board,
          learner,
          period: Number(r.period),
        });
      }
    }
  }
  const compare = (a: any, b: any) =>
    a.board.localeCompare(b.board) ||
    a.learner.localeCompare(b.learner) ||
    (a.period ?? 0) - (b.period ?? 0);
  return {
    rows: rows.sort(compare),
    days: [...days.values()].sort(compare),
    outcomes: all
      .map(({ contract, result: r }) => ({
        key: `${contract}:${r.result.sessionId}`,
        revision: r.result.revision,
        commitment: r.commitment,
        completedAt: String(r.result.completedAt),
        policy: r.result.qualificationPolicy,
        status: r.result.status,
        verified: r.verified,
        lines: r.lines.map((l) => ({
          ordinal: l.ordinal,
          status: {
            assessed: 1,
            silent: 2,
            unpaid: 3,
            unmeasured: 4,
            unattempted: 5,
          }[l.status],
          grade: l.scoreBps,
        })),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    scores: all
      .map(({ contract, result: r }) => ({
        key: `${contract}:${r.result.sessionId}`,
        lines: r.lines.length,
        unmeasured: r.lines.filter((l) => l.status === "unmeasured").length,
        scoreBps: r.verified ? r.scoreBps : null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}
