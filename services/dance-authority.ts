import { hashJson, insist } from "../packages/community/common.ts";
import type {
  DanceAuthority,
  DanceControlIntent,
  DancePorts,
  DanceReview,
  ReviewerContext,
} from "../packages/dance/contracts.ts";
import type { DanceRepository } from "../packages/dance/repository.ts";
import { localReviewerFences } from "../packages/dance/local-guards.ts";
import {
  danceId,
  danceTime,
  sameKnownIdentity,
  sameCapturedPrincipal,
  validateAuthority,
  wallet,
} from "../packages/dance/validation.ts";
export class DancePermissions {
  readonly store: DanceRepository;
  readonly ports: DancePorts;
  readonly communityId: string;
  constructor(store: DanceRepository, ports: DancePorts, communityId: string) {
    this.store = store;
    this.ports = ports;
    this.communityId = communityId;
  }
  async facts(actor: string, learner: string, active = true) {
    const f = await this.ports.authority(this.communityId, actor, learner);
    validateAuthority(f, actor, learner, active);
    return f;
  }
  async owner(f: DanceAuthority) {
    insist(f.owner.canonicalAccepted, "dance_owner_operation_pending", 409);
    insist(
      f.actor.accountId === f.owner.accountId &&
        wallet(f.actor.wallet) === wallet(f.owner.wallet),
      "dance_owner_required",
      403,
    );
    insist(
      (await this.store.now()) < f.owner.expiresAtMs,
      "dance_owner_expired",
      403,
    );
  }
  async reviewer(
    f: DanceAuthority,
    excludeSelf = true,
    sourceHash?: string,
  ): Promise<ReviewerContext> {
    if (excludeSelf)
      insist(!sameKnownIdentity(f.actor, f.learner), "dance_self_review", 403);
    insist(f.owner.canonicalAccepted, "dance_owner_operation_pending", 409);
    const now = await this.store.now();
    insist(now < f.owner.expiresAtMs, "dance_owner_expired", 403);
    insist(
      Number.isSafeInteger(f.owner.epoch) &&
        f.owner.epoch > 0 &&
        Number.isSafeInteger(f.epochs.configurationRevision) &&
        f.epochs.configurationRevision > 0,
      "dance_owner_epoch_invalid",
      403,
    );
    let authority: string, roleEpoch: number;
    if (
      f.actor.accountId === f.owner.accountId &&
      wallet(f.actor.wallet) === wallet(f.owner.wallet)
    ) {
      authority = "owner:" + f.owner.assignmentId;
      roleEpoch = f.owner.epoch;
    } else {
      const r = f.reviewer;
      insist(
        r?.canonicalAccepted &&
          r.ownerEpoch === f.owner.epoch &&
          now < r.expiresAtMs,
        "dance_review_forbidden",
        403,
      );
      insist(
        Number.isSafeInteger(r.roleEpoch) &&
          r.roleEpoch > 0 &&
          Number.isSafeInteger(r.ownerEpoch) &&
          r.ownerEpoch > 0,
        "dance_review_epoch_invalid",
        403,
      );
      const stamp = f.canonicalRoleProjection;
      if (stamp)
        insist(
          stamp.wallet.toLowerCase() === wallet(f.actor.wallet) &&
            Number.isSafeInteger(stamp.revision) &&
            stamp.revision > 0 &&
            Number.isSafeInteger(stamp.blockNumber) &&
            stamp.blockNumber >= 0 &&
            /^0x[\da-f]{64}$/.test(stamp.blockHash) &&
            (!sourceHash || stamp.sourceHash === sourceHash),
          "dance_role_projection_changed",
          403,
        );
      insist(
        !(await this.store.locallyRevoked(
          this.communityId,
          f.actor.accountId,
          wallet(f.actor.wallet),
          {
            sourceHash: sourceHash ?? stamp?.sourceHash,
            roleEpoch: r.roleEpoch,
            ownerEpoch: f.owner.epoch,
            configurationRevision: f.epochs.configurationRevision,
            observation: stamp,
          },
        )),
        "dance_review_locally_revoked",
        403,
      );
      authority = "delegation:" + r.delegationId;
      roleEpoch = r.roleEpoch;
    }
    return {
      ...(f.canonicalRoleProjection
        ? { roleProjection: f.canonicalRoleProjection }
        : {}),
      accountId: f.actor.accountId,
      wallet: wallet(f.actor.wallet),
      identityEpoch: f.actor.identityEpoch,
      groupId: f.actor.groupId,
      groupEpoch: f.actor.groupEpoch,
      authorizationId: f.actor.authorizationId,
      knownAliases: f.actor.knownAliases,
      authority,
      ownerEpoch: f.owner.epoch,
      roleEpoch,
      accountCommitment: f.actor.accountCommitment,
      expectedConfigurationRevision: f.epochs.configurationRevision,
      expectedRulesEpoch: f.epochs.rulesEpoch,
      expectedMediaEpoch: f.epochs.mediaEpoch,
      consentVersion: this.ports.reviewerConsent.version,
      publicityPolicyHash: this.ports.reviewerConsent.publicityPolicyHash,
      consentAccepted: true,
    };
  }
  async read(actor: string, r: DanceReview) {
    insist(r.capture.communityId === this.communityId, "dance_not_found", 404);
    const f = await this.facts(actor, r.capture.learner.accountId);
    sameCapturedPrincipal(f.learner, r.capture.learner);
    const originalAuthorization = await this.ports.authorization(r.capture);
    if (actor === r.capture.learner.accountId) {
      sameCapturedPrincipal(f.actor, r.capture.learner);
      return { facts: f, fences: [f.fence, originalAuthorization] };
    }
    const reviewer = await this.reviewer(f, true, r.capture.source.sourceHash);
    return {
      facts: f,
      fences: [
        f.fence,
        originalAuthorization,
        ...localReviewerFences(
          this.communityId,
          reviewer,
          r.capture.source.sourceHash,
        ),
      ],
    };
  }
  async delegate(
    actor: string,
    commandId: string,
    input: {
      delegationId: string;
      accountId: string;
      operation: "grant" | "revoke";
      expiresAtMs: number;
    },
  ): Promise<DanceControlIntent> {
    [actor, commandId, input.delegationId, input.accountId].forEach(danceId);
    insist(
      input.operation === "grant" || input.operation === "revoke",
      "dance_invalid_operation",
    );
    const recover = async (prior: DanceControlIntent) => {
      insist(
        prior.communityId === this.communityId && prior.actorId === actor,
        "dance_delegation_not_found",
        404,
      );
      // Recovery checks CURRENT HTTP owner access, not fresh target admission or
      // the original chain epochs. Retain the original immutable payload bytes.
      const current = await this.facts(actor, actor);
      await this.owner(current);
      insist(
        prior.delegationId === input.delegationId &&
          prior.accountId === input.accountId &&
          prior.operation === input.operation &&
          prior.expiresAtMs ===
            (input.operation === "grant" ? input.expiresAtMs : 0),
        "dance_idempotency_conflict",
        409,
      );
      await this.store.assert([current.fence]);
      return prior;
    };
    const retained = await this.store.controlIntent(commandId);
    if (retained) return recover(retained);
    // Revocation authenticates the CURRENT owner and reads the STORED grant.
    // It never resolves an inactive target as a fresh admitted learner.
    const f = await this.facts(
      actor,
      input.operation === "grant" ? input.accountId : actor,
    );
    await this.owner(f);
    let targetWallet: string,
      assignment = f.owner.assignmentId;
    if (input.operation === "grant") {
      danceTime(input.expiresAtMs);
      insist(
        input.expiresAtMs > (await this.store.now()),
        "dance_delegation_expired",
        409,
      );
      insist(
        !sameKnownIdentity(f.actor, f.learner),
        "dance_self_delegation",
        403,
      );
      targetWallet = wallet(f.learner.wallet);
    } else {
      const grant = await this.store.grant(input.delegationId);
      insist(
        grant.communityId === this.communityId &&
          grant.accountId === input.accountId,
        "dance_delegation_not_found",
        404,
      );
      targetWallet = grant.wallet;
    }
    const body = {
      version: "pirate.dance-control-intent/1" as const,
      commandId,
      communityId: this.communityId,
      actorId: actor,
      delegationId: input.delegationId,
      accountId: input.accountId,
      wallet: targetWallet,
      operation: input.operation,
      ownerAssignment: assignment,
      ownerEpoch: f.owner.epoch,
      expectedConfigurationRevision: f.epochs.configurationRevision,
      expectedReviewerEpoch: await this.ports.reviewerRoleEpoch(targetWallet),
      expiresAtMs: input.operation === "grant" ? input.expiresAtMs : 0,
      status: "pending_canonical" as const,
    };
    try {
      const intent = { ...body, localIntegrityHash: hashJson(body) };
      const binding = await this.ports.controlBinding?.(intent, f.owner.wallet);
      return await this.store.control(intent, [f.fence], binding);
    } catch (error) {
      const accepted = await this.store.controlIntent(commandId);
      if (accepted) return recover(accepted);
      throw error;
    }
  }
}
