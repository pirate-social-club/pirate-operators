import type { Hex } from "viem";
import { bytes32, canonical, insist } from "../packages/community/common.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import { DANCE_DB_NOW, DanceStore } from "../packages/dance/store.ts";
import { digest } from "../packages/protocol/index.ts";
import { consentAddress, consentDigest } from "../packages/protocol/publication-consent.ts";
import type { DanceV2BindingOriginal, DanceV2PrivateParticipant } from "./dance-v2-participant-bindings.ts";
import { publicationActivationHead, PUBLICATION_PENDING_WITHDRAWAL } from "./publication-app-activation.ts";
import { publicationOriginal } from "./publication-app-request.ts";
import { publicationSelectionSource } from "./publication-app-selection.ts";
import { parsePublicationReceipt } from "./publication-app-transport.ts";
import type { PublicationApplicationPorts } from "./publication-app.ts";
import { capturedFee, parseCommand, signature, sourceId } from "./publication-command-contract.ts";
import { ownedCommand } from "./publication-command-store.ts";
import type { Web2PublicDanceInputs } from "./web2-public-dance-start.ts";
import { verifyObservedDanceGrant, type ObservedDanceGrant } from "./web2-dance-observed-grant.ts";

type Purpose = DanceV2PrivateParticipant["purpose"];
type Participant = Readonly<{ commandId: Hex; original: DanceV2BindingOriginal }>;
type Pair = readonly [Participant, Participant];
type GrantRef = Readonly<{ commandId: Hex; accountId: string; wallet?: DanceV2PrivateParticipant["wallet"] }>;
type GrantPair = readonly [GrantRef, GrantRef];
type SelectedParticipants = NonNullable<Web2PublicDanceInputs["participants"]>;
const purposes = ["dance-verdict", "dance-review-attribution"] as const;

const actor = `EXISTS(SELECT 1 FROM community_accounts a JOIN credential_bindings b
  ON b.account_id=a.account_id WHERE a.account_id=? AND a.author_id=? AND
  b.binding_id=? AND b.namespace='moss' AND b.network=6343 AND b.subject=? AND
  (SELECT COUNT(*) FROM credential_bindings x WHERE x.namespace='moss' AND x.network=6343
    AND (x.account_id=a.account_id OR LOWER(x.subject)=LOWER(b.subject)))=1)`;

