import {
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  type AbiParameter,
  type Hex,
  type PublicClient,
} from "viem";
import { insist } from "../community/common.ts";
import type { DanceControlIntent } from "../dance/contracts.ts";
import type {
  DanceControlBinding,
  DanceControlEvidence,
  RetainedControlAttempt,
} from "../dance/control-contracts.ts";
import { danceVerdictsAbi } from "./abi.ts";
import { danceReadPort } from "./rpc.ts";
import {
  verifyDanceSourceAt,
  type DanceBlock,
  type DanceLog,
  type DanceReadPort,
} from "./reader.ts";
import { controlJson, verifyControlBinding } from "./control-command.ts";

export interface DanceControlReadPort extends DanceReadPort {
  at(anchor: Pick<DanceBlock, "number" | "hash">): DanceReadPort;
}
/** Construction has no effects; no source selection or ABI fallback. */
export function danceControlReadPort(
  client: PublicClient,
): DanceControlReadPort {
  return {
    ...danceReadPort(client),
    at: (anchor) => danceReadPort(client, anchor),
  };
}
const eventAbi = danceVerdictsAbi.find(
  (item) => item.type === "event" && item.name === "CommandApplied",
)!;
const dataAbi = eventAbi.inputs.filter(
  (item) => !item.indexed,
) as readonly AbiParameter[];
const same = (a: string | null | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase();
const digest = (a: unknown): a is Hex =>
  typeof a === "string" && /^0x[\da-fA-F]{64}$/.test(a) && BigInt(a) > 0n;
const index = (a: unknown): a is number =>
  typeof a === "number" && Number.isSafeInteger(a) && a >= 0;
export function safeControlNumber(a: bigint): number {
  insist(
    a >= 0n && a <= BigInt(Number.MAX_SAFE_INTEGER),
    "dance_control_number_invalid",
    503,
  );
  return Number(a);
}
function owned(a: DanceLog, b: DanceLog) {
  return (
    a.removed === false &&
    b.removed === false &&
    same(a.address, b.address) &&
    a.blockNumber === b.blockNumber &&
    same(a.blockHash, b.blockHash!) &&
    same(a.transactionHash, b.transactionHash!) &&
    a.transactionIndex === b.transactionIndex &&
    a.logIndex === b.logIndex &&
    same(a.data, b.data) &&
    a.topics.length === b.topics.length &&
    a.topics.every((t, i) => same(t, b.topics[i]!))
  );
}
export function verifyRetainedAttempt(a: RetainedControlAttempt) {
  insist(
    /^0x(?:[\da-fA-F]{2})+$/.test(a.rawTransaction) &&
      digest(a.transactionHash) &&
      same(keccak256(a.rawTransaction as Hex), a.transactionHash) &&
      /^(0|[1-9]\d*)$/.test(a.nonce),
    "dance_control_attempt_changed",
    503,
  );
}

/** CommandApplied proves the exact caller-scoped typed command, not merely an
 * epoch or a current role. Account-contract callers need no invented EOA rule:
 * the pinned runtime hashes actual msg.sender into this exact event command. */
export async function verifyCanonicalDanceControl(
  rpc: DanceControlReadPort,
  intent: DanceControlIntent,
  binding: DanceControlBinding,
  attempt: RetainedControlAttempt,
  log: DanceLog,
  anchor?: DanceBlock,
): Promise<DanceControlEvidence> {
  const { source, resourceId } = verifyControlBinding(intent, binding);
  verifyRetainedAttempt(attempt);
  insist(
    attempt.commandId === intent.commandId &&
      same(attempt.transactionHash, log.transactionHash!),
    "dance_control_attempt_changed",
    503,
  );
  insist(
    BigInt(await rpc.chainId()) === source.domain.chainId,
    "dance_wrong_chain",
    503,
  );
  const observed = await rpc.safe(),
    safe = anchor ?? observed;
  insist(
    safe.number <= observed.number && digest(safe.hash),
    "dance_control_anchor_changed",
    503,
  );
  const {
    blockNumber: n,
    blockHash: hash,
    transactionHash: tx,
    transactionIndex: ti,
    logIndex: li,
  } = log;
  insist(
    log.removed === false &&
      same(log.address, source.domain.verifier) &&
      n !== null &&
      n >= source.pin.deploymentBlock &&
      n <= safe.number &&
      digest(hash) &&
      digest(tx) &&
      index(ti) &&
      index(li),
    "dance_control_log_position_invalid",
    503,
  );
  const [block, receipt] = await Promise.all([rpc.block(n), rpc.receipt(tx)]);
  insist(
    block.number === n &&
      same(block.hash, hash) &&
      same(block.transactions[ti], tx) &&
      block.timestamp > 0n &&
      block.timestamp <= BigInt(Number.MAX_SAFE_INTEGER) / 1000n,
    "dance_control_reorged",
    409,
  );
  insist(
    receipt?.status === "success" &&
      receipt.blockNumber === n &&
      same(receipt.blockHash, hash) &&
      same(receipt.transactionHash, tx) &&
      receipt.transactionIndex === ti,
    "dance_control_receipt_not_owned",
    503,
  );
  const logs = receipt.logs.filter((row) => row.logIndex === li);
  insist(
    logs.length === 1 && owned(logs[0]!, log),
    "dance_control_log_not_owned",
    503,
  );
  insist(
    log.topics.length === 4 && /^0x[\da-fA-F]{256}$/.test(log.data),
    "dance_control_event_invalid",
    503,
  );
  const event = decodeEventLog({
    abi: danceVerdictsAbi,
    eventName: "CommandApplied",
    data: log.data,
    topics: log.topics,
    strict: true,
  });
  const a = event.args,
    op = intent.operation === "grant" ? 2 : 3;
  const topics = encodeEventTopics({
    abi: danceVerdictsAbi,
    eventName: "CommandApplied",
    args: {
      caller: binding.caller as Hex,
      commandId: binding.wireId as Hex,
      operation: op,
    },
  });
  insist(
    topics.every((t, i) => typeof t === "string" && same(t, log.topics[i]!)) &&
      same(
        log.data,
        encodeAbiParameters(dataAbi, [
          a.commandHash,
          a.resourceId,
          a.resourceEpoch,
          a.committedAtSeconds,
        ]),
      ) &&
      same(a.caller, binding.caller) &&
      same(a.commandId, binding.wireId) &&
      a.operation === op &&
      same(a.commandHash, binding.commandHash) &&
      same(a.resourceId, resourceId) &&
      a.resourceEpoch === BigInt(binding.expectedEpoch) + 1n &&
      a.committedAtSeconds === block.timestamp,
    "dance_control_command_changed",
    503,
  );
  await verifyDanceSourceAt(rpc.at(block), source, n);
  await verifyDanceSourceAt(rpc.at(safe), source, safe.number);
  const [again, head] = await Promise.all([
    rpc.block(n),
    rpc.block(safe.number),
  ]);
  insist(
    again.number === n &&
      same(again.hash, hash) &&
      again.timestamp === block.timestamp &&
      head.number === safe.number &&
      same(head.hash, safe.hash) &&
      head.timestamp === safe.timestamp,
    "dance_control_anchor_changed",
    503,
  );
  return {
    version: "pirate.dance-control-evidence/1",
    commandId: intent.commandId,
    bindingHash: binding.bindingHash,
    sourceHash: binding.sourceHash,
    wallet: binding.wallet,
    state: "canonical",
    resultEpoch: safeControlNumber(a.resourceEpoch),
    blockNumber: safeControlNumber(n),
    blockHash: hash,
    transactionHash: tx,
    transactionIndex: ti,
    logIndex: li,
    anchorNumber: safeControlNumber(safe.number),
    anchorHash: safe.hash,
    rawLogJson: controlJson(log),
    reason: null,
  };
}

/** Missing receipts do not establish a reorg. Demotion requires a stable,
 * canonical replacement of the exact previously accepted block. */
export async function demoteDanceControl(
  rpc: DanceControlReadPort,
  intent: DanceControlIntent,
  binding: DanceControlBinding,
  prior: DanceControlEvidence,
  anchor?: DanceBlock,
): Promise<DanceControlEvidence> {
  const { source } = verifyControlBinding(intent, binding);
  insist(
    prior.bindingHash === binding.bindingHash &&
      prior.commandId === intent.commandId &&
      same(prior.sourceHash, binding.sourceHash),
    "dance_control_binding_changed",
    503,
  );
  const safe = anchor ?? (await rpc.safe());
  insist(
    BigInt(await rpc.chainId()) === source.domain.chainId,
    "dance_wrong_chain",
    503,
  );
  let state: "uncertain" | "orphaned" = "uncertain";
  if (
    prior.blockNumber !== null &&
    prior.blockHash &&
    BigInt(prior.blockNumber) <= safe.number
  ) {
    const block = await rpc.block(BigInt(prior.blockNumber));
    const [again, head] = await Promise.all([
      rpc.block(block.number),
      rpc.block(safe.number),
    ]);
    insist(
      block.number === BigInt(prior.blockNumber) &&
        again.number === block.number &&
        again.hash === block.hash &&
        head.number === safe.number &&
        head.hash === safe.hash &&
        head.timestamp === safe.timestamp,
      "dance_control_anchor_changed",
      503,
    );
    if (!same(block.hash, prior.blockHash)) state = "orphaned";
  }
  return {
    ...prior,
    state,
    anchorNumber: safeControlNumber(safe.number),
    anchorHash: safe.hash,
    reason:
      state === "orphaned"
        ? "canonical_block_replaced"
        : "original_receipt_unconfirmed",
  };
}
