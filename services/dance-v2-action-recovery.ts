import {
  decodeAbiParameters,
  encodeAbiParameters,
  getSerializedTransactionType,
  keccak256,
  parseEventLogs,
  parseTransaction,
  recoverTransactionAddress,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerializedLegacy,
} from "viem";
import {
  bytes32,
  canonical,
  insist,
  object,
} from "../packages/community/common.ts";
import { danceReadPort } from "../packages/dance-chain/rpc.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/v2/abi.ts";
import {
  dancePayloads,
  danceShapes,
} from "../packages/dance-chain/v2/wire-shapes.ts";
import {
  danceAccountCommitment,
  danceCommand,
  danceMediaId,
  danceReviewerConsent,
  danceSubmissionId,
  type DanceSourcePin,
} from "../packages/dance-chain/v2/wire.ts";
import {
  parseDanceCaptureV2,
  type PublicationCaptureV2,
} from "../packages/dance/capture-v2.ts";
import { consentAddress } from "../packages/protocol/publication-consent.ts";
import {
  type DanceV2Action,
  type DanceV2ActionStore,
  type DanceV2ReadyCommand,
} from "./dance-v2-action-store.ts";

export interface DanceV2OperatorOriginal {
  chainId: number;
  verifier: Address;
  communityId: Hex;
  publisher: Address;
  sourceHash: Hex;
  kind: DanceV2Action["kind"];
  commandId: Hex;
  commandHash: Hex;
  resourceId: Hex;
}

export interface DanceV2SignedAttempt {
  readonly nonce: number;
  readonly hash: Hex;
  readonly raw: Hex;
}

/** The installed publisher's private nonce journal owns this lookup. It can
 * return only the original for this tuple. Lookup cannot accept or send work. */
export interface DanceV2OriginalLookup {
  readRetainedAttempt(
    original: Readonly<DanceV2OperatorOriginal>,
  ): Promise<DanceV2SignedAttempt | null>;
}

const sameAddress = (a: string | null | undefined, b: string) =>
  a?.toLowerCase() === b.toLowerCase();

