import { CommunityError, insist } from "../packages/community/common.ts";
import {
  DANCE_VERSION,
  type DanceQueue,
  type DanceReview,
  type DanceVerdict,
  type DanceFence,
} from "../packages/dance/contracts.ts";
import {
  dispatchable,
  localReviewerFences,
} from "../packages/dance/local-guards.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { decisionIntent } from "../packages/dance/intent.ts";
import {
  danceId,
  sameCapturedPrincipal,
  validateMedia,
} from "../packages/dance/validation.ts";
import { validateCanonicalEvidence } from "../packages/dance/categorical-source.ts";
import { DanceCaptureService } from "./dance-capture.ts";
export class DanceReviewService extends DanceCaptureService {
  async get(actor: string, id: string): Promise<DanceReview> {
    danceId(actor);
    danceId(id);
    const r = await this.store.review(id),
      a = await this.permissions.read(actor, r);
    const expired =
      r.state === "awaiting_review" &&
      (await this.store.now()) >= r.receipt.reviewDeadlineMs;
    // Last local admission after EVERY awaited observation, including the clock.
    await this.store.assert(a.fences);
    return expired ? { ...r, state: "expired" } : r;
  }
  private async mediaFences(
    actor: string,
    r: DanceReview,
    access: { fences: DanceFence[] },
  ): Promise<DanceFence[]> {
    insist(
      !r.localDenied && (await this.store.now()) < r.receipt.reviewDeadlineMs,
      "dance_media_unavailable",
      410,
    );
    const ready =
      actor === r.capture.learner.accountId
        ? await this.ports.media.readyForSubmission(
            r.receipt.mediaId,
            r.media,
            { accountId: actor },
          )
        : await this.ports.media.readyForReview(r.receipt.mediaId, r.media, {
            accountId: actor,
          });
    validateMedia(r.media, ready.media);
    this.ports.media.projectDanceSubmission(
      this.ports.media.projectDanceMedia(ready.media, ready.witness),
      r.receipt,
    );
    insist(
      ready.media.revision === r.receipt.mediaRevision,
      "dance_media_changed",
      409,
    );
    return [...access.fences, this.ports.media.commitFence(ready.witness)];
  }
  async inspect(actor: string, id: string) {
    const r = await this.get(actor, id);
    const access = await this.permissions.read(actor, r);
    await this.store.assertAccess(r, await this.mediaFences(actor, r, access));
    return { reviewId: id, mediaId: r.receipt.mediaId };
  }
  async decide(
    actor: string,
    commandId: string,
    id: string,
    revision: number,
    verdict: DanceVerdict,
    consentVersion?: string,
  ) {
    [actor, commandId, id].forEach(danceId);
    insist(
      verdict === "pass" || verdict === "not_passed",
      "dance_verdict_invalid",
    );
    const r = await this.store.review(id);
    insist(r.capture.communityId === this.communityId, "dance_not_found", 404);
    // Current private authorization applies to receipt recovery. New admission
    // guards never replace an existing immutable decision command/payload.
    const access = await this.permissions.read(actor, r);
    const hash = DanceStore.request("decision", {
      reviewId: id,
      revision,
      verdict,
      consentVersion: consentVersion ?? null,
    });
    const prior = await this.store.receipt(
      this.communityId,
      actor,
      commandId,
      hash,
    );
    if (prior) return this.recovery(actor, commandId, hash, id);
    insist(
      this.ports.reviewerConsent.admission === "admitted" &&
        consentVersion === this.ports.reviewerConsent.version,
      "dance_reviewer_consent_required",
      403,
    );
    insist(!r.decision, "dance_decision_already_pending", 409);
    const reviewer = await this.permissions.reviewer(access.facts);
    insist(
      r.capture.consent?.publicityPolicyHash === reviewer.publicityPolicyHash,
      "dance_reviewer_policy_mismatch",
      409,
    );
    sameCapturedPrincipal(access.facts.learner, r.capture.learner);
    insist(
      r.state === "awaiting_review" &&
        !r.localDenied &&
        r.revision === revision,
      "dance_revision_conflict",
      409,
    );
    const now = await this.store.now();
    insist(now < r.receipt.reviewDeadlineMs, "dance_review_expired", 410);
    const ready = await this.ports.media.readyForReview(
      r.receipt.mediaId,
      r.media,
      { accountId: actor },
    );
    validateMedia(r.media, ready.media);
    insist(
      ready.media.revision === r.receipt.mediaRevision,
      "dance_media_changed",
      409,
    );
    const rules = await this.ports.rules(r.capture),
      intent = decisionIntent(r, commandId, verdict, reviewer, now);
    try {
      return await this.store.stageDecision({
        review: r,
        actor,
        requestHash: hash,
        intent,
        fences: [
          ...access.fences,
          rules,
          await this.ports.reviewerAuthorization(reviewer, now),
          this.ports.media.commitFence(ready.witness),
        ],
      });
    } catch (e) {
      const recovered = await this.recovery(actor, commandId, hash, id).catch(
        () => null,
      );
      if (recovered) return recovered;
      throw e;
    }
  }
  async end(
    actor: string,
    commandId: string,
    id: string,
    revision: number,
    operation: "withdraw" | "expire",
  ) {
    const r = await this.store.review(id),
      access = await this.permissions.read(actor, r);
    insist(
      actor === r.capture.learner.accountId,
      "dance_withdraw_forbidden",
      403,
    );
    if (operation === "expire") {
      insist(
        (await this.store.now()) >= r.receipt.reviewDeadlineMs,
        "dance_review_not_expired",
        409,
      );
      return this.get(actor, id);
    }
    const hash = DanceStore.request("withdraw", { reviewId: id, revision });
    const prior = await this.store.receipt(
      this.communityId,
      actor,
      commandId,
      hash,
    );
    if (prior) return this.recovery(actor, commandId, hash, id);
    insist(
      r.revision === revision && !r.localDenied,
      "dance_revision_conflict",
      409,
    );
    try {
      return await this.store.stageWithdrawal({
        review: r,
        actor,
        commandId,
        requestHash: hash,
        fences: access.fences,
      });
    } catch (e) {
      const recovered = await this.recovery(actor, commandId, hash, id).catch(
        () => null,
      );
      if (recovered) return recovered;
      throw e;
    }
  }
  async queue(
    actor: string,
    cursor: string | null = null,
    limit = 25,
  ): Promise<DanceQueue> {
    danceId(actor);
    if (cursor !== null) danceId(cursor);
    insist(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 50,
      "dance_invalid_limit",
    );
    const initial = await this.permissions.facts(actor, actor);
    await this.permissions.reviewer(initial, false);
    const items: DanceReview[] = [],
      reasons: Record<string, number> = {};
    let skipped = 0,
      scanned = 0,
      after = cursor,
      more = true;
    while (items.length < limit && scanned < 200 && more) {
      const page = await this.store.scan(
        this.communityId,
        after,
        Math.min(50, 200 - scanned),
      );
      more = page.hasMore;
      for (let j = 0; j < page.ids.length; j++) {
        const id = page.ids[j];
        after = id;
        scanned++;
        try {
          const r = await this.get(actor, id);
          insist(
            r.state === "awaiting_review" && !r.localDenied,
            "dance_review_unavailable",
            410,
          );
          await this.inspect(actor, id);
          items.push(r);
        } catch (e) {
          if (!(e instanceof CommunityError)) throw e;
          skipped++;
          reasons[e.code] = (reasons[e.code] ?? 0) + 1;
        }
        if (items.length === limit || scanned === 200) {
          more = more || j < page.ids.length - 1;
          break;
        }
      }
      if (page.ids.length === 0) break;
    }
    const current = await this.permissions.facts(actor, actor);
    const reviewer = await this.permissions.reviewer(current, false);
    await this.store.assert([
      current.fence,
      ...localReviewerFences(this.communityId, reviewer),
    ]);
    return {
      version: DANCE_VERSION,
      items,
      cursor: more ? after : null,
      skipped: { count: skipped, reasons },
    };
  }
  /** Internal coordinator-verified adapter only; no browser evidence input. */
  async reconcile(id: string) {
    const r = await this.store.review(id);
    insist(
      r.capture.communityId === this.communityId && r.decision,
      "dance_intent_missing",
      409,
    );
    const evidence = await this.ports.canonicalEvidence(r.decision);
    if (!evidence) return r;
    validateCanonicalEvidence(r, evidence);
    await this.store.observe(id, r.decision, evidence);
    return this.store.review(id);
  }
  /** Fresh dispatch rechecks cannot promise final chain authority. No send here. */
  async prepareDispatch(actor: string, id: string) {
    const r = await this.store.review(id);
    insist(r.decision, "dance_intent_missing", 409);
    insist(!r.localDenied, "dance_dispatch_locally_denied", 409);
    insist(r.state === "decision_pending", "dance_dispatch_unavailable", 409);
    const a = await this.permissions.read(actor, r);
    const original = r.decision.preimage.reviewer,
      current = await this.permissions.reviewer(a.facts);
    insist(
      actor === original.accountId &&
        current.wallet === original.wallet &&
        current.identityEpoch === original.identityEpoch &&
        current.groupId === original.groupId &&
        current.groupEpoch === original.groupEpoch &&
        current.ownerEpoch === original.ownerEpoch &&
        current.roleEpoch === original.roleEpoch &&
        current.expectedConfigurationRevision ===
          original.expectedConfigurationRevision &&
        current.expectedRulesEpoch === original.expectedRulesEpoch &&
        current.expectedMediaEpoch === original.expectedMediaEpoch,
      "dance_dispatch_context_changed",
      409,
    );
    const fences = [
      ...(await this.mediaFences(actor, r, a)),
      await this.ports.rules(r.capture),
      await this.ports.reviewerAuthorization(
        original,
        r.decision.preimage.intentAcceptedAtMs,
      ),
    ];
    const entry = await this.store.outbox(r.decision.commandId);
    insist(entry.status !== "held", "dance_protocol_admission_held", 409);
    insist(dispatchable(entry.status), "dance_dispatch_unavailable", 409);
    await this.store.assertDispatch(r, entry, fences);
    return entry;
  }
}
