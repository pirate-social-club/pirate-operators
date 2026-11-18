import {
  getSerializedTransactionType, keccak256, parseEventLogs, parseTransaction, recoverTransactionAddress, stringToHex,
  zeroAddress, zeroHash, type Address, type Hex, type PublicClient, type TransactionSerializedLegacy,
} from "viem";
import { insist } from "../packages/community/common.ts";
import { danceReadPort } from "../packages/dance-chain/rpc.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/v2/abi.ts";
import { danceAccountCommitment, danceCommand, danceSingletonId, danceSourceHash } from "../packages/dance-chain/v2/wire.ts";
import { consentAddress, consentDigest } from "../packages/protocol/publication-consent.ts";
import { learningResultsV5Abi } from "../packages/protocol/generated/learning-results-v5.ts";
import { verifyDancePublicationSource, type DancePublicationSourceV2 } from "./dance-publication-source.ts";

export interface DanceV2PrivateParticipant {
  accountId: string;
  wallet: Address;
  knownAliasAccountIds: readonly string[];
  purpose: "dance-verdict" | "dance-review-attribution";
  grantId: Hex;
}
type DanceV2PrivatePair = readonly [DanceV2PrivateParticipant, DanceV2PrivateParticipant];

type ParticipantAuthority = Parameters<typeof verifyDancePublicationSource>[0] & {
  participants: DanceV2PrivatePair;
  /** The application owns these retained account, wallet, alias and grant facts.
   * Recheck their exact originals before relying on publisher authority. */
  verifyPrivateOriginals(pair: DanceV2PrivatePair): Promise<void>;
};

type Plan = {
  accountId: string;
  wallet: Address;
  publisher: Address;
  sourceHash: Hex;
  ownerEpoch: bigint;
  configurationRevision: bigint;
  commandId: Hex;
};
export interface DanceV2BindingOriginal {
  plan: Readonly<Plan>;
  hash: Hex;
  nonce: number;
  raw: Hex;
}

const scope = (value: string) => keccak256(stringToHex(value));
const same = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();
function accountId(value: string) {
  insist(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(value),
    "dance_v2_private_uuid_required");
  return value;
}

function commitment(source: DancePublicationSourceV2, subject: { accountId: string; wallet: Address }) {
  const accountCommitment = danceAccountCommitment(source.domain, accountId(subject.accountId), consentAddress(subject.wallet));
  return { accountCommitment, groupId: danceSingletonId(source.domain, accountCommitment) };
}
function command(source: DancePublicationSourceV2, plan: Plan) {
  const { accountCommitment, groupId } = commitment(source, plan);
  return danceCommand(source.domain, "bindIdentity", consentAddress(plan.publisher), consentDigest(plan.commandId), {
    expectedOwnerEpoch: plan.ownerEpoch, expectedConfigurationRevision: plan.configurationRevision,
    accountCommitment, wallet: consentAddress(plan.wallet),
    expectedIdentityEpoch: 0n, sourceGroupId: zeroHash, sourceBindingGroupEpoch: 0n, sourceCurrentGroupEpoch: 0n,
    destinationGroupId: groupId, destinationGroupEpoch: 0n, createSingleton: true, active: true,
  });
}

