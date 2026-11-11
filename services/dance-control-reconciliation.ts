import { encodeEventTopics, type Hex, type PublicClient } from "viem";
import { insist } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import type {
  DanceCanonicalSource,
  DanceBlock,
} from "../packages/dance-chain/reader.ts";
import { danceVerdictsAbi } from "../packages/dance-chain/abi.ts";
import { controlJson } from "../packages/dance-chain/control-command.ts";
import {
  demoteDanceControl,
  safeControlNumber,
  verifyCanonicalDanceControl,
  type DanceControlReadPort,
} from "../packages/dance-chain/control-reader.ts";
import { DanceControlStore } from "../packages/dance/control-store.ts";
import type { DanceControlEvidence } from "../packages/dance/control-contracts.ts";
import {
  observeCanonicalDanceRole,
  type DanceRoleIdentity,
} from "./dance-canonical-roles.ts";

const [topic] = encodeEventTopics({
  abi: danceVerdictsAbi,
  eventName: "CommandApplied",
});
/** Read/reconcile only. Never constructs a replacement command, sends a
 * transaction, selects a source or re-enters dispatch admission for receipt reads. */
export class CanonicalDanceControls {
  readonly journal: DanceControlStore;
  readonly rpc: DanceControlReadPort;
  readonly source: DanceCanonicalSource;
  constructor(
    journal: DanceControlStore,
    rpc: DanceControlReadPort,
    source: DanceCanonicalSource,
  ) {
    this.journal = journal;
    this.rpc = rpc;
    this.source = source;
  }
  async reconcile(commandId: string, anchor?: DanceBlock) {
    const { intent, binding } = await this.journal.binding(commandId);
    insist(
      binding.sourceJson === controlJson(this.source),
      "dance_control_source_changed",
      503,
    );
    const prior = await this.journal.prior(commandId);
    const base: DanceControlEvidence = prior ?? {
      version: "pirate.dance-control-evidence/1",
      commandId,
      bindingHash: binding.bindingHash,
      sourceHash: binding.sourceHash,
      wallet: binding.wallet,
      state: "uncertain",
      resultEpoch: null,
      blockNumber: null,
      blockHash: null,
      transactionHash: null,
      transactionIndex: null,
      logIndex: null,
      anchorNumber: null,
      anchorHash: null,
      rawLogJson: null,
      reason: null,
    };
    try {
      const safe = anchor ?? (await this.rpc.safe());
      const attempts = await this.journal.attempts(commandId);
      let found: DanceControlEvidence | null = null;
      const seen = new Set<string>();
      for (const a of attempts) {
        if (seen.has(a.transactionHash.toLowerCase())) continue;
        seen.add(a.transactionHash.toLowerCase());
        const receipt = await this.rpc.receipt(a.transactionHash as Hex);
        insist(
          !receipt ||
            receipt.transactionHash.toLowerCase() ===
              a.transactionHash.toLowerCase(),
          "dance_control_receipt_not_owned",
          503,
        );
        if (
          !receipt ||
          receipt.status !== "success" ||
          receipt.blockNumber > safe.number
        )
          continue;
        for (const log of receipt.logs) {
          if (
            log.address.toLowerCase() !==
              this.source.domain.verifier.toLowerCase() ||
            log.topics[0]?.toLowerCase() !== topic?.toLowerCase() ||
            log.topics[2]?.toLowerCase() !== binding.wireId.toLowerCase()
          )
            continue;
          insist(!found, "dance_duplicate_control_log", 503);
          found = await verifyCanonicalDanceControl(
            this.rpc,
            intent,
            binding,
            a,
            log,
            safe,
          );
        }
      }
      const evidence =
        found ??
        (await demoteDanceControl(this.rpc, intent, binding, base, safe));
      await this.journal.record(evidence);
      return evidence;
    } catch (error) {
      // Failure only tightens local access. Earlier raw accepted evidence stays
      // immutable; neither a timeout nor a missing receipt clears a revoke.
      await this.journal.record({
        ...base,
        state: "uncertain",
        reason: "control_verification_unavailable",
      });
      throw error;
    }
  }
  /** Composite prospective authorization: reviewed role reader + exact controls
   * verified at THE SAME anchor + monotonically fenced durable role projection. */
  async refreshReviewer(input: {
    client: PublicClient;
    config: CommunityConfig;
    actor: DanceRoleIdentity;
    learner: DanceRoleIdentity;
  }) {
    const wallet = input.actor.wallet.toLowerCase();
    const community = this.source.domain.communityId;
    const old = await this.journal.role(
      community,
      this.source.sourceHash,
      wallet,
    );
    try {
      const role = await observeCanonicalDanceRole({
        ...input,
        source: this.source,
      });
      const anchor = await this.rpc.block(role.anchor.number);
      insist(
        anchor.hash === role.anchor.hash,
        "dance_control_anchor_changed",
        503,
      );
      if (old) {
        const prior = await this.rpc.block(BigInt(old.anchor_number));
        if (prior.hash !== old.anchor_hash) {
          await this.journal.holdRole(
            community,
            this.source.sourceHash,
            wallet,
            "prior_role_anchor_replaced",
          );
          // Conservative counter watermark remains. No unreviewed counter reset.
          insist(false, "dance_role_projection_reorg_hold", 409);
        }
      }
      const controls = await this.journal.store
        .stmt(
          `SELECT command_id FROM dance_control_intents WHERE community_id=?
        AND (account_id=? OR lower(wallet)=? OR typeof(wallet)<>'text' OR typeof(account_id)<>'text')
        AND (operation='revoke' OR operation NOT IN ('grant','revoke')) LIMIT 257`,
          community,
          input.actor.accountId,
          wallet,
        )
        .all<{ command_id: string }>();
      insist(
        controls.results.length <= 256,
        "dance_control_history_limit",
        503,
      );
      for (const row of controls.results) {
        try {
          await this.reconcile(row.command_id, anchor);
        } catch {
          /* Every unresolved/malformed matching row remains a SQL veto. */
        }
      }
      const again = await this.rpc.block(anchor.number);
      insist(
        again.hash === anchor.hash && again.timestamp === anchor.timestamp,
        "dance_control_anchor_changed",
        503,
      );
      const stamp = await this.journal.projectRole(
        {
          communityId: community,
          sourceHash: this.source.sourceHash,
          wallet,
          anchorNumber: safeControlNumber(anchor.number),
          anchorHash: anchor.hash,
          ownerEpoch: role.owner.epoch,
          configurationRevision: role.owner.configurationRevision,
          ownerValidFromMs: role.owner.validFromMs,
          ownerExpiresAtMs: role.owner.expiresAtMs,
          roleEpoch: role.reviewer?.roleEpoch ?? null,
          roleExpiresAtMs: role.reviewer?.expiresAtMs ?? null,
          state: role.reviewer ? "active" : "inactive",
          observationJson: controlJson({ source: this.source, role }),
        },
        old?.revision ?? 0,
      );
      return { role, stamp };
    } catch (error) {
      await this.journal.holdRole(
        community,
        this.source.sourceHash,
        wallet,
        "role_verification_unavailable",
      );
      throw error;
    }
  }
}
