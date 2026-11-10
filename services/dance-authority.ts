import { insist } from "../packages/community/common.ts";
import type {
  DanceAuthority,
  DanceFence,
  DancePorts,
  DanceReview,
} from "../packages/dance/contracts.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import {
  danceId,
  danceTime,
  validateAuthority,
} from "../packages/dance/validation.ts";

/** This service owns scoped delegation, not the community owner registry. */
export class DancePermissions {
  readonly store: DanceStore;
  readonly ports: DancePorts;
  readonly communityId: string;
  constructor(store: DanceStore, ports: DancePorts, communityId: string) {
    this.store = store;
    this.ports = ports;
    this.communityId = communityId;
  }
  async facts(actor: string, learner: string) {
    const f = await this.ports.authority(this.communityId, actor, learner);
    validateAuthority(f, actor, learner);
    return f;
  }
  async reviewer(
    f: DanceAuthority,
    excludeSelf = true,
  ): Promise<{ authority: string; fence: DanceFence }> {
    if (excludeSelf)
      insist(
        f.actor.accountId !== f.learner.accountId &&
          f.actor.identityId !== f.learner.identityId,
        "dance_self_review",
        403,
      );
    if (
      f.actor.accountId === f.owner.accountId &&
      f.actor.identityId === f.owner.identityId
    )
      return { authority: `owner:${f.owner.assignmentId}`, fence: f.fence };
    const now = await this.store.now();
    const row = await this.store
      .stmt(
        `SELECT delegation_id FROM dance_delegations
      WHERE community_id=? AND account_id=? AND identity_id=? AND owner_assignment=?
      AND revoked_at_ms IS NULL AND expires_at_ms>? ORDER BY delegation_id LIMIT 1`,
        this.communityId,
        f.actor.accountId,
        f.actor.identityId,
        f.owner.assignmentId,
        now,
      )
      .first<{ delegation_id: string }>();
    insist(row, "dance_review_forbidden", 403);
    return {
      authority: `delegation:${row.delegation_id}`,
      fence: {
        sql: `EXISTS(SELECT 1 FROM dance_delegations WHERE delegation_id=? AND community_id=?
        AND account_id=? AND identity_id=? AND owner_assignment=? AND revoked_at_ms IS NULL
        AND expires_at_ms>${DANCE_DB_NOW})`,
        values: [
          row.delegation_id,
          this.communityId,
          f.actor.accountId,
          f.actor.identityId,
          f.owner.assignmentId,
        ],
      },
    };
  }
  async read(actor: string, r: DanceReview) {
    insist(r.capture.communityId === this.communityId, "dance_not_found", 404);
    const f = await this.facts(actor, r.capture.accountId);
    insist(
      f.learner.identityId === r.capture.identityId,
      "dance_identity_changed",
      403,
    );
    if (actor === r.capture.accountId) return { facts: f, fences: [f.fence] };
    const reviewer = await this.reviewer(f);
    return { facts: f, fences: [f.fence, reviewer.fence] };
  }
  async delegate(
    actor: string,
    commandId: string,
    input: {
      delegationId: string;
      accountId: string;
      expiresAtMs: number;
      operation: "grant" | "revoke";
    },
  ) {
    [actor, commandId, input.delegationId, input.accountId].forEach(danceId);
    insist(
      input.operation === "grant" || input.operation === "revoke",
      "dance_invalid_operation",
    );
    danceTime(input.expiresAtMs);
    const f = await this.facts(actor, input.accountId);
    insist(
      f.actor.accountId === f.owner.accountId &&
        f.actor.identityId === f.owner.identityId,
      "dance_owner_required",
      403,
    );
    insist(
      f.actor.identityId !== f.learner.identityId,
      "dance_self_delegation",
      403,
    );
    const hash = DanceStore.request("delegation", input);
    const prior = await this.store
      .stmt(
        `SELECT request_hash FROM dance_delegation_audit
      WHERE community_id=? AND actor_id=? AND command_id=?`,
        this.communityId,
        actor,
        commandId,
      )
      .first<{ request_hash: string }>();
    if (prior) {
      insist(prior.request_hash === hash, "dance_idempotency_conflict", 409);
      await this.store.atomic([f.fence], []);
      return { delegationId: input.delegationId, operation: input.operation };
    }
    const statement =
      input.operation === "grant"
        ? this.store.stmt(
            `INSERT INTO dance_delegations
          SELECT ?,?,?,?,?,?,NULL WHERE ?>${DANCE_DB_NOW}`,
            input.delegationId,
            this.communityId,
            f.owner.assignmentId,
            input.accountId,
            f.learner.identityId,
            input.expiresAtMs,
            input.expiresAtMs,
          )
        : this.store.stmt(
            `UPDATE dance_delegations SET revoked_at_ms=${DANCE_DB_NOW}
          WHERE delegation_id=? AND community_id=? AND account_id=? AND owner_assignment=?
          AND revoked_at_ms IS NULL`,
            input.delegationId,
            this.communityId,
            input.accountId,
            f.owner.assignmentId,
          );
    try {
      await this.store.atomic(
        [f.fence],
        [
          statement,
          this.store.changed(),
          this.store.stmt(
            `INSERT INTO dance_delegation_audit VALUES(?,?,?,?,?,?,${DANCE_DB_NOW})`,
            this.communityId,
            actor,
            commandId,
            hash,
            input.delegationId,
            input.operation,
          ),
        ],
      );
    } catch (error) {
      const receipt = await this.store
        .stmt(
          `SELECT request_hash FROM dance_delegation_audit
        WHERE community_id=? AND actor_id=? AND command_id=?`,
          this.communityId,
          actor,
          commandId,
        )
        .first<{ request_hash: string }>();
      if (!receipt) throw error;
      insist(receipt.request_hash === hash, "dance_idempotency_conflict", 409);
    }
    return { delegationId: input.delegationId, operation: input.operation };
  }
}