async function openObservedDanceGrants(
  ports: PublicationApplicationPorts,
  input: GrantPair,
  assertCurrent: () => Promise<void>,
) {
  const { db, installation, catalog } = ports;
  const { config, source } = (() => {
    const release = catalog.fresh();
    return { config: release.configuration, source: publicationSelectionSource(release) };
  })();
  const selected = structuredClone(input);
  insist(installation?.db === db && installation.catalog === catalog &&
    installation.expected.installationId === config.installationId &&
    source.chainId === 6343 && catalog.active === source.releaseSelectionSha256 &&
    selected[0].commandId !== selected[1].commandId &&
    selected[0].accountId !== selected[1].accountId,
  "dance_installed_grant_scope_unavailable", 503);
  const installed = installation;
  const store = new DanceStore(db);
  async function current() {
    await assertCurrent();
    insist(ports.db === db && ports.catalog === catalog && ports.installation === installed &&
      catalog.active === source.releaseSelectionSha256,
    "dance_installed_grant_scope_changed", 503);
  }

  async function read(participant: GrantRef, purpose: Purpose) {
    await current();
    const { commandId, accountId } = participant, id = bytes32(commandId);
    const row = await ownedCommand(db, id, { communityId: source.communityId, accountId });
    const { capture } = publicationOriginal(row, catalog);
    const wallet = consentAddress(capture.learner);
    insist(row.action === "grant" && row.purpose === purpose && row.phase === "accepted" &&
      row.result_state === "recorded" && row.typed_json && row.signature && row.accepted_json &&
      row.observation_hash && row.created_at > 0 && row.nonce_hex &&
      row.source_id === sourceId(source) && capture.sourceCommandId === null &&
      capture.releaseSelectionSha256 === source.releaseSelectionSha256 &&
      capture.origin === config.app.origin &&
      (participant.wallet === undefined || consentAddress(participant.wallet) === wallet),
    "dance_installed_grant_not_recorded", 403);
    const signed = signature(row.signature);
    const command = parseCommand(JSON.parse(row.typed_json));
    const descriptor = catalog.fresh().policies[purpose];
    insist(descriptor && command.action === "grant" &&
      command.accountId === accountId && command.commandId === id && command.requestId === row.request_id &&
      command.message.learner === wallet && command.message.nonce === row.nonce_hex &&
      command.message.purpose === purpose && command.message.policyHash === descriptor.policyHash &&
      command.message.publicationTarget === descriptor.target &&
      command.message.publicationTargetRuntimeHash === descriptor.runtimeHash &&
      command.message.permissionRevision === descriptor.permissionRevision &&
      canonical(command.source) === canonical(source) && canonical(command) === row.typed_json &&
      command.digest === row.digest && String(row.fence_generation) === command.localFenceGeneration,
    "dance_installed_grant_original_changed", 403);
    const observation = await db.prepare(`SELECT value_json FROM publication_v1_observations
      WHERE command_id=? AND proof_hash=?`).bind(id, row.observation_hash).first<{ value_json: string }>();
    insist(observation, "dance_installed_grant_not_recorded", 403);
    const receipt = parsePublicationReceipt(JSON.parse(observation.value_json), command);
    insist(receipt.state === "recorded" && canonical(receipt) === observation.value_json &&
      digest(receipt) === row.observation_hash,
    "dance_installed_grant_original_changed", 403);
    await current();
    return {
      row,
      command,
      capture,
      observed: receipt.observed,
      evidence: { command, receipt, signature: signed, acceptedJson: row.accepted_json } satisfies ObservedDanceGrant,
      observationBytes: observation.value_json,
      member: { accountId, wallet, purpose, grantId: command.digest,
        knownAliasAccountIds: [accountId] } satisfies DanceV2PrivateParticipant,
    };
  }

  try {
    const members = await Promise.all([read(selected[0], purposes[0]), read(selected[1], purposes[1])]);
    const pair: SelectedParticipants["pair"] = [members[0].member, members[1].member];
    insist(pair[0].grantId !== pair[1].grantId && pair[0].wallet !== pair[1].wallet,
      "dance_installed_grant_scope_changed", 409);
    async function selectedFences(expected: typeof pair) {
      await current();
      insist(canonical(expected) === canonical(pair), "dance_installed_grant_scope_changed", 409);
      const fences = await Promise.all(members.map(async ({ row, command, capture, observed, observationBytes }) => {
        const head = await publicationActivationHead(db, row);
        const start = BigInt(command.message.validAfter), expiry = BigInt(command.message.expiresAt);
        const recorded = BigInt(observed.timestampS);
        const effective = recorded > start ? recorded : start;
        insist(head.generation === row.fence_generation && head.stopped === 0 &&
          head.pending === 0 && expiry > effective && expiry * 1000n <= BigInt(Number.MAX_SAFE_INTEGER),
        "dance_installed_grant_not_active", 403);
        return {
          sql: `${actor} AND EXISTS(SELECT 1 FROM publication_v1_commands c
            JOIN publication_v1_heads h
              ON h.community_id=c.community_id AND h.account_id=c.account_id
              AND h.source_id=c.source_id AND h.purpose=c.purpose
            JOIN publication_v1_observations o
              ON o.command_id=c.command_id AND o.proof_hash=c.observation_hash
            WHERE c.command_id=? AND c.community_id=? AND c.account_id=? AND c.source_id=?
            AND c.purpose=? AND c.action='grant' AND c.phase='accepted' AND c.result_state='recorded'
            AND c.version=? AND c.request_hash=? AND c.request_json=? AND c.nonce_hex=?
            AND c.typed_json=? AND c.digest=? AND c.signature=? AND c.accepted_json=?
            AND c.observation_hash=? AND o.value_json=? AND c.fence_generation=h.generation
            AND h.generation=? AND h.stopped=0 AND h.stop_command_id IS ?
            AND NOT (${PUBLICATION_PENDING_WITHDRAWAL}))
            AND ${DANCE_DB_NOW}>=? AND ${DANCE_DB_NOW}<?`,
          values: [row.account_id, capture.authorId, capture.bindingId, capture.learner,
            row.command_id, row.community_id, row.account_id, row.source_id, row.purpose,
            row.version, row.request_hash, row.request_json, row.nonce_hex, row.typed_json,
            row.digest, row.signature, row.accepted_json, row.observation_hash, observationBytes,
            head.generation, head.stop_command_id, Number(effective * 1000n), Number(expiry * 1000n)],
        } satisfies DanceFence;
      }));
      await current();
      return [installed.fence("active", source.releaseSelectionSha256), ...fences];
    }
    return Object.freeze({
      pair: structuredClone(pair),
      async privateOriginalFences(expected: typeof pair) {
        const fences = await selectedFences(expected);
        await store.assert(fences);
        await current();
        return fences;
      },
      evidence: structuredClone([members[0].evidence, members[1].evidence] as const),
      async assertObserved() {
        const fences = await selectedFences(pair);
        const condition = fences.map(fence => "(" + fence.sql + ")").join(" AND ");
        const result = await db.withSession("first-primary").prepare("SELECT 1 AS live WHERE " + condition)
          .bind(...fences.flatMap(fence => fence.values)).first<{ live: number }>();
        insist(result?.live === 1, "dance_installed_grant_scope_unavailable", 503);
        await current();
      },
    });
  } catch {
    insist(false, "dance_installed_grant_scope_unavailable", 503);
  }
}

