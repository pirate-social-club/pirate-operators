import type { Address, PublicClient } from "viem";
import { insist } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import { danceControlReadPort } from "../packages/dance-chain/control-reader.ts";
import { canonicalDanceControlBinding } from "../packages/dance-chain/control-command.ts";
import { DanceControlStore } from "../packages/dance/control-store.ts";
import { DanceStore } from "../packages/dance/store.ts";
import type { DanceFence, DancePorts, DancePrincipal } from "../packages/dance/contracts.ts";
import { principal, validateFence, wallet } from "../packages/dance/validation.ts";
import { CanonicalDanceControls } from "./dance-control-reconciliation.ts";

/** Host account resolver must read real private accounts, recorded V4 IDs,
 * known aliases and owner assignment; its D1 fence covers those exact rows.
 * This module adds the admitted canonical role/control observation rather than
 * promoting a local delegation or a present-day boolean to chain authority. */
export interface DanceAccountAuthorityFacts {
  actor: DancePrincipal;
  learner: DancePrincipal;
  owner: { accountId: string; wallet: string; assignmentId: string };
  mediaEpoch: number;
  fence: DanceFence;
}
export function createProductionDanceAuthority(input: {
  db: D1Database; client: PublicClient; source: DanceCanonicalSource; config: CommunityConfig;
  accounts(communityId: string, actorId: string, learnerId: string): Promise<DanceAccountAuthorityFacts>;
}): Pick<DancePorts, "authority" | "controlBinding"> {
  const store = new DanceStore(input.db);
  const controls = new CanonicalDanceControls(new DanceControlStore(store), danceControlReadPort(input.client), input.source);
  return {
    controlBinding: async (intent, caller) => canonicalDanceControlBinding(input.source, intent, caller),
    async authority(community, actorId, learnerId) {
      insist(community === input.source.domain.communityId, "dance_wrong_community", 403);
      const local = structuredClone(await input.accounts(community, actorId, learnerId));
      principal(local.actor); principal(local.learner, false); validateFence(local.fence);
      insist(local.actor.accountId === actorId && local.learner.accountId === learnerId &&
        !!local.owner.accountId && !!local.owner.assignmentId &&
        Number.isSafeInteger(local.mediaEpoch) && local.mediaEpoch >= 0,
        "dance_account_changed", 403);
      const { role, stamp } = await controls.refreshReviewer({
        client: input.client, config: input.config,
        actor: { accountId: actorId, wallet: wallet(local.actor.wallet) as Address },
        learner: { accountId: learnerId, wallet: wallet(local.learner.wallet) as Address },
      });
      for (const [a, b] of [[local.actor, role.actor], [local.learner, role.learner]] as const)
        insist(wallet(a.wallet) === b.wallet && a.accountCommitment === b.accountCommitment &&
          a.identityEpoch === b.identityEpoch && a.groupId === b.groupId && a.groupEpoch === b.groupEpoch,
          "dance_canonical_identity_changed", 403);
      insist(wallet(local.owner.wallet) === role.owner.wallet, "dance_canonical_owner_changed", 409);
      const ownerBranch = local.actor.accountId === local.owner.accountId && wallet(local.actor.wallet) === role.owner.wallet;
      // Only an exact retained grant accepted at this role epoch can name the
      // delegation. Missing historical mapping holds access; no old grant replay.
      const grant = role.reviewer && !ownerBranch ? await input.db.prepare(`SELECT i.delegation_id,i.command_id,p.revision,b.binding_hash FROM dance_control_intents i
        JOIN dance_control_projection p ON p.command_id=i.command_id
        JOIN dance_control_bindings b ON b.command_id=i.command_id AND b.binding_hash=p.binding_hash
        WHERE i.community_id=? AND i.account_id=? AND lower(i.wallet)=? AND i.operation='grant'
          AND i.local_integrity_hash=b.intent_hash AND b.source_hash=? AND p.source_hash=b.source_hash
          AND p.state='canonical' AND p.guarded=1 AND p.result_epoch=?
          AND json_extract(i.body_json,'$.ownerEpoch')=?
          AND json_extract(i.body_json,'$.ownerAssignment')=? LIMIT 2`)
        .bind(community, actorId, wallet(local.actor.wallet), input.source.sourceHash,
          role.reviewer.roleEpoch, role.owner.epoch, local.owner.assignmentId)
        .all<{ delegation_id: string; command_id: string; revision: number; binding_hash: string }>() : null;
      insist(!grant || grant.results.length <= 1, "dance_delegation_mapping_ambiguous", 503);
      const projected: DanceFence = {
        sql: `EXISTS(SELECT 1 FROM dance_reviewer_projection WHERE community_id=? AND source_hash=?
          AND wallet=? AND revision=? AND anchor_number=? AND anchor_hash=? AND state IN ('active','inactive'))`,
        values: [community, stamp.sourceHash, stamp.wallet, stamp.revision, stamp.blockNumber, stamp.blockHash],
      };
      const accepted = grant?.results[0];
      const grantFence: DanceFence = accepted ? {
        sql: "EXISTS(SELECT 1 FROM dance_control_projection WHERE command_id=? AND revision=? AND binding_hash=? AND state='canonical' AND guarded=1 AND result_epoch=?)",
        values: [accepted.command_id, accepted.revision, accepted.binding_hash, role.reviewer!.roleEpoch],
      } : { sql: "1", values: [] };
      const fence = { sql: `(${local.fence.sql}) AND (${projected.sql}) AND (${grantFence.sql})`,
        values: [...local.fence.values, ...projected.values, ...grantFence.values] };
      await store.assert([fence]);
      return { actor: local.actor, learner: local.learner, canonicalRoleProjection: stamp,
        owner: { ...local.owner, epoch: role.owner.epoch, expiresAtMs: role.owner.expiresAtMs, canonicalAccepted: true },
        reviewer: role.reviewer && grant?.results[0] ? { ...role.reviewer,
          delegationId: grant.results[0].delegation_id, canonicalAccepted: true } : null,
        epochs: { configurationRevision: role.owner.configurationRevision, rulesEpoch: role.rulesEpoch, mediaEpoch: local.mediaEpoch },
        fence };
    },
  };
}