async function open(input: ParticipantAuthority) {
  const pair = structuredClone(input.participants);
  const recheck = input.verifyPrivateOriginals, afterAwait = input.afterAwait, now = input.clock.now;
  insist(pair.length === 2 && pair[0].purpose === "dance-verdict" && pair[1].purpose === "dance-review-attribution"
    && accountId(pair[0].accountId) !== accountId(pair[1].accountId)
    && consentAddress(pair[0].wallet) !== consentAddress(pair[1].wallet)
    && consentDigest(pair[0].grantId) !== consentDigest(pair[1].grantId),
    "dance_v2_independent_participants_required", 403);
  for (const item of pair) {
    // A new singleton cannot hide an existing alias. The operator may only
    // select this path for an authenticated account with exactly this member.
    insist(item.knownAliasAccountIds.length === 1 && item.knownAliasAccountIds[0] === item.accountId,
      "dance_v2_singleton_alias_original_required", 403);
  }
  const authority = await verifyDancePublicationSource(input);
  const client = input.client, selected = authority.source;
  const reader = { address: selected.domain.verifier, abi: danceVerdictsAbi, ...authority.at } as const;
  const [rulesEpoch, reviewerRole, ...grants] = await Promise.all([
    client.readContract({ ...reader, functionName: "rulesEpoch" }),
    client.readContract({ ...reader, functionName: "reviewerRoles", args: [pair[1].wallet] }),
    ...pair.map(async (p, i) => {
      const read = { address: selected.pin.consentRegistry, abi: learningResultsV5Abi, ...authority.at } as const;
      const policy = i === 0 ? selected.pin.learnerConsentPolicyHash : selected.pin.reviewerConsentPolicyHash;
      const [checked, [grant, recordedAt]] = await Promise.all([
        client.readContract({ ...read, functionName: "checkGrant", args: [p.grantId, p.wallet, scope(p.purpose),
          selected.domain.verifier, policy, authority.anchor.timestamp] }),
        client.readContract({ ...read, functionName: "grantOf", args: [p.grantId] }),
      ]);
      insist(checked[0] && checked[1] === 0 && recordedAt > 0n && recordedAt <= authority.anchor.timestamp
        && grant.communityId === selected.domain.communityId && same(grant.learner, p.wallet)
        && grant.purpose === p.purpose && same(grant.publicationTarget, selected.domain.verifier)
        && grant.publicationTargetRuntimeHash === selected.pin.runtimeCodeHash && grant.policyHash === policy,
        "dance_v2_participant_grant_unavailable", 403);
      return grant.expiresAt;
    }),
  ]);
  const [reviewerEpoch, ownerEpoch, reviewerExpiresAt, active] = reviewerRole;
  const currentOwnerEpoch = authority.owner[0], observationTime = now();
  const ownerReviewer = same(pair[1].wallet, authority.owner[3]);
  insist(rulesEpoch === 0n && grants.every(expiresAt => observationTime < expiresAt)
    && (ownerReviewer || (active && reviewerEpoch > 0n && ownerEpoch === currentOwnerEpoch
      && authority.anchor.timestamp < reviewerExpiresAt && observationTime < reviewerExpiresAt)),
    "dance_v2_participant_grant_or_role_unavailable", 403);
  const finish = async () => {
    await recheck(structuredClone(pair));
    await afterAwait();
    await authority.finish();
    const observed = now();
    insist(grants.every(expiresAt => observed < expiresAt), "dance_v2_participant_grant_expired", 403);
    insist(ownerReviewer || observed < reviewerExpiresAt, "dance_v2_reviewer_role_expired", 403);
  };
  await finish();
  return { authority, reader, pair, finish, reviewerRoleEpoch: ownerReviewer ? currentOwnerEpoch : reviewerEpoch };
}

/** Prepare only new singleton commands. The host still owns durable signing
 * and exact submission. An unavailable, nonempty or merged state refuses. */
export async function prepareDanceV2ParticipantBindings(input: ParticipantAuthority & { commandIds: readonly [Hex, Hex] }) {
  const ids = structuredClone(input.commandIds);
  insist(consentDigest(ids[0]) !== consentDigest(ids[1]), "dance_v2_duplicate_binding_command");
  const { authority, reader, pair, finish } = await open(input);
  const initial = await Promise.all(pair.map(async p => {
    const { accountCommitment, groupId } = commitment(authority.source, p);
    return Promise.all([
      input.client.readContract({ ...reader, functionName: "identities", args: [accountCommitment] }),
      input.client.readContract({ ...reader, functionName: "groups", args: [groupId] }),
    ]);
  }));
  insist(initial.every(([i, g]) => same(i[0], zeroAddress) && i[1] === 0n && i[2] === zeroHash && i[3] === 0n && !i[4]
    && g[0] === 0n && g[1] === 0n && g[2] === 0n && g[3] === zeroHash && !g[4]),
    "dance_v2_initial_identity_already_bound", 409);
  await finish();
  return pair.map((subject, n) => {
    const plan = Object.freeze({ accountId: subject.accountId, wallet: subject.wallet,
      publisher: authority.config.publisher, sourceHash: authority.source.sourceHash, ownerEpoch: authority.owner[0],
      configurationRevision: BigInt(authority.config.configurationRevision), commandId: ids[n]! });
    return { plan, command: command(authority.source, plan) };
  });
}

/** Current admission only. Historical receipt validation below can survive
 * revocation, expiry or a later alias-group change. */
export async function readDanceV2ParticipantBindings(input: ParticipantAuthority) {
  const { authority, reader, pair, finish, reviewerRoleEpoch } = await open(input);
  const participants = await Promise.all(pair.map(async p => {
    const { accountCommitment, groupId } = commitment(authority.source, p);
    const [identity, group] = await Promise.all([
      input.client.readContract({ ...reader, functionName: "identities", args: [accountCommitment] }),
      input.client.readContract({ ...reader, functionName: "groups", args: [groupId] }),
    ]);
    insist(same(identity[0], p.wallet) && identity[1] === 1n && identity[2] === groupId && identity[3] === 1n && identity[4]
      && group[0] === 1n && group[1] === 1n && group[2] === 0n && group[3] === zeroHash && group[4],
      "dance_v2_active_singleton_unavailable", 403);
    return { ...p, accountCommitment, groupId, identityEpoch: identity[1], groupEpoch: identity[3] };
  }));
  insist(participants[0]!.groupId !== participants[1]!.groupId, "dance_v2_same_alias_group", 403);
  await finish();
  return { participants: [participants[0]!, participants[1]!] as const, reviewerRoleEpoch, anchor: authority.anchor };
}

