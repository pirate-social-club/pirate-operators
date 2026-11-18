import { keccak256, numberToHex, type Address, type Hex } from "viem";
import { canonical, exact, insist, object } from "../packages/community/common.ts";
import { parseWeb2ProfileDocument } from "../packages/community/web2-directory.ts";
import { danceSourceHash } from "../packages/dance-chain/v2/wire.ts";
import { DANCE_DB_NOW } from "../packages/dance/store.ts";
import { digest } from "../packages/protocol/index.ts";
import { consentAddress, consentDigest, consentUint64 } from "../packages/protocol/publication-consent.ts";
import type { ConsentCommandReceiptV1 } from "../packages/protocol/publication-runtime-v1.ts";
import { prepareDanceV2ParticipantBindings, type DanceV2PrivateParticipant } from "./dance-v2-participant-bindings.ts";
import type { DancePublicationSourceV2 } from "./dance-publication-source.ts";
import { publicationOriginalFingerprint, PUBLICATION_PENDING_WITHDRAWAL } from "./publication-app-activation.ts";
import { publicationOriginal } from "./publication-app-request.ts";
import { publicationSelectionSource } from "./publication-app-selection.ts";
import { parsePublicationReceipt } from "./publication-app-transport.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";
import { capturedFee, parseCommand, preparedCall, signature, sourceId } from "./publication-command-contract.ts";
import { verifyPublicationCommandEvent } from "./publication-command-events.ts";
import type { PublicationCommandJob } from "./publication-command-operator.ts";
import type { CommandRow } from "./publication-command-store.ts";

type Purpose = DanceV2PrivateParticipant["purpose"];
type GrantSelection<P extends Purpose> = Readonly<{ purpose: P; commandId: Hex; accountId: string }>;
export interface InstalledDanceBindIntent {
  schema: "pirate.installed-dance-bind-intent/1";
  intentId: Hex;
  installedBindingSha256: Hex;
  communityId: Hex;
  installationId: Hex;
  releaseSha256: Hex;
  configurationSha256: Hex;
  sourceHash: Hex;
  ownerEpoch: string;
  ownerWallet: Address;
  grants: readonly [GrantSelection<"dance-verdict">, GrantSelection<"dance-review-attribution">];
}

type RecordedReceipt = ConsentCommandReceiptV1 & {
  state: "recorded";
  transactionHash: Hex;
  observed: { blockNumber: string; blockHash: Hex; timestampS: string };
  transactionIndex: number;
};
type GrantRead = {
  member: DanceV2PrivateParticipant;
  job: PublicationCommandJob;
  receipt: RecordedReceipt;
  fingerprint: string;
};
type PrimaryGrant = CommandRow & {
  observed_json: string;
  actor_author: string;
  actor_binding: string;
  actor_wallet: Address;
  checked_at_ms: number;
  head_stop_command: Hex | null;
};

function ownIntent(value: InstalledDanceBindIntent) {
  const owned = structuredClone(value);
  exact(object(owned), ["schema", "intentId", "installedBindingSha256", "communityId", "installationId",
    "releaseSha256", "configurationSha256", "sourceHash", "ownerEpoch", "ownerWallet", "grants"]);
  insist(owned.schema === "pirate.installed-dance-bind-intent/1" && Array.isArray(owned.grants) &&
    owned.grants.length === 2 && owned.grants[0].purpose === "dance-verdict" &&
    owned.grants[1].purpose === "dance-review-attribution", "dance_installed_prepare_intent_invalid", 403);
  for (const key of ["intentId", "installedBindingSha256", "communityId", "installationId",
    "releaseSha256", "configurationSha256", "sourceHash"] as const) consentDigest(owned[key]);
  consentAddress(owned.ownerWallet);
  insist(consentUint64(owned.ownerEpoch) > 0n, "dance_installed_prepare_intent_invalid", 403);
  for (const grant of owned.grants) {
    exact(object(grant), ["purpose", "commandId", "accountId"]);
    consentDigest(grant.commandId);
    insist(typeof grant.accountId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(grant.accountId),
    "dance_installed_prepare_account_invalid", 403);
  }
  insist(owned.grants[0].accountId !== owned.grants[1].accountId &&
    owned.grants[0].commandId !== owned.grants[1].commandId, "dance_installed_prepare_independent_grants_required", 403);
  return owned;
}

