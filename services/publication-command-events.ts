import { decodeEventLog, encodeAbiParameters, encodeEventTopics, keccak256,
  stringToHex, type Hex } from "viem";
import { check, digest } from "../packages/protocol/index.ts";
import { publicationConsentAbi } from "../packages/protocol/generated/publication-consent-v1.ts";
import type { PublicationCommandJob } from "./publication-command-operator.ts";

export interface PublicationLog {
  address: string; data: Hex; topics: Hex[]; removed?: boolean;
  transactionHash: Hex; blockHash: Hex; blockNumber: Hex; transactionIndex: Hex;
}
export interface PublicationRpcReceipt {
  transactionHash: Hex; transactionIndex: Hex; blockNumber: Hex; blockHash: Hex;
  from: string; to: string|null; status: Hex; logs: PublicationLog[];
}
function wire(value: Record<string,unknown>) {
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,
    typeof v === "bigint" ? String(v) : typeof v === "string" &&
      /^0x[0-9a-fA-F]{40}(?![\s\S])/.test(v) ? v.toLowerCase() : v]));
}
/** Exact event reconstruction; RPC/block authentication is the caller's job. */
export function verifyPublicationCommandEvent(job: PublicationCommandJob,
  receipt: PublicationRpcReceipt, blockTimestamp: bigint) {
  const c = job.command, purposeHash = keccak256(stringToHex(c.message.purpose));
  const name = c.action === "grant" ? "PublicationGranted" : "PublicationWithdrawn";
  const topic = encodeEventTopics({abi:publicationConsentAbi,eventName:name})[0];
  const logs = receipt.logs.filter(log => log.address.toLowerCase() === c.source.registry &&
    log.topics[0]?.toLowerCase() === topic);
  check(logs.length === 1, "publication_event_missing_or_ambiguous");
  const log = logs[0];
  check(!log.removed && log.transactionHash === receipt.transactionHash &&
    log.blockHash === receipt.blockHash && log.blockNumber === receipt.blockNumber &&
    log.transactionIndex === receipt.transactionIndex && log.topics.length > 0,
    "publication_event_provenance_changed");
  if (c.action === "grant") {
    const e = decodeEventLog({abi:publicationConsentAbi,eventName:"PublicationGranted",
      data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true});
    const a = e.args;
    check(a.grantId === c.digest && a.learner.toLowerCase() === c.message.learner &&
      a.purposeHash === purposeHash && a.recordedAt === blockTimestamp &&
      digest(wire(a.grant)) === digest(c.message), "publication_grant_event_changed");
    const definition = publicationConsentAbi.find(x => x.type === "event" && x.name === "PublicationGranted")!;
    const data = encodeAbiParameters(definition.inputs.filter(x => !x.indexed),[a.grant,a.recordedAt]);
    const topics = encodeEventTopics({abi:publicationConsentAbi,eventName:"PublicationGranted",
      args:{grantId:a.grantId,learner:a.learner,purposeHash:a.purposeHash}});
    check(data.toLowerCase() === log.data.toLowerCase() && topics.length === log.topics.length &&
      topics.every((t,i) => typeof t === "string" && t.toLowerCase() === log.topics[i].toLowerCase()),
      "publication_event_noncanonical");
  } else {
    const e = decodeEventLog({abi:publicationConsentAbi,eventName:"PublicationWithdrawn",
      data:log.data,topics:log.topics as [Hex,...Hex[]],strict:true});
    const a = e.args;
    check(a.learner.toLowerCase() === c.message.learner && a.purposeHash === purposeHash &&
      a.withdrawalId === c.digest && a.previousEpoch === BigInt(c.message.expectedEpoch) &&
      a.nextEpoch === a.previousEpoch + 1n, "publication_withdrawal_event_changed");
    const definition = publicationConsentAbi.find(x => x.type === "event" && x.name === "PublicationWithdrawn")!;
    const data = encodeAbiParameters(definition.inputs.filter(x => !x.indexed),
      [a.previousEpoch,a.nextEpoch,a.withdrawalId]);
    const topics = encodeEventTopics({abi:publicationConsentAbi,eventName:"PublicationWithdrawn",
      args:{learner:a.learner,purposeHash:a.purposeHash}});
    check(data.toLowerCase() === log.data.toLowerCase() && topics.length === log.topics.length &&
      topics.every((t,i) => typeof t === "string" && t.toLowerCase() === log.topics[i].toLowerCase()),
      "publication_event_noncanonical");
  }
}