async function retained(
  store: DanceV2ActionStore,
  action: DanceV2Action,
  ready: DanceV2ReadyCommand,
) {
  const [saved, command, row] = await Promise.all([
    store.read(action.community_id, action.capture_id, action.kind),
    store.ready(action.command_id),
    store
      .stmt(
        `SELECT c.account_id,c.capture_json,s.consent_json FROM dance_captures c
       JOIN dance_consents s ON s.capture_id=c.capture_id
       WHERE c.community_id=? AND c.capture_id=?`,
        action.community_id,
        action.capture_id,
      )
      .first<{
        account_id: string;
        capture_json: string;
        consent_json: string;
      }>(),
  ]);
  const request = object(JSON.parse(action.input_json));
  const checked = store.same(
    saved,
    store.original(
      action.community_id,
      action.capture_id,
      action.kind,
      action.account_id,
      request,
    ),
  );
  insist(
    canonical({ ...checked }) === canonical(action) &&
      command &&
      canonical({ ...command }) === canonical(ready) &&
      row,
    "dance_v2_action_original_changed",
    409,
  );
  const parsed = parseDanceCaptureV2({
    ...JSON.parse(row.capture_json),
    consent: JSON.parse(row.consent_json),
  });
  insist(
    parsed.publication.kind === "publication-bound",
    "dance_v2_action_original_changed",
    409,
  );
  const capture = parsed as PublicationCaptureV2;
  insist(
    capture.communityId === action.community_id &&
      capture.captureId === action.capture_id &&
      capture.learner.accountId === row.account_id &&
      capture.canonical.sourceHash === ready.source_hash,
    "dance_v2_action_original_changed",
    409,
  );
  const domain = {
    ...capture.canonical.domain,
    chainId: BigInt(capture.canonical.domain.chainId),
  };
  const [pin] = decodeAbiParameters(
    [danceShapes.sourcePin],
    capture.canonical.sourcePinAbi,
  );
  const [wire] = decodeAbiParameters(
    [danceShapes.capture],
    capture.canonical.captureAbi,
  );
  const resource = danceSubmissionId(domain, wire.learner, wire.captureId);
  const publisher = consentAddress(ready.publisher);
  const at = BigInt(action.bound_at_ms);
  let expected;
  if (action.kind === "register") {
    const [payload] = decodeAbiParameters(
      [dancePayloads.registerSubmission],
      ready.encoded,
    );
    insist(
      action.account_id === row.account_id &&
        bytes32(request.captureId) === capture.captureId &&
        encodeAbiParameters([danceShapes.capture], [payload.capture]) ===
          capture.canonical.captureAbi &&
        payload.submission.captureHash === capture.captureHash &&
        payload.submission.submissionId === resource &&
        payload.submission.trustedSubmittedAtMs === at &&
        typeof request.mediaId === "string" &&
        payload.submission.mediaIdCommitment ===
          danceMediaId(domain, request.mediaId) &&
        payload.recordingSha256 === bytes32(request.recordingSha256) &&
        payload.expectedOwnerEpoch === BigInt(capture.expected.ownerEpoch) &&
        payload.expectedConfigurationRevision ===
          BigInt(capture.expected.configurationRevision) &&
        payload.expectedRulesEpoch === 0n &&
        payload.expectedMediaEpoch === 0n,
      "dance_v2_action_original_changed",
      409,
    );
    expected = danceCommand(
      domain,
      "registerSubmission",
      publisher,
      action.command_id,
      payload,
    );
  } else {
    const [payload] = decodeAbiParameters(
      [dancePayloads.commitVerdict],
      ready.encoded,
    );
    const { decision } = payload;
    insist(
      action.kind === "verdict" &&
        action.account_id !== row.account_id &&
        decision.submissionId === resource &&
        !sameAddress(decision.reviewerWallet, wire.learner) &&
        decision.reviewerGroupId !== wire.groupId &&
        decision.reviewerConsentHash ===
          danceReviewerConsent(
            domain,
            decision.reviewerAccountCommitment,
            decision.reviewerWallet,
            pin.publicityPolicyHash,
            at,
          ) &&
        decision.intentAcceptedAtMs === at &&
        (request.verdict === "pass" || request.verdict === "not_passed") &&
        decision.verdict === (request.verdict === "pass" ? 1 : 2) &&
        decision.reviewerAccountCommitment ===
          danceAccountCommitment(
            domain,
            action.account_id,
            decision.reviewerWallet,
          ) &&
        decision.expectedOwnerEpoch === BigInt(capture.expected.ownerEpoch) &&
        decision.expectedConfigurationRevision ===
          BigInt(capture.expected.configurationRevision) &&
        decision.expectedRulesEpoch === 0n &&
        decision.expectedMediaEpoch === 1n,
      "dance_v2_action_original_changed",
      409,
    );
    expected = danceCommand(
      domain,
      "commitVerdict",
      publisher,
      action.command_id,
      payload,
    );
  }
  insist(
    domain.chainId === 6343n &&
      ready.command_id === expected.id &&
      expected.hash === ready.command_hash &&
      expected.encoded === ready.encoded &&
      expected.data === ready.calldata &&
      resource === ready.resource_id,
    "dance_v2_action_original_changed",
    409,
  );
  const original = Object.freeze<DanceV2OperatorOriginal>({
    chainId: Number(domain.chainId),
    verifier: domain.verifier,
    communityId: action.community_id,
    publisher,
    sourceHash: ready.source_hash,
    kind: action.kind,
    commandId: expected.id,
    commandHash: expected.hash,
    resourceId: resource,
  });
  return { original, expected, pin };
}

function legacy(raw: Hex): asserts raw is TransactionSerializedLegacy {
  insist(
    raw.length <= 8192 &&
      /^0x(?:[0-9a-f]{2})+(?![\s\S])/.test(raw) &&
      getSerializedTransactionType(raw) === "legacy",
    "dance_v2_transaction_original_changed",
    503,
  );
}

/** Observation only. Permission to prepare a fresh effect is independent of
 * the historical command; a status retry cannot reach a sender or nonce allocator. */
export async function recoverDanceV2Action(input: {
  store: DanceV2ActionStore;
  action: DanceV2Action;
  ready: DanceV2ReadyCommand;
  client: PublicClient;
  lookup: DanceV2OriginalLookup;
}) {
  const { store, client, lookup } = input;
  const action = structuredClone(input.action),
    ready = structuredClone(input.ready);
  const { original, expected, pin } = await retained(store, action, ready);
  const attempt = structuredClone(await lookup.readRetainedAttempt(original));
  if (!attempt) return "awaiting_publisher" as const;
  return observeDanceV2Original({
    client, original, expected, pin, attempt,
    async assertCurrent() {
      await retained(store, action, ready);
      insist(canonical(await lookup.readRetainedAttempt(original)) === canonical(attempt),
        "dance_v2_transaction_original_changed", 503);
    },
  });
}

/** Canonical proof shared by application observation and the held sender's
 * nonce reconciliation. This path does not allocate, sign, or broadcast. */
