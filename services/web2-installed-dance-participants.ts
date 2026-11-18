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
import { parseCommand, signature, sourceId } from "./publication-command-contract.ts";
import { ownedCommand } from "./publication-command-store.ts";
import type { Web2PublicDanceInputs } from "./web2-public-dance-start.ts";

type Purpose = DanceV2PrivateParticipant["purpose"];
type Participant = Readonly<{ commandId: Hex; original: DanceV2BindingOriginal }>;
type Pair = readonly [Participant, Participant];
type SelectedParticipants = NonNullable<Web2PublicDanceInputs["participants"]>;
const purposes = ["dance-verdict", "dance-review-attribution"] as const;

const actor = `EXISTS(SELECT 1 FROM community_accounts a JOIN credential_bindings b
  ON b.account_id=a.account_id WHERE a.account_id=? AND a.author_id=? AND
  b.binding_id=? AND b.namespace='moss' AND b.network=6343 AND b.subject=? AND
  (SELECT COUNT(*) FROM credential_bindings x WHERE x.namespace='moss' AND x.network=6343
    AND (x.account_id=a.account_id OR LOWER(x.subject)=LOWER(b.subject)))=1)`;

/** Bind two specific native identity originals to two specific ordinary V5
 * application grant commands. The native owner selects the command IDs. No
 * in-request account, grant digest, lookup key or session supplies the pair. */
export async function installedDanceParticipants(
  ports: PublicationApplicationPorts,
  input: Pair,
  assertCurrent: () => Promise<void>,
): Promise<SelectedParticipants> {
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
    selected[0].original.plan.accountId !== selected[1].original.plan.accountId &&
    selected[0].original.plan.wallet !== selected[1].original.plan.wallet &&
    selected[0].original.hash !== selected[1].original.hash,
  "dance_installed_grant_scope_unavailable", 503);
  const installed = installation;
  const store = new DanceStore(db);
  async function current() {
    await assertCurrent();
    insist(ports.db === db && ports.catalog === catalog && ports.installation === installed &&
      catalog.active === source.releaseSelectionSha256,
    "dance_installed_grant_scope_changed", 503);
  }

  async function read(participant: Participant, purpose: Purpose) {
    await current();
    const { commandId, original } = participant;
    const { accountId, wallet } = original.plan, id = bytes32(commandId);
    const row = await ownedCommand(db, id, { communityId: source.communityId, accountId });
    const { capture } = publicationOriginal(row, catalog);
    insist(row.action === "grant" && row.purpose === purpose && row.phase === "accepted" &&
      row.result_state === "recorded" && row.typed_json && row.signature && row.accepted_json &&
      row.observation_hash && row.created_at > 0 && row.nonce_hex &&
      row.source_id === sourceId(source) && capture.sourceCommandId === null &&
      capture.releaseSelectionSha256 === source.releaseSelectionSha256 &&
      capture.origin === config.app.origin && capture.learner === consentAddress(wallet),
    "dance_installed_grant_not_recorded", 403);
    signature(row.signature);
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
      observationBytes: observation.value_json,
      member: { accountId, wallet, purpose, grantId: command.digest,
        knownAliasAccountIds: [accountId] } satisfies DanceV2PrivateParticipant,
    };
  }

  try {
    const members = await Promise.all([read(selected[0], purposes[0]), read(selected[1], purposes[1])]);
    const pair: SelectedParticipants["pair"] = [members[0].member, members[1].member];
    insist(pair[0].grantId !== pair[1].grantId,
      "dance_installed_grant_scope_changed", 409);
    return Object.freeze({
      pair: structuredClone(pair),
      originals: [selected[0].original, selected[1].original] as const,
      async privateOriginalFences(expected: typeof pair) {
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
        const selectedFences = [installed.fence("active", source.releaseSelectionSha256), ...fences];
        await store.assert(selectedFences);
        await current();
        return selectedFences;
      },
    });
  } catch {
    insist(false, "dance_installed_grant_scope_unavailable", 503);
  }
}
