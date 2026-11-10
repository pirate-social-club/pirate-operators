/** Atomic in-memory model for PURE unit tests. Not D1/Worker evidence. */
import { canonical, hashJson, insist } from "../packages/community/common.ts";
import {
  DANCE_VERSION,
  type DanceCapture,
  type DanceReceipt,
  type DanceReview,
  type DanceControlIntent,
  type DanceFence,
  type DanceOutbox,
  type DanceDecisionIntent,
  type DanceCanonicalEvidence,
  type DanceStoredGrant,
  type DanceAttempt,
} from "../packages/dance/contracts.ts";
import type { DanceRepository } from "../packages/dance/repository.ts";
import {
  decisionIntegrityHash,
  decisionEvidencePreimage,
} from "../packages/dance/intent.ts";
import { reviewDeadline } from "../packages/dance/validation.ts";
const copy = <T>(v: T): T => structuredClone(v);
export class MemoryDanceStore implements DanceRepository {
  time = 1800000000000;
  checks = new Map<string, () => boolean>();
  captures = new Map<string, DanceCapture>();
  captureCommands = new Map<string, { hash: string; id: string }>();
  consents = new Map<string, NonNullable<DanceCapture["consent"]>>();
  records = new Map<string, DanceReview>();
  receipts = new Map<string, { hash: string; receipt: DanceReceipt }>();
  grants = new Map<string, DanceStoredGrant>();
  controls = new Map<string, DanceControlIntent>();
  boxes = new Map<string, DanceOutbox>();
  attempts: DanceAttempt[] = [];
  onCommit: (() => void) | null = null;
  loseResponse = false;
  async now() {
    return this.time;
  }
  guard(f: DanceFence[]) {
    this.onCommit?.();
    this.onCommit = null;
    for (const v of f)
      insist(this.checks.get(v.sql)?.(), "dance_fence_changed", 409);
  }
  async assert(f: DanceFence[]) {
    this.guard(f);
  }
  async assertAccess(r: DanceReview, f: DanceFence[]) {
    this.guard(f);
    const current = this.records.get(r.reviewId);
    insist(
      current &&
        !current.localDenied &&
        current.revision === r.revision &&
        this.time < current.receipt.reviewDeadlineMs,
      "dance_fence_changed",
      409,
    );
  }
  async capture(id: string) {
    const c = this.captures.get(id);
    insist(c, "dance_not_found", 404);
    return copy({ ...c, consent: this.consents.get(id) ?? null });
  }
  key(c: string, a: string, k: string) {
    return JSON.stringify([c, a, k]);
  }
  async findCapture(c: string, a: string, k: string, h: string) {
    const v = this.captureCommands.get(this.key(c, a, k));
    if (!v) return null;
    insist(v.hash === h, "dance_idempotency_conflict", 409);
    return this.capture(v.id);
  }
  async reserveCapture(
    c: DanceCapture,
    a: string,
    k: string,
    h: string,
    f: DanceFence[],
  ) {
    this.guard(f);
    insist(this.time < c.expiresAtMs, "dance_capture_expired", 410);
    const key = this.key(c.communityId, a, k);
    insist(!this.captureCommands.has(key), "dance_capture_conflict", 409);
    this.captures.set(c.captureId, copy(c));
    this.captureCommands.set(key, { id: c.captureId, hash: h });
  }
  async acceptConsent(
    c: DanceCapture,
    a: import("../packages/dance/contracts.ts").DanceConsentAcceptance,
    k: string,
    f: DanceFence[],
  ) {
    this.guard(f);
    const prior = this.consents.get(c.captureId);
    if (prior) {
      insist(
        prior.receiptId === k &&
          prior.version === a.version &&
          prior.termsHash === a.termsHash &&
          prior.publicityPolicyHash === a.publicityPolicyHash,
        "dance_consent_conflict",
        409,
      );
      return this.capture(c.captureId);
    }
    insist(
      this.captures.has(c.captureId) &&
        this.time >= c.reservedAtMs &&
        this.time < c.expiresAtMs,
      "dance_capture_expired",
      410,
    );
    this.consents.set(c.captureId, {
      ...a,
      receiptId: k,
      accountId: c.learner.accountId,
      captureId: c.captureId,
      captureHash: c.captureHash,
      acceptedAtMs: this.time,
    });
    return this.capture(c.captureId);
  }
  async ensureSubmissionOutbox(r: DanceReview, k: string) {
    if (!this.boxes.has(k))
      this.box(k, r, "submission", {
        capture: r.capture,
        media: r.media,
        receipt: r.receipt,
      });
  }
  async receipt(c: string, a: string, k: string, h: string) {
    const v = this.receipts.get(this.key(c, a, k));
    if (!v) return null;
    insist(v.hash === h, "dance_idempotency_conflict", 409);
    return copy(v.receipt);
  }
  save(r: DanceReview, a: string, k: string, h: string): DanceReceipt {
    const receipt: DanceReceipt = {
      version: DANCE_VERSION,
      commandId: k,
      reviewId: r.reviewId,
      revision: r.revision,
      state: r.state,
      intentId: r.decision?.intentId ?? null,
    };
    const key = this.key(r.capture.communityId, a, k);
    insist(!this.receipts.has(key), "dance_idempotency_conflict", 409);
    this.receipts.set(key, { hash: h, receipt: copy(receipt) });
    return receipt;
  }
  box(k: string, r: DanceReview, kind: DanceOutbox["kind"], payload: unknown) {
    this.boxes.set(k, {
      commandId: k,
      communityId: r.capture.communityId,
      subjectId: r.reviewId,
      kind,
      payloadJson: canonical(payload),
      localIntegrityHash: hashJson(payload),
      status: "held",
    });
  }
  async acceptSubmission(
    i: Parameters<DanceRepository["acceptSubmission"]>[0],
  ) {
    this.guard(i.fences);
    const c = i.capture;
    insist(this.time < c.expiresAtMs, "dance_capture_expired", 410);
    insist(
      !this.records.has(c.captureId) &&
        ![...this.records.values()].some(
          (r) =>
            r.capture.communityId === c.communityId &&
            r.media.recordingSha256 === i.media.recordingSha256,
        ),
      "dance_recording_reused",
      409,
    );
    // Consumer composition contract observed; actual source3 D1 plan requires slot.
    i.mediaPort.prepareMediaSubmission(
      i.witness,
      c.captureId,
      i.bindingCommitment,
      {
        sql: "actual-accepted-dance-receipt",
        values: [c.captureId, i.commandId],
      },
    );
    const r: DanceReview = {
      version: DANCE_VERSION,
      reviewId: c.captureId,
      revision: 1,
      capture: copy(c),
      media: copy(i.media),
      receipt: {
        submissionId: c.captureId,
        communityId: c.communityId,
        accountId: c.learner.accountId,
        mediaId: i.witness.id,
        bindingCommitment: i.bindingCommitment,
        trustedSubmittedAtMs: this.time,
        reviewDeadlineMs: reviewDeadline(this.time),
        mediaRevision: i.witness.revision + 1,
      },
      state: "awaiting_review",
      localDenied: false,
      decision: null,
      canonical: null,
    };
    this.records.set(r.reviewId, r);
    const receipt = this.save(
      r,
      c.learner.accountId,
      i.commandId,
      i.requestHash,
    );
    this.box(i.commandId, r, "submission", r.receipt);
    return copy(receipt);
  }
  async review(id: string) {
    const r = this.records.get(id);
    insist(r, "dance_not_found", 404);
    return copy(r);
  }
  async scan(c: string, after: string | null, limit: number) {
    const ids = [...this.records.values()]
      .filter(
        (r) =>
          r.capture.communityId === c &&
          r.state === "awaiting_review" &&
          (!after || r.reviewId > after),
      )
      .map((r) => r.reviewId)
      .sort();
    return { ids: ids.slice(0, limit), hasMore: ids.length > limit };
  }
  async stageDecision(i: Parameters<DanceRepository["stageDecision"]>[0]) {
    this.guard(i.fences);
    const r = this.records.get(i.review.reviewId)!;
    insist(
      r.revision === i.review.revision &&
        r.state === "awaiting_review" &&
        !r.localDenied &&
        !r.decision &&
        this.time < r.receipt.reviewDeadlineMs,
      "dance_revision_conflict",
      409,
    );
    insist(
      i.intent.localIntegrityHash === decisionIntegrityHash(i.intent.preimage),
      "dance_intent_corrupt",
      503,
    );
    r.decision = copy(i.intent);
    r.state = "decision_pending";
    r.revision++;
    this.box(
      i.intent.commandId,
      r,
      "decision",
      JSON.parse(decisionEvidencePreimage(i.intent.preimage)),
    );
    const receipt = this.save(r, i.actor, i.intent.commandId, i.requestHash);
    if (this.loseResponse) {
      this.loseResponse = false;
      throw Error("modeled lost response AFTER atomic commit");
    }
    return copy(receipt);
  }
  async stageWithdrawal(i: Parameters<DanceRepository["stageWithdrawal"]>[0]) {
    this.guard(i.fences);
    const r = this.records.get(i.review.reviewId)!;
    insist(
      r.revision === i.review.revision && !r.localDenied,
      "dance_revision_conflict",
      409,
    );
    r.localDenied = true;
    r.state = "withdrawal_pending";
    r.revision++;
    for (const b of this.boxes.values())
      if (
        b.subjectId === r.reviewId &&
        (b.status === "held" || b.status === "ready")
      )
        b.status = "canceled";
    this.box(i.commandId, r, "withdraw", {
      commandId: i.commandId,
      reviewId: r.reviewId,
    });
    return copy(this.save(r, i.actor, i.commandId, i.requestHash));
  }
  async grant(id: string) {
    const g = this.grants.get(id);
    insist(g, "dance_delegation_not_found", 404);
    return copy(g);
  }
  async control(i: DanceControlIntent, f: DanceFence[]) {
    this.guard(f);
    const prior = this.controls.get(i.commandId);
    if (prior) {
      insist(
        prior.localIntegrityHash === i.localIntegrityHash,
        "dance_idempotency_conflict",
        409,
      );
      return copy(prior);
    }
    if (i.operation === "grant") {
      insist(!this.grants.has(i.delegationId), "dance_grant_exists", 409);
      this.grants.set(i.delegationId, {
        delegationId: i.delegationId,
        communityId: i.communityId,
        accountId: i.accountId,
        wallet: i.wallet,
        ownerAssignment: i.ownerAssignment,
      });
    }
    this.controls.set(i.commandId, copy(i));
    this.boxes.set(i.commandId, {
      commandId: i.commandId,
      communityId: i.communityId,
      subjectId: i.delegationId,
      kind: i.operation,
      payloadJson: canonical(i),
      localIntegrityHash: i.localIntegrityHash,
      status: "held",
    });
    return copy(i);
  }
  async locallyRevoked(c: string, a: string, w: string) {
    return [...this.controls.values()].some(
      (v) =>
        v.communityId === c &&
        v.operation === "revoke" &&
        (v.accountId === a || v.wallet.toLowerCase() === w.toLowerCase()),
    );
  }
  async observe(id: string, i: DanceDecisionIntent, e: DanceCanonicalEvidence) {
    const r = this.records.get(id)!;
    insist(
      r.decision?.localIntegrityHash === i.localIntegrityHash,
      "dance_intent_conflict",
      409,
    );
    r.canonical = copy(e);
    r.state = e.canonical
      ? "canonical"
      : r.localDenied
        ? "withdrawal_pending"
        : "decision_pending";
    this.boxes.get(i.commandId)!.status = e.canonical ? e.finality : "orphaned";
  }
  async outbox(k: string) {
    const b = this.boxes.get(k);
    insist(b, "dance_outbox_not_found", 404);
    return copy(b);
  }
  async attempt(a: DanceAttempt) {
    this.attempts.push(copy(a));
  }
}