export async function observeDanceV2Original(input: {
  client: PublicClient;
  original: Readonly<DanceV2OperatorOriginal>;
  expected: Readonly<{ data: Hex; hash: Hex; operation: number }>;
  pin: Readonly<DanceSourcePin>;
  attempt: Readonly<DanceV2SignedAttempt>;
  assertCurrent(): Promise<void>;
}) {
  const { client, original, expected, pin, attempt, assertCurrent } = input;
  const { chainId, verifier, publisher, commandId } = original;
  const { raw, hash, nonce } = attempt;
  legacy(raw);
  const parsed = parseTransaction(raw);
  insist(
    Number.isSafeInteger(nonce) &&
      nonce >= 0 &&
      keccak256(raw) === bytes32(hash) &&
      parsed.chainId === chainId &&
      parsed.nonce === nonce &&
      sameAddress(parsed.to, verifier) &&
      parsed.data === expected.data &&
      (parsed.value ?? 0n) === 0n &&
      sameAddress(
        await recoverTransactionAddress({ serializedTransaction: raw }),
        publisher,
      ),
    "dance_v2_transaction_original_changed",
    503,
  );
  const rpc = danceReadPort(client);
  insist(
    (await rpc.chainId()) === chainId,
    "dance_v2_transaction_chain_changed",
    503,
  );
  const [receipt, safe] = await Promise.all([
    client.getTransactionReceipt({ hash }).catch((error: unknown) => {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }),
    rpc.safe(),
  ]);
  if (!receipt || receipt.blockNumber > safe.number)
    return "pending_confirmation" as const;
  const [tx, block] = await Promise.all([
    client.getTransaction({ hash }),
    rpc.block(receipt.blockNumber),
  ]);
  insist(
    (receipt.status === "success" || receipt.status === "reverted") &&
      receipt.transactionHash === hash &&
      receipt.blockNumber >= pin.deploymentBlock &&
      receipt.blockHash === block.hash &&
      sameAddress(receipt.from, publisher) &&
      sameAddress(receipt.to, verifier) &&
      block.transactions[receipt.transactionIndex] === hash &&
      tx.hash === hash &&
      tx.blockHash === block.hash &&
      tx.blockNumber === block.number &&
      tx.transactionIndex === receipt.transactionIndex &&
      sameAddress(tx.from, publisher) &&
      sameAddress(tx.to, verifier) &&
      tx.nonce === nonce &&
      tx.input === expected.data &&
      tx.value === 0n,
    "dance_v2_transaction_receipt_changed",
    503,
  );
  const anchored = { blockHash: block.hash, requireCanonical: true } as const;
  const code = await client.getCode({ address: verifier, ...anchored });
  insist(
    code && keccak256(code) === pin.runtimeCodeHash,
    "dance_v2_transaction_runtime_changed",
    503,
  );
  if (receipt.status === "success") {
    const state = await client.readContract({
      address: verifier,
      abi: danceVerdictsAbi,
      functionName: "commandReceipts",
      args: [publisher, commandId],
      ...anchored,
    });
    const events = parseEventLogs({
      abi: danceVerdictsAbi,
      eventName: "CommandAppliedV2",
      logs: receipt.logs,
      strict: true,
    }).filter(
      (event) =>
        sameAddress(event.address, verifier) &&
        sameAddress(event.args.caller, publisher) &&
        event.args.commandId === commandId,
    );
    const event = events[0];
    insist(
      events.length === 1 &&
        event &&
        !event.removed &&
        event.blockHash === block.hash &&
        event.blockNumber === block.number &&
        event.transactionHash === hash &&
        event.transactionIndex === receipt.transactionIndex &&
        event.args.commandHash === expected.hash &&
        event.args.operation === expected.operation &&
        event.args.resourceId === original.resourceId &&
        event.args.resourceEpoch === 1n &&
        event.args.committedAtSeconds === block.timestamp &&
        state[0] === expected.hash &&
        state[1] === expected.operation &&
        state[2] === original.resourceId &&
        state[3] === 1n &&
        state[4] === block.timestamp,
      "dance_v2_transaction_event_changed",
      503,
    );
  }
  await assertCurrent();
  const [again, sameSafe, currentSafe, chain] = await Promise.all([
    rpc.block(block.number),
    rpc.block(safe.number),
    rpc.safe(),
    rpc.chainId(),
  ]);
  insist(
    chain === chainId &&
      again.hash === block.hash &&
      again.timestamp === block.timestamp &&
      sameSafe.hash === safe.hash &&
      sameSafe.timestamp === safe.timestamp &&
      currentSafe.number >= safe.number &&
      (currentSafe.number !== safe.number || currentSafe.hash === safe.hash),
    "dance_v2_transaction_receipt_reorg",
    503,
  );
  return receipt.status === "success"
    ? ("confirmed" as const)
    : ("reverted" as const);
}
