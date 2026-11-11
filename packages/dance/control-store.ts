import { bytes32, canonical, insist, token } from "../community/common.ts";
import type { DanceStore } from "./store.ts";
import { DANCE_DB_NOW } from "./store.ts";
import type {
  DanceControlBinding,
  DanceControlEvidence,
  DanceRoleProjection,
  DanceRoleStamp,
  RetainedControlAttempt,
} from "./control-contracts.ts";
import {
  verifyControlBinding,
  controlEpoch,
} from "../dance-chain/control-command.ts";

interface StoredRole {
  revision: number;
  anchor_number: number;
  anchor_hash: string;
  highest_role_epoch: number;
  observation_json: string;
}
/** Internal verified-reader persistence. No HTTP body/proof-marker adapter. */
export class DanceControlStore {
  readonly store: DanceStore;
  constructor(store: DanceStore) {
    this.store = store;
  }
  async binding(commandId: string) {
    const i = await this.store.controlIntent(commandId);
    const row = await this.store
      .stmt(
        "SELECT binding_json FROM dance_control_bindings WHERE command_id=?",
        commandId,
      )
      .first<{ binding_json: string }>();
    insist(i && row, "dance_control_original_binding_missing", 503);
    const b = JSON.parse(row.binding_json) as DanceControlBinding;
    verifyControlBinding(i, b);
    const box = await this.store.outbox(commandId);
    insist(
      box.kind === i.operation &&
        box.subjectId === i.delegationId &&
        box.communityId === i.communityId &&
        box.localIntegrityHash === i.localIntegrityHash &&
        canonical(JSON.parse(box.payloadJson)) === canonical(i),
      "dance_control_outbox_changed",
      503,
    );
    return { intent: i, binding: b };
  }
  async attempts(commandId: string): Promise<RetainedControlAttempt[]> {
    const rows = await this.store
      .stmt(
        `SELECT a.attempt_id attemptId,a.command_id commandId,a.nonce,a.raw_transaction rawTransaction,
      a.transaction_hash transactionHash,d.binding_hash guardedBindingHash FROM dance_transaction_attempts a
      LEFT JOIN dance_attempt_admissions d ON d.attempt_id=a.attempt_id AND d.command_id=a.command_id
      WHERE a.command_id=? UNION ALL SELECT attempt_id,command_id,nonce,raw_transaction,transaction_hash,NULL
      FROM dance_recovered_attempts WHERE command_id=? LIMIT 65`,
        commandId,
        commandId,
      )
      .all<RetainedControlAttempt>();
    insist(rows.results.length <= 64, "dance_control_attempt_limit", 503);
    return rows.results;
  }
  async prior(commandId: string) {
    const r = await this.store
      .stmt(
        "SELECT evidence_json FROM dance_control_observations WHERE command_id=? ORDER BY rowid DESC LIMIT 1",
        commandId,
      )
      .first<{ evidence_json: string }>();
    return r ? (JSON.parse(r.evidence_json) as DanceControlEvidence) : null;
  }
  /** Caller MUST have run the raw canonical verifier, or supply a denial-only
   * demotion. Immutable ledger retains all earlier accepted/raw evidence. */
  async record(e: DanceControlEvidence) {
    const { binding: b } = await this.binding(e.commandId);
    insist(
      e.bindingHash === b.bindingHash &&
        e.sourceHash === b.sourceHash &&
        e.wallet === b.wallet,
      "dance_control_binding_changed",
      503,
    );
    if (e.state === "canonical") {
      insist(
        controlEpoch(e.resultEpoch, true) === b.expectedEpoch + 1 &&
          e.blockNumber !== null &&
          e.anchorNumber !== null &&
          e.anchorNumber >= e.blockNumber &&
          e.blockHash &&
          e.transactionHash &&
          e.rawLogJson,
        "dance_control_evidence_invalid",
        503,
      );
    }
    const old = await this.store
      .stmt(
        "SELECT revision,anchor_number,anchor_hash FROM dance_control_projection WHERE command_id=?",
        e.commandId,
      )
      .first<{
        revision: number;
        anchor_number: number | null;
        anchor_hash: string | null;
      }>();
    const admission = e.transactionHash
      ? await this.store
          .stmt(
            `SELECT 1 n FROM dance_transaction_attempts a
      JOIN dance_attempt_admissions d ON d.attempt_id=a.attempt_id AND d.command_id=a.command_id WHERE a.command_id=? AND lower(a.transaction_hash)=lower(?)
      AND d.binding_hash=? AND d.kind='guarded_before_broadcast'`,
            e.commandId,
            e.transactionHash,
            b.bindingHash,
          )
          .first()
      : null;
    const revision = old?.revision ?? 0;
    const anchor = e.anchorNumber ?? old?.anchor_number ?? null;
    const hash = e.anchorHash ?? old?.anchor_hash ?? null;
    if (
      e.state === "canonical" &&
      old?.anchor_number !== null &&
      old?.anchor_number !== undefined
    )
      insist(
        anchor !== null &&
          anchor >= old.anchor_number &&
          (anchor !== old.anchor_number || hash === old.anchor_hash),
        "dance_control_projection_regressed",
        409,
      );
    await this.store.atomic(
      [
        {
          sql: "EXISTS(SELECT 1 FROM dance_control_bindings WHERE command_id=? AND binding_hash=?)",
          values: [e.commandId, b.bindingHash],
        },
      ],
      [
        this.store.stmt(
          "INSERT INTO dance_control_observations VALUES(?,?,?,?,?," +
            DANCE_DB_NOW +
            ")",
          token(),
          e.commandId,
          b.bindingHash,
          e.state,
          JSON.stringify(e),
        ),
        this.store.stmt(
          `INSERT INTO dance_control_projection VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET
        state=excluded.state,result_epoch=excluded.result_epoch,anchor_number=excluded.anchor_number,anchor_hash=excluded.anchor_hash,
        guarded=excluded.guarded,revision=excluded.revision WHERE dance_control_projection.revision=?`,
          e.commandId,
          b.bindingHash,
          b.sourceHash,
          b.wallet,
          e.state,
          e.resultEpoch,
          anchor,
          hash,
          e.state === "canonical" && admission ? 1 : 0,
          revision + 1,
          revision,
        ),
        this.store.changed(),
      ],
    );
  }
  async role(community: string, source: string, wallet: string) {
    return this.store
      .stmt(
        "SELECT * FROM dance_reviewer_projection WHERE community_id=? AND source_hash=? AND wallet=?",
        community,
        source,
        wallet.toLowerCase(),
      )
      .first<StoredRole>();
  }
  async projectRole(
    p: DanceRoleProjection,
    expectedRevision: number,
  ): Promise<DanceRoleStamp> {
    bytes32(p.sourceHash);
    bytes32(p.anchorHash);
    controlEpoch(p.anchorNumber);
    controlEpoch(p.ownerEpoch, true);
    controlEpoch(p.configurationRevision, true);
    insist(
      /^0x[\da-f]{40}$/.test(p.wallet),
      "dance_role_projection_invalid",
      503,
    );
    for (const n of [p.ownerValidFromMs, p.ownerExpiresAtMs])
      controlEpoch(n, true);
    if (p.state === "active") {
      controlEpoch(p.roleEpoch, true);
      controlEpoch(p.roleExpiresAtMs, true);
    } else
      insist(
        p.state === "inactive" &&
          p.roleEpoch === null &&
          p.roleExpiresAtMs === null,
        "dance_role_projection_invalid",
        503,
      );
    const old = await this.role(p.communityId, p.sourceHash, p.wallet);
    insist(
      (old?.revision ?? 0) === expectedRevision &&
        (!old || p.anchorNumber >= old.anchor_number),
      "dance_role_projection_regressed",
      409,
    );
    if (old && p.anchorNumber === old.anchor_number)
      insist(
        p.anchorHash === old.anchor_hash &&
          p.observationJson === old.observation_json,
        "dance_role_projection_regressed",
        409,
      );
    insist(
      !old || p.roleEpoch === null || p.roleEpoch >= old.highest_role_epoch,
      "dance_role_projection_regressed",
      409,
    );
    const high = Math.max(old?.highest_role_epoch ?? 0, p.roleEpoch ?? 0);
    await this.store.atomic(
      [{ sql: "1", values: [] }],
      [
        this.store.stmt(
          "INSERT INTO dance_reviewer_observations VALUES(?,?,?,?,?," +
            DANCE_DB_NOW +
            ")",
          token(),
          p.communityId,
          p.sourceHash,
          p.wallet,
          p.observationJson,
        ),
        this.store.stmt(
          `INSERT INTO dance_reviewer_projection VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(community_id,source_hash,wallet) DO UPDATE SET revision=excluded.revision,anchor_number=excluded.anchor_number,
        anchor_hash=excluded.anchor_hash,role_epoch=excluded.role_epoch,highest_role_epoch=excluded.highest_role_epoch,
        owner_epoch=excluded.owner_epoch,configuration_revision=excluded.configuration_revision,owner_valid_from_ms=excluded.owner_valid_from_ms,
        owner_expires_at_ms=excluded.owner_expires_at_ms,role_expires_at_ms=excluded.role_expires_at_ms,state=excluded.state,
        observation_json=excluded.observation_json WHERE dance_reviewer_projection.revision=?`,
          p.communityId,
          p.sourceHash,
          p.wallet,
          expectedRevision + 1,
          p.anchorNumber,
          p.anchorHash,
          p.roleEpoch,
          high,
          p.ownerEpoch,
          p.configurationRevision,
          p.ownerValidFromMs,
          p.ownerExpiresAtMs,
          p.roleExpiresAtMs,
          p.state,
          p.observationJson,
          expectedRevision,
        ),
        this.store.changed(),
      ],
    );
    return {
      sourceHash: p.sourceHash,
      wallet: p.wallet,
      revision: expectedRevision + 1,
      blockNumber: p.anchorNumber,
      blockHash: p.anchorHash,
    };
  }
  /** Denial-only demotion; no counter rewind or stale grant resurrection. */
  async holdRole(
    community: string,
    source: string,
    wallet: string,
    reason: string,
  ) {
    await this.store.atomic(
      [{ sql: "1", values: [] }],
      [
        this.store.stmt(
          "INSERT INTO dance_reviewer_observations VALUES(?,?,?,?,?," +
            DANCE_DB_NOW +
            ")",
          token(),
          community,
          source,
          wallet.toLowerCase(),
          JSON.stringify({ state: "uncertain", reason }),
        ),
        this.store.stmt(
          "UPDATE dance_reviewer_projection SET state='uncertain',revision=revision+1 WHERE community_id=? AND source_hash=? AND wallet=?",
          community,
          source,
          wallet.toLowerCase(),
        ),
      ],
    );
  }
}