async function canonicalGrant(
  client: PublicationApplicationPorts["client"], grant: GrantRead, current: () => Promise<void>,
) {
  const { receipt: original, job } = grant, { transactionHash: hash, observed } = original;
  const blockNumber = BigInt(observed.blockNumber), timestamp = BigInt(observed.timestampS);
  const [receipt, transaction, block, safe] = await Promise.all([
    client.getTransactionReceipt({ hash }), client.getTransaction({ hash }),
    client.getBlock({ blockNumber, includeTransactions: false }),
    client.getBlock({ blockTag: "safe", includeTransactions: false }),
  ]);
  await current();
  insist(safe.number !== null && safe.number >= blockNumber && safe.hash && safe.timestamp >= timestamp &&
    block.number === blockNumber && block.hash === observed.blockHash && block.timestamp === timestamp &&
    block.transactions[original.transactionIndex] === hash && receipt.status === "success" &&
    receipt.blockHash === block.hash && receipt.blockNumber === blockNumber &&
    receipt.transactionIndex === original.transactionIndex && receipt.transactionHash === hash &&
    receipt.from.toLowerCase() === job.fee.payer && receipt.to?.toLowerCase() === job.command.source.registry &&
    transaction.hash === hash && transaction.from.toLowerCase() === job.fee.payer &&
    transaction.to?.toLowerCase() === job.command.source.registry && transaction.input === job.data &&
    transaction.blockHash === block.hash && transaction.blockNumber === blockNumber &&
    transaction.transactionIndex === original.transactionIndex && transaction.value === 0n,
  "dance_installed_prepare_receipt_unconfirmed", 503);
  const code = await client.getCode({ address: job.command.source.registry, blockHash: block.hash, requireCanonical: true });
  insist(code && keccak256(code) === job.command.source.registryRuntimeHash, "dance_installed_prepare_registry_changed", 503);
  verifyPublicationCommandEvent(job, {
    status: "0x1", transactionHash: hash, transactionIndex: numberToHex(original.transactionIndex),
    blockNumber: numberToHex(blockNumber), blockHash: block.hash, from: receipt.from, to: receipt.to,
    logs: receipt.logs.map(log => {
      insist(log.transactionHash && log.transactionIndex !== null && log.blockNumber !== null && log.blockHash,
        "dance_installed_prepare_receipt_unconfirmed", 503);
      return { ...log, transactionHash: log.transactionHash, transactionIndex: numberToHex(log.transactionIndex),
        blockNumber: numberToHex(log.blockNumber), blockHash: log.blockHash };
    }),
  }, timestamp);
  const [again, safeAgain] = await Promise.all([
    client.getBlock({ blockNumber, includeTransactions: false }),
    client.getBlock({ blockNumber: safe.number, includeTransactions: false }),
  ]);
  await current();
  insist(again.hash === block.hash && again.timestamp === timestamp &&
    safeAgain.hash === safe.hash && safeAgain.timestamp === safe.timestamp,
  "dance_installed_prepare_receipt_reorg", 503);
}

/** Call only from an already authenticated private owner mount. The owner
 * must retain the complete first response before admitting any signed work. */