function originalGrantRefs(input: Pair): GrantPair {
  const [learner, reviewer] = input;
  insist(learner.original.hash !== reviewer.original.hash, "dance_installed_grant_scope_unavailable", 503);
  return [
    { commandId: learner.commandId, accountId: learner.original.plan.accountId, wallet: learner.original.plan.wallet },
    { commandId: reviewer.commandId, accountId: reviewer.original.plan.accountId, wallet: reviewer.original.plan.wallet },
  ];
}

/** The ordinary capture path still pins both exact signed binding originals
 * and uses its original same-statement application guards. */
export async function installedDanceParticipants(
  ports: PublicationApplicationPorts, input: Pair, assertCurrent: () => Promise<void>,
): Promise<SelectedParticipants> {
  const selected = structuredClone(input);
  const grants = await openObservedDanceGrants(ports, originalGrantRefs(selected), assertCurrent);
  return Object.freeze({
    pair: grants.pair,
    originals: [selected[0].original, selected[1].original] as const,
    privateOriginalFences: grants.privateOriginalFences,
  });
}

/** Before BindIdentity exists, derive each wallet from the retained app
 * credential and prove the existing chain receipt without performing a write. */
export async function readPreparedDanceGrants(
  ports: PublicationApplicationPorts,
  input: readonly [Omit<GrantRef, "wallet">, Omit<GrantRef, "wallet">],
  assertCurrent: () => Promise<void>,
) {
  const selected: GrantPair = [
    { commandId: input[0].commandId, accountId: input[0].accountId },
    { commandId: input[1].commandId, accountId: input[1].accountId },
  ];
  return readObservedGrants(ports, selected, assertCurrent);
}

async function readObservedGrants(ports: PublicationApplicationPorts, input: GrantPair, assertCurrent: () => Promise<void>) {
  const grants = await openObservedDanceGrants(ports, input, assertCurrent);
  await grants.assertObserved();
  for (const proof of grants.evidence) {
    insist(canonical(capturedFee(JSON.parse(proof.acceptedJson).fee)) === canonical(ports.catalog.fresh().fee),
      "dance_activation_grant_fee_changed", 503);
    await verifyObservedDanceGrant(ports.client, proof);
  }
  await grants.assertObserved();
  return Object.freeze({ pair: grants.pair, evidence: grants.evidence, assertObserved: grants.assertObserved });
}

export async function readObservedInstalledDanceGrants(
  publication: PublicationApplicationPorts,
  grants: Pair,
  assertCurrent: () => Promise<void>,
) {
  const proof = await readObservedGrants(publication, originalGrantRefs(grants), assertCurrent);
  return { pair: proof.pair, evidence: proof.evidence };
}
