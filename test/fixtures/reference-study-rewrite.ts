// Deliberately malformed raw evidence, with consistent wire hashes where useful.
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  type Abi,
  type Hex,
} from "viem";
import {
  resultCommitment,
  type TerminalResult,
} from "../../packages/protocol/learning-results-v3.ts";
import { v3Abi, type RawLog } from "../../harness/reference-results/facts.ts";
import type { studyTrace } from "./reference-study.ts";
export function rewriteStudyEvent(
  log: RawLog,
  name: string,
  values: Record<string, any>,
) {
  const event = getAbiItem({ abi: v3Abi as Abi, name });
  if (!event || event.type !== "event") throw Error("missing_rewrite_event");
  const inputs = event.inputs.filter((input) => !input.indexed);
  Object.assign(log, {
    topics: encodeEventTopics({
      abi: v3Abi as Abi,
      eventName: name,
      args: values,
    }),
    data: encodeAbiParameters(
      inputs,
      inputs.map((input) => values[input.name!]),
    ),
  });
}
export function rewriteLastStudy(
  f: ReturnType<typeof studyTrace>,
  change: (
    header: TerminalResult,
    wire: Hex,
  ) => { header: TerminalResult; wire: Hex },
) {
  const log = [...f.snapshot.logs]
    .reverse()
    .find(
      (log) =>
        log.address === f.address &&
        decodeEventLog({ abi: v3Abi, data: log.data, topics: log.topics })
          .eventName === "ResultPublished",
    )!;
  const original = decodeEventLog({
    abi: v3Abi,
    eventName: "ResultPublished",
    data: log.data,
    topics: log.topics,
  }).args;
  const next = change(original.result, original.outcomes),
    commitment = resultCommitment(next.header, next.wire);
  rewriteStudyEvent(log, "ResultPublished", {
    ...original,
    sessionId: next.header.sessionId,
    learner: next.header.learner,
    revision: next.header.revision,
    result: next.header,
    outcomes: next.wire,
    commitment,
  });
  f.state.commitments[next.header.sessionId] = commitment;
  // Synthetic append stores the same log object in both arrays. Assert callers
  // preserve that identity rather than silently weakening receipt checks.
  if (f.snapshot.receipts[log.transactionHash].logs[log.logIndex] !== log)
    throw Error("rewrite_receipt_identity_changed");
  return log;
}