function legacy(raw: Hex): asserts raw is TransactionSerializedLegacy {
  insist(/^0x(?:[0-9a-f]{2})+(?![\s\S])/.test(raw) && getSerializedTransactionType(raw) === "legacy",
    "dance_v2_binding_original_changed");
}
export async function verifyDanceV2BindingOriginal(input: {
  client: PublicClient;
  source: DancePublicationSourceV2;
  original: DanceV2BindingOriginal;
}) {
  const { client } = input, source = structuredClone(input.source), saved = structuredClone(input.original);
  const { domain, pin } = source, { plan, hash, raw, nonce } = saved;
  insist(source.version === 2 && domain.chainId === 6343n && plan.sourceHash === source.sourceHash
    && danceSourceHash(domain, pin) === source.sourceHash && plan.ownerEpoch > 0n && plan.configurationRevision > 0n
    && Number.isSafeInteger(nonce) && nonce >= 0 && keccak256(raw) === consentDigest(hash),
    "dance_v2_binding_original_changed", 409);
  const expected = command(source, plan), { accountCommitment } = commitment(source, plan);
  legacy(raw);
  const tx = parseTransaction(raw), signer = await recoverTransactionAddress({ serializedTransaction: raw });
  insist(tx.chainId === Number(domain.chainId) && same(tx.to ?? null, domain.verifier) && same(signer, plan.publisher)
    && tx.nonce === nonce && (tx.value ?? 0n) === 0n && tx.data === expected.data,
    "dance_v2_binding_original_changed", 409);
  const rpc = danceReadPort(client);
  insist(await rpc.chainId() === 6343, "dance_v2_binding_chain_changed", 503);
  const [receipt, transaction, safe] = await Promise.all([
    client.getTransactionReceipt({ hash }), client.getTransaction({ hash }), rpc.safe(),
  ]);
  insist(receipt.status === "success" && receipt.transactionHash === hash && same(receipt.from, plan.publisher)
    && same(receipt.to, domain.verifier) && receipt.blockNumber >= pin.deploymentBlock && receipt.blockNumber <= safe.number,
    "dance_v2_binding_receipt_unconfirmed", 503);
  const block = await rpc.block(receipt.blockNumber);
  insist(block.hash === receipt.blockHash && block.transactions[receipt.transactionIndex] === hash
    && transaction.hash === hash && transaction.blockHash === block.hash && transaction.blockNumber === block.number
    && transaction.transactionIndex === receipt.transactionIndex && same(transaction.from, plan.publisher)
    && same(transaction.to, domain.verifier) && transaction.input === expected.data
    && transaction.nonce === nonce && transaction.value === 0n,
    "dance_v2_binding_receipt_changed", 503);
  const at = { blockHash: block.hash, requireCanonical: true } as const;
  const [code, state] = await Promise.all([
    client.getCode({ address: domain.verifier, ...at }),
    client.readContract({ address: domain.verifier, abi: danceVerdictsAbi, functionName: "commandReceipts",
      args: [plan.publisher, expected.id], ...at }),
  ]);
  const event = parseEventLogs({ abi: danceVerdictsAbi, eventName: "CommandAppliedV2", logs: receipt.logs, strict: true })
    .filter(e => same(e.address, domain.verifier) && same(e.args.caller, plan.publisher) && e.args.commandId === expected.id);
  const e = event[0], [digest, operation, resource, epoch, committedAt] = state;
  insist(code && keccak256(code) === pin.runtimeCodeHash && event.length === 1 && e && !e.removed
    && e.blockHash === block.hash && e.blockNumber === block.number && e.transactionHash === hash
    && e.transactionIndex === receipt.transactionIndex && e.args.commandHash === expected.hash
    && e.args.operation === expected.operation && e.args.resourceId === accountCommitment && e.args.resourceEpoch === 1n
    && e.args.committedAtSeconds === block.timestamp && digest === expected.hash && operation === expected.operation
    && resource === accountCommitment && epoch === 1n && committedAt === block.timestamp,
    "dance_v2_binding_original_event_changed", 503);
  const [again, sameSafe, currentSafe, chainId] = await Promise.all([
    rpc.block(block.number), rpc.block(safe.number), rpc.safe(), rpc.chainId(),
  ]);
  insist(chainId === 6343 && again.hash === block.hash && again.timestamp === block.timestamp
    && sameSafe.hash === safe.hash && sameSafe.timestamp === safe.timestamp && currentSafe.number >= safe.number
    && (currentSafe.number !== safe.number || currentSafe.hash === safe.hash),
    "dance_v2_binding_receipt_reorg", 503);
  return { resourceId: accountCommitment, resourceEpoch: epoch, transactionHash: hash,
    blockNumber: block.number, blockHash: block.hash, commandId: expected.id, commandHash: expected.hash };
}