export async function prepareInstalledDanceBindings(input: {
  publication: PublicationApplicationPorts;
  source: DancePublicationSourceV2;
  intent: InstalledDanceBindIntent;
  assertOwnerCurrent(): Promise<void>;
}) {
  const { publication: ports, assertOwnerCurrent } = input;
  const { db, installation, client, catalog } = ports;
  const clock = { ...ports.clock }, intent = ownIntent(input.intent), selected = structuredClone(input.source);
  const release = catalog.fresh(), config = structuredClone(release.configuration);
  const releaseSource = publicationSelectionSource(release), releaseSha256 = releaseSource.releaseSelectionSha256;
  const profile = parseWeb2ProfileDocument(release.profile);
  insist(typeof assertOwnerCurrent === "function" && installation?.db === db && installation.catalog === catalog &&
    installation.expected.installedBindingSha256 === intent.installedBindingSha256 &&
    installation.expected.installationId === intent.installationId &&
    installation.expected.communityId === intent.communityId &&
    profile.installationId === config.installationId && config.installationId === intent.installationId &&
    profile.communityId === intent.communityId && releaseSource.communityId === config.communityId && config.communityId === intent.communityId &&
    profile.chainId === 6343 && releaseSource.chainId === 6343 && config.chainId === 6343 && selected.domain.chainId === 6343n &&
    selected.domain.communityId === intent.communityId && selected.sourceHash === intent.sourceHash &&
    danceSourceHash(selected.domain, selected.pin) === selected.sourceHash &&
    releaseSha256 === intent.releaseSha256 && catalog.active === releaseSha256 &&
    digest(config) === intent.configurationSha256 &&
    release.operator === config.publisher && release.fee.payer === config.publisher,
  "dance_installed_prepare_scope_changed", 503);
  const installed = installation;
  const sameConfig = digest(config);
  async function current() {
    await assertOwnerCurrent.call(input);
    insist(input.assertOwnerCurrent === assertOwnerCurrent && input.publication === ports &&
      ports.db === db && ports.installation === installed && ports.client === client && ports.catalog === catalog &&
      ports.clock.now === clock.now && ports.clock.maxSafeBlockAgeSeconds === clock.maxSafeBlockAgeSeconds &&
      catalog.active === releaseSha256 && digest(catalog.fresh().configuration) === sameConfig,
    "dance_installed_prepare_scope_changed", 503);
    await installed.check();
  }
  const fence = installed.fence("active", releaseSha256);
  async function grants(): Promise<readonly [GrantRead, GrantRead]> {
    await current();
    const [learner, reviewer] = intent.grants;
    // One primary SELECT evaluates the active installation and both local
    // head/withdrawal/credential/alias fences together. This path writes no guards.
    const result = await db.withSession("first-primary").prepare(
      `SELECT c.*, o.value_json AS observed_json, a.author_id AS actor_author,
        b.binding_id AS actor_binding, b.subject AS actor_wallet, ${DANCE_DB_NOW} AS checked_at_ms,
        h.stop_command_id AS head_stop_command
       FROM publication_v1_commands c
       JOIN publication_v1_heads h ON h.community_id=c.community_id AND h.account_id=c.account_id
         AND h.source_id=c.source_id AND h.purpose=c.purpose
       JOIN publication_v1_observations o ON o.command_id=c.command_id AND o.proof_hash=c.observation_hash
       JOIN community_accounts a ON a.account_id=c.account_id
       JOIN credential_bindings b ON b.account_id=a.account_id AND b.namespace='moss' AND b.network=6343
       WHERE c.community_id=? AND c.source_id=? AND c.action='grant' AND c.phase='accepted' AND c.result_state='recorded'
       AND ((c.command_id=? AND c.account_id=? AND c.purpose=?) OR (c.command_id=? AND c.account_id=? AND c.purpose=?))
       AND h.stopped=0 AND h.generation=c.fence_generation AND NOT (${PUBLICATION_PENDING_WITHDRAWAL})
       AND (SELECT COUNT(*) FROM credential_bindings x WHERE x.namespace='moss' AND x.network=6343
         AND (x.account_id=a.account_id OR LOWER(x.subject)=LOWER(b.subject)))=1
       AND (${fence.sql}) LIMIT 3`,
    ).bind(config.communityId, sourceId(releaseSource), learner.commandId, learner.accountId, learner.purpose,
      reviewer.commandId, reviewer.accountId, reviewer.purpose, ...fence.values).all<PrimaryGrant>();
    const rows = result.results;
    insist(rows.length === 2, "dance_installed_prepare_grants_unavailable", 403);

    const grant = (selection: GrantSelection<Purpose>): GrantRead => {
      const row = rows.find(item => item.command_id === selection.commandId);
      insist(row && row.account_id === selection.accountId && row.purpose === selection.purpose &&
        row.created_at > 0 && row.typed_json && row.signature && row.accepted_json &&
        row.observation_hash && row.nonce_hex && Number.isSafeInteger(row.checked_at_ms) &&
        digest(JSON.parse(row.request_json)) === row.request_hash,
      "dance_installed_prepare_grant_changed", 403);
      const { capture } = publicationOriginal(row, catalog), wallet = consentAddress(capture.learner);
      const command = parseCommand(JSON.parse(row.typed_json)), descriptor = release.policies[selection.purpose];
      insist(descriptor && row.actor_author === capture.authorId && row.actor_binding === capture.bindingId &&
        row.actor_wallet === wallet && capture.accountId === row.account_id && capture.sourceCommandId === null &&
        capture.origin === config.app.origin && capture.releaseSelectionSha256 === releaseSha256 &&
        command.action === "grant" && command.accountId === row.account_id &&
        command.commandId === row.command_id && command.requestId === row.request_id && command.digest === row.digest &&
        command.message.learner === wallet && command.message.nonce === row.nonce_hex &&
        command.message.purpose === selection.purpose &&
        command.message.publicationTarget === descriptor.target &&
        command.message.publicationTargetRuntimeHash === descriptor.runtimeHash &&
        command.message.permissionRevision === descriptor.permissionRevision && command.message.policyHash === descriptor.policyHash &&
        String(row.fence_generation) === command.localFenceGeneration &&
        canonical(command.source) === canonical(releaseSource) && canonical(command) === row.typed_json,
      "dance_installed_prepare_grant_changed", 403);
      const accepted = object(JSON.parse(row.accepted_json));
      exact(accepted, ["command", "signature", "fee"]);
      const sig = signature(row.signature), fee = capturedFee(accepted.fee);
      insist(canonical(accepted) === row.accepted_json && canonical(accepted.command) === row.typed_json &&
        accepted.signature === sig && canonical(fee) === canonical(release.fee), "dance_installed_prepare_grant_changed", 403);
      const receipt = parsePublicationReceipt(JSON.parse(row.observed_json), command);
      insist(receipt.state === "recorded" && receipt.transactionHash && canonical(receipt) === row.observed_json &&
        digest(receipt) === row.observation_hash, "dance_installed_prepare_grant_unrecorded", 403);
      const recorded = BigInt(receipt.observed.timestampS), start = BigInt(command.message.validAfter);
      const effective = recorded > start ? recorded : start, expiry = BigInt(command.message.expiresAt);
      insist(BigInt(row.checked_at_ms) >= effective * 1000n && BigInt(row.checked_at_ms) < expiry * 1000n,
        "dance_installed_prepare_grant_expired", 403);
      const job: PublicationCommandJob = {
        schema: "pirate.publication-queued/1", command, signature: sig, fee, bodyHash: digest(accepted),
        kind: "record_publication_grant", ref: row.command_id, data: preparedCall(command, sig).data,
      };
      return {
        member: { accountId: row.account_id, wallet, purpose: selection.purpose,
          grantId: command.digest, knownAliasAccountIds: [row.account_id] },
        job,
        receipt: { ...receipt, state: "recorded", transactionHash: receipt.transactionHash },
        fingerprint: canonical([publicationOriginalFingerprint(row), row.version, row.observed_json, row.head_stop_command]),
      };
    };
    const first = grant(learner), second = grant(reviewer);
    insist(first.member.wallet !== second.member.wallet && first.member.grantId !== second.member.grantId &&
      first.receipt.transactionHash !== second.receipt.transactionHash,
    "dance_installed_prepare_independent_grants_required", 403);
    await current();
    return [first, second];
  }

  const originals = await grants();
  await Promise.all(originals.map(grant => canonicalGrant(client, grant, current)));
  const participants = [originals[0].member, originals[1].member] as const;
  const intentSha256 = digest(intent);
  const idFor = (position: 0 | 1) => digest({
    schema: "pirate.installed-dance-bind-command/1", intentSha256, position,
    appCommandId: intent.grants[position].commandId, grantId: originals[position].member.grantId,
  });
  const prepared = await prepareDanceV2ParticipantBindings({
    client, profile, config, selected, caller: config.publisher,
    owner: { epoch: consentUint64(intent.ownerEpoch), wallet: intent.ownerWallet },
    clock, afterAwait: current, participants, commandIds: [idFor(0), idFor(1)],
    async verifyPrivateOriginals(pair) {
      const [learner, reviewer] = await grants();
      insist(canonical(pair) === canonical(participants) && learner.fingerprint === originals[0].fingerprint &&
        reviewer.fingerprint === originals[1].fingerprint, "dance_installed_prepare_grant_changed", 409);
      for (const { receipt } of [learner, reviewer]) {
        const block = await client.getBlock({ blockNumber: BigInt(receipt.observed.blockNumber), includeTransactions: false });
        insist(block.hash === receipt.observed.blockHash && block.timestamp === BigInt(receipt.observed.timestampS),
          "dance_installed_prepare_receipt_reorg", 503);
      }
      await current();
    },
  });
  const entry = (position: 0 | 1) => {
    const item = prepared[position];
    insist(item, "dance_installed_prepare_plan_missing", 503);
    return Object.freeze({
      purpose: intent.grants[position].purpose,
      appGrantCommandId: intent.grants[position].commandId,
      grantId: originals[position].member.grantId,
      grantReceiptSha256: digest(originals[position].receipt),
      plan: Object.freeze({ ...item.plan, ownerEpoch: String(item.plan.ownerEpoch),
        configurationRevision: String(item.plan.configurationRevision) }),
      command: Object.freeze({ ...item.command }),
    });
  };
  return Object.freeze({ schema: "pirate.installed-dance-bind-prepare/1" as const, intentSha256,
    plans: Object.freeze([entry(0), entry(1)] as const) });
}
