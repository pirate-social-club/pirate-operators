// Read-only, bounded public-history search. No signing, quota or native intent.
import { decodeEventLog, type Address, type Hex } from "viem";
import { check } from "../packages/protocol/index.ts";
import {
  resultsV3Abi,
  resultCommitment,
  type TerminalResult,
} from "../packages/protocol/learning-results-v3.ts";
import type { resultClient } from "./learning-contract.ts";
import {
  projectStudyRevisions,
  restoreStudyResult,
  studyRevisionContext,
  type StudyRevisionEvidence,
} from "./study-revisions.ts";

type Client = Pick<
  ReturnType<typeof resultClient>,
  "getBlock" | "getTransactionReceipt" | "getContractEvents"
>;
interface Head {
  number: bigint;
  hash: Hex;
}
export interface StudyRevisionSearch {
  target: Hex;
  anchor: Hex;
  head: { number: string; hash: Hex };
  nextToBlock: string;
  events: StudyRevisionEvidence[];
}
const MAX_WINDOWS = 8;
const BLOCKS_PER_WINDOW = 10000n;
const MAX_EVENTS = 128;

async function isCanonical(
  client: Client,
  e: { blockNumber: string; blockHash: Hex },
  head: Head,
) {
  return (
    BigInt(e.blockNumber) <= head.number &&
    (await client.getBlock({ blockNumber: BigInt(e.blockNumber) })).hash ===
      e.blockHash
  );
}
async function originalProof(
  client: Client,
  contract: Address,
  hash: Hex,
  result: TerminalResult,
  outcomes: Hex,
  head: Head,
) {
  const receipt = await client.getTransactionReceipt({ hash });
  check(
    receipt.status === "success" &&
      receipt.blockNumber <= head.number &&
      (await client.getBlock({ blockNumber: receipt.blockNumber })).hash ===
        receipt.blockHash,
    "study_revision_origin_not_canonical",
  );
  const found: StudyRevisionEvidence[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    let event;
    try {
      event = decodeEventLog({
        abi: resultsV3Abi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
    } catch {
      continue;
    }
    if (
      event.eventName !== "ResultPublished" ||
      event.args.sessionId !== result.sessionId
    )
      continue;
    found.push({
      result: event.args.result,
      outcomes: event.args.outcomes,
      commitment: event.args.commitment,
      transactionHash: hash,
      blockNumber: String(receipt.blockNumber),
      blockHash: receipt.blockHash,
      logIndex: log.logIndex,
    });
  }
  check(
    found.length === 1 &&
      found[0].result.revision === 1 &&
      found[0].outcomes === outcomes &&
      found[0].commitment ===
        resultCommitment(restoreStudyResult(result), outcomes),
    "study_revision_origin_changed",
  );
  projectStudyRevisions(found[0], [], found[0].commitment);
  return found[0];
}

/** Each invocation searches at most eight indexed 10,000-block windows and
 * retains at most 128 public events. A missing chain stays pending, never graded.
 * The caller atomically saves this returned proof/search with its receipt CAS.
 */
export async function readStudyRevision(input: {
  client: Client;
  contract: Address;
  head: Head;
  currentCommitment: Hex;
  originalHash: Hex;
  originalResult: TerminalResult;
  originalOutcomes: Hex;
  proof?: StudyRevisionEvidence;
  search?: StudyRevisionSearch;
}) {
  const { client, head } = input;
  const base = resultCommitment(
    restoreStudyResult(input.originalResult),
    input.originalOutcomes,
  );
  let anchor = input.proof;
  if (anchor) {
    projectStudyRevisions(anchor, [], anchor.commitment);
    check(
      studyRevisionContext(anchor.result) ===
        studyRevisionContext(input.originalResult),
      "study_revision_context_changed",
    );
    check(
      BigInt(anchor.blockNumber) <= head.number,
      "study_revision_head_behind",
    );
    // Reorgs may legitimately return to an older canonical revision.
    if (!(await isCanonical(client, anchor, head))) anchor = undefined;
  }
  if (!anchor)
    anchor = await originalProof(
      client,
      input.contract,
      input.originalHash,
      input.originalResult,
      input.originalOutcomes,
      head,
    );
  if (input.currentCommitment === base && anchor.result.revision !== 1)
    throw Error("study_revision_head_conflict");
  if (input.currentCommitment === anchor.commitment) {
    check(
      (await client.getBlock({ blockNumber: head.number })).hash === head.hash,
      "study_revision_head_changed",
    );
    return { complete: true as const, latest: anchor, search: undefined };
  }
  let search = input.search;
  if (
    !search ||
    search.target !== input.currentCommitment ||
    search.anchor !== anchor.commitment ||
    BigInt(search.head.number) > head.number ||
    (await client.getBlock({ blockNumber: BigInt(search.head.number) }))
      .hash !== search.head.hash
  )
    search = {
      target: input.currentCommitment,
      anchor: anchor.commitment,
      head: { number: String(head.number), hash: head.hash },
      nextToBlock: String(head.number),
      events: [],
    };
  const events = new Map(
    search.events.map((e) => [e.blockHash + ":" + e.logIndex, e]),
  );
  check(events.size <= MAX_EVENTS, "study_revision_history_limit");
  let to = BigInt(search.nextToBlock);
  check(
    /^\d+$/.test(search.nextToBlock) && to <= BigInt(search.head.number),
    "invalid_study_revision_cursor",
  );
  for (
    let window = 0;
    window < MAX_WINDOWS && to >= BigInt(anchor.blockNumber);
    window++
  ) {
    const from =
      to - BLOCKS_PER_WINDOW + 1n > BigInt(anchor.blockNumber)
        ? to - BLOCKS_PER_WINDOW + 1n
        : BigInt(anchor.blockNumber);
    const logs = await client.getContractEvents({
      address: input.contract,
      abi: resultsV3Abi,
      eventName: "ResultPublished",
      args: { sessionId: input.originalResult.sessionId },
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    check(logs.length <= MAX_EVENTS, "study_revision_history_limit");
    for (const log of logs) {
      check(
        !log.removed &&
          log.address.toLowerCase() === input.contract.toLowerCase() &&
          log.args.sessionId === input.originalResult.sessionId,
        "study_revision_log_changed",
      );
      const evidence: StudyRevisionEvidence = {
        result: log.args.result,
        outcomes: log.args.outcomes,
        commitment: log.args.commitment,
        transactionHash: log.transactionHash,
        blockNumber: String(log.blockNumber),
        blockHash: log.blockHash,
        logIndex: log.logIndex,
      };
      const identity = evidence.blockHash + ":" + evidence.logIndex;
      const previous = events.get(identity);
      if (previous) {
        check(
          previous.commitment === evidence.commitment &&
            previous.transactionHash === evidence.transactionHash &&
            previous.blockNumber === evidence.blockNumber,
          "conflicting_study_revision",
        );
        continue;
      }
      check(events.size < MAX_EVENTS, "study_revision_history_limit");
      check(
        await isCanonical(client, evidence, head),
        "study_revision_log_not_canonical",
      );
      const receipt = await client.getTransactionReceipt({
        hash: log.transactionHash,
      });
      check(
        receipt.status === "success" &&
          receipt.blockHash === log.blockHash &&
          receipt.logs.some(
            (x) =>
              x.address.toLowerCase() === input.contract.toLowerCase() &&
              x.logIndex === log.logIndex &&
              x.data === log.data &&
              x.topics.join() === log.topics.join(),
          ),
        "study_revision_receipt_changed",
      );
      events.set(identity, evidence);
      check(events.size <= MAX_EVENTS, "study_revision_history_limit");
    }
    const projected = projectStudyRevisions(
      anchor,
      [...events.values()],
      input.currentCommitment,
    );
    if (projected.complete) {
      check(
        (await client.getBlock({ blockNumber: head.number })).hash ===
          head.hash,
        "study_revision_head_changed",
      );
      return {
        complete: true as const,
        latest: projected.latest,
        search: undefined,
      };
    }
    to = from - 1n;
  }
  check(to >= BigInt(anchor.blockNumber), "study_revision_history_incomplete");
  check(
    (await client.getBlock({ blockNumber: head.number })).hash === head.hash,
    "study_revision_head_changed",
  );
  return {
    complete: false as const,
    latest: anchor,
    search: {
      ...search,
      nextToBlock: String(to),
      events: [...events.values()],
    },
  };
}
