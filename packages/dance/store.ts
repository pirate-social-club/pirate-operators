import { canonical, hashJson, insist, token } from "../community/common.ts";
import {
  DANCE_VERSION,
  type DanceCapture,
  type DanceFence,
  type DanceReceipt,
  type DanceReview,
  type SqlValue,
  type DanceDecisionIntent,
  type DanceCanonicalEvidence,
  type DanceOutbox,
  type DanceAttempt,
  type DanceControlIntent,
} from "./contracts.ts";
import {
  dispatchFence,
  localReviewerFences,
  localReviewerFence,
} from "./local-guards.ts";
import type {
  DanceControlBinding,
  DanceRevokeContext,
} from "./control-contracts.ts";
import { verifyControlBinding } from "../dance-chain/control-command.ts";
import { verifyRetainedAttempt } from "../dance-chain/control-reader.ts";
import type { DanceRepository } from "./repository.ts";
import { validateFence } from "./validation.ts";
import {
  decisionEvidencePreimage,
  decisionIntegrityHash,
  submissionIntentPreimage,
} from "./intent.ts";
import {
  submissionStatements,
  decisionStatements,
  withdrawalStatements,
  controlStatements,
} from "./store-writes.ts";
/** Local acceptance time only. NEVER the canonical verdict timestamp. */
export const DANCE_DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
export class DanceStore implements DanceRepository {
  readonly db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }
  stmt(sql: string, ...values: SqlValue[]) {
    return this.db.prepare(sql).bind(...values);
  }
  async now() {
    const r = await this.stmt("SELECT " + DANCE_DB_NOW + " AS n").first<{
      n: number;
    }>();
    insist(r && Number.isSafeInteger(r.n), "dance_clock_unavailable", 503);
    return r.n;
  }
  async atomic(fences: DanceFence[], statements: D1PreparedStatement[]) {
    insist(fences.length > 0, "dance_fence_unavailable", 503);
    try {
      await this.db.batch([
        ...fences.map((f) => {
          validateFence(f);
          return this.stmt(
            "INSERT INTO dance_transaction_guards SELECT ?,CASE WHEN (" +
              f.sql +
              ") THEN 1 ELSE 0 END",
            token(),
            ...f.values,
          );
        }),
        ...statements,
        this.stmt("DELETE FROM dance_transaction_guards"),
      ]);
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes("CHECK constraint failed: valid")
      )
        insist(false, "dance_fence_changed", 409);
      throw e;
    }
  }
  async assert(f: DanceFence[]) {
    await this.atomic(f, []);
  }
  async assertAccess(r: DanceReview, f: DanceFence[]) {
    await this.atomic(
      [
        ...f,
        {
          sql:
            "EXISTS(SELECT 1 FROM dance_reviews WHERE review_id=? AND revision=? AND local_denied=0 AND " +
            DANCE_DB_NOW +
            "<json_extract(receipt_json,'$.reviewDeadlineMs'))",
          values: [r.reviewId, r.revision],
        },
      ],
      [],
    );
  }
  async assertDispatch(r: DanceReview, b: DanceOutbox, f: DanceFence[]) {
    insist(
      r.state === "decision_pending" && r.decision?.commandId === b.commandId,
      "dance_dispatch_unavailable",
      409,
    );
    await this.atomic(
      [
        ...f,
        dispatchFence(b.commandId),
        {
          sql: "EXISTS(SELECT 1 FROM dance_reviews r JOIN dance_outbox b ON b.subject_id=r.review_id WHERE r.review_id=? AND r.revision=? AND b.command_id=? AND b.kind='decision' AND b.community_id=? AND b.payload_json=? AND b.local_integrity_hash=?)",
          values: [
            r.reviewId,
            r.revision,
            b.commandId,
            r.capture.communityId,
            b.payloadJson,
            b.localIntegrityHash,
          ],
        },
      ],
      [],
    );
  }
  changed() {
    return this.stmt(
      "INSERT INTO dance_transaction_guards VALUES(?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)",
      token(),
    );
  }
  async capture(id: string) {
    const r = await this.stmt(
      "SELECT c.capture_json,s.consent_json FROM dance_captures c LEFT JOIN dance_consents s ON s.capture_id=c.capture_id WHERE c.capture_id=?",
      id,
    ).first<{ capture_json: string; consent_json: string | null }>();
    insist(r, "dance_not_found", 404);
    return {
      ...JSON.parse(r.capture_json),
      consent: r.consent_json ? JSON.parse(r.consent_json) : null,
    } as DanceCapture;
  }
  async findCapture(c: string, a: string, k: string, h: string) {
    const r = await this.stmt(
      "SELECT request_hash,capture_id FROM dance_captures WHERE community_id=? AND account_id=? AND command_id=?",
      c,
      a,
      k,
    ).first<{ request_hash: string; capture_id: string }>();
    if (!r) return null;
    insist(r.request_hash === h, "dance_idempotency_conflict", 409);
    return this.capture(r.capture_id);
  }
  async reserveCapture(
    c: DanceCapture,
    a: string,
    k: string,
    h: string,
    f: DanceFence[],
  ) {
    await this.atomic(
      [...f, { sql: DANCE_DB_NOW + " < ?", values: [c.expiresAtMs] }],
      [
        this.stmt(
          "INSERT INTO dance_captures VALUES(?,?,?,?,?,?)",
          c.captureId,
          c.communityId,
          a,
          k,
          h,
          JSON.stringify(c),
        ),
      ],
    );
  }
  async acceptConsent(
    c: DanceCapture,
    a: import("./contracts.ts").DanceConsentAcceptance,
    k: string,
    f: DanceFence[],
  ) {
    if (c.consent) {
      insist(
        c.consent.receiptId === k &&
          c.consent.version === a.version &&
          c.consent.termsHash === a.termsHash &&
          c.consent.publicityPolicyHash === a.publicityPolicyHash,
        "dance_consent_conflict",
        409,
      );
      await this.assert(f);
      return c;
    }
    await this.atomic(
      [
        ...f,
        {
          sql: DANCE_DB_NOW + ">=? AND " + DANCE_DB_NOW + "<?",
          values: [c.reservedAtMs, c.expiresAtMs],
        },
      ],
      [
        this.stmt(
          "INSERT INTO dance_consents SELECT ?,json_object('accepted',json('true'),'version',?,'termsHash',?,'publicityPolicyHash',?,'receiptId',?,'accountId',?,'captureId',?,'captureHash',?,'acceptedAtMs'," +
            DANCE_DB_NOW +
            ") ON CONFLICT DO NOTHING",
          c.captureId,
          a.version,
          a.termsHash,
          a.publicityPolicyHash,
          k,
          c.learner.accountId,
          c.captureId,
          c.captureHash,
        ),
      ],
    );
    const saved = await this.capture(c.captureId);
    insist(
      saved.consent?.receiptId === k &&
        saved.consent.version === a.version &&
        saved.consent.termsHash === a.termsHash &&
        saved.consent.publicityPolicyHash === a.publicityPolicyHash,
      "dance_consent_conflict",
      409,
    );
    return saved;
  }
  async ensureSubmissionOutbox(r: DanceReview, k: string) {
    const p = submissionIntentPreimage(r, k),
      body = JSON.stringify(p),
      hash = hashJson(p);
    await this.atomic(
      [
        {
          sql: "EXISTS(SELECT 1 FROM dance_reviews WHERE review_id=? AND receipt_json=?)",
          values: [r.reviewId, JSON.stringify(r.receipt)],
        },
      ],
      [
        this.stmt(
          "INSERT INTO dance_outbox VALUES(?,?,?,'submission',?,?,?) ON CONFLICT DO NOTHING",
          k,
          r.capture.communityId,
          r.reviewId,
          body,
          hash,
          r.localDenied ? "canceled" : "held",
        ),
      ],
    );
    const existing = await this.outbox(k);
    insist(
      existing.localIntegrityHash === hash && existing.payloadJson === body,
      "dance_outbox_conflict",
      409,
    );
  }
  async receipt(c: string, a: string, k: string, h: string) {
    const r = await this.stmt(
      "SELECT request_hash,receipt_json FROM dance_receipts WHERE community_id=? AND actor_id=? AND command_id=?",
      c,
      a,
      k,
    ).first<{ request_hash: string; receipt_json: string }>();
    if (!r) return null;
    insist(r.request_hash === h, "dance_idempotency_conflict", 409);
    return JSON.parse(r.receipt_json) as DanceReceipt;
  }
  saveReceipt(c: string, a: string, k: string, h: string, id: string) {
    return this.stmt(
      "INSERT INTO dance_receipts SELECT ?,?,?,?,json_object('version',?,'commandId',?,'reviewId',r.review_id,'revision',r.revision,'state',r.state,'intentId',i.command_id) FROM dance_reviews r JOIN dance_consents co ON co.capture_id=r.review_id LEFT JOIN dance_decision_intents i ON i.review_id=r.review_id WHERE r.review_id=?",
      c,
      a,
      k,
      h,
      DANCE_VERSION,
      k,
      id,
    );
  }
  async review(id: string): Promise<DanceReview> {
    const r = await this.stmt(
      "SELECT r.*,c.capture_json,co.consent_json,i.command_id,i.preimage_json,i.local_integrity_hash,(SELECT evidence_json FROM dance_chain_observations e WHERE e.review_id=r.review_id ORDER BY rowid DESC LIMIT 1) evidence_json FROM dance_reviews r JOIN dance_captures c ON c.capture_id=r.review_id JOIN dance_consents co ON co.capture_id=c.capture_id LEFT JOIN dance_decision_intents i ON i.review_id=r.review_id WHERE r.review_id=?",
      id,
    ).first<{
      review_id: string;
      revision: number;
      capture_json: string;
      consent_json: string;
      media_json: string;
      receipt_json: string;
      state: "awaiting_review" | "decision_pending" | "withdrawal_pending";
      local_denied: number;
      command_id: string | null;
      preimage_json: string | null;
      local_integrity_hash: string | null;
      evidence_json: string | null;
    }>();
    insist(r, "dance_not_found", 404);
    const canonical = r.evidence_json
      ? (JSON.parse(r.evidence_json) as DanceCanonicalEvidence)
      : null;
    return {
      version: DANCE_VERSION,
      reviewId: r.review_id,
      revision: r.revision,
      capture: {
        ...JSON.parse(r.capture_json),
        consent: JSON.parse(r.consent_json),
      },
      media: JSON.parse(r.media_json),
      receipt: JSON.parse(r.receipt_json),
      state: canonical?.canonical ? "canonical" : r.state,
      localDenied: !!r.local_denied,
      decision: r.command_id
        ? {
            intentId: r.command_id,
            commandId: r.command_id,
            preimage: JSON.parse(r.preimage_json!),
            localIntegrityHash: r.local_integrity_hash!,
          }
        : null,
      canonical,
    };
  }
  async scan(c: string, after: string | null, limit: number) {
    const r = await this.stmt(
      "SELECT review_id FROM dance_reviews WHERE community_id=? AND state='awaiting_review' AND (? IS NULL OR review_id>?) ORDER BY review_id LIMIT ?",
      c,
      after,
      after,
      limit + 1,
    ).all<{ review_id: string }>();
    return {
      ids: r.results.slice(0, limit).map((v) => v.review_id),
      hasMore: r.results.length > limit,
    };
  }
  async acceptSubmission(
    i: Parameters<DanceRepository["acceptSubmission"]>[0],
  ) {
    await this.atomic(i.fences, submissionStatements(this, i));
    const r = await this.receipt(
      i.capture.communityId,
      i.capture.learner.accountId,
      i.commandId,
      i.requestHash,
    );
    insist(r, "dance_outcome_unknown", 503);
    return r;
  }
  async stageDecision(i: Parameters<DanceRepository["stageDecision"]>[0]) {
    insist(
      i.intent.localIntegrityHash === decisionIntegrityHash(i.intent.preimage),
      "dance_intent_corrupt",
      503,
    );
    await this.atomic(
      [
        ...i.fences,
        ...localReviewerFences(
          i.review.capture.communityId,
          i.intent.preimage.reviewer,
          i.review.capture.source.sourceHash,
          true,
        ),
      ],
      decisionStatements(this, i),
    );
    const r = await this.receipt(
      i.review.capture.communityId,
      i.actor,
      i.intent.commandId,
      i.requestHash,
    );
    insist(r, "dance_outcome_unknown", 503);
    return r;
  }
  async stageWithdrawal(i: Parameters<DanceRepository["stageWithdrawal"]>[0]) {
    await this.atomic(i.fences, withdrawalStatements(this, i));
    const r = await this.receipt(
      i.review.capture.communityId,
      i.actor,
      i.commandId,
      i.requestHash,
    );
    insist(r, "dance_outcome_unknown", 503);
    return r;
  }
  async grant(id: string) {
    const r = await this.stmt(
      "SELECT delegation_id delegationId,community_id communityId,account_id accountId,wallet,owner_assignment ownerAssignment FROM dance_delegations WHERE delegation_id=?",
      id,
    ).first<Awaited<ReturnType<DanceRepository["grant"]>>>();
    insist(r, "dance_delegation_not_found", 404);
    return r;
  }
  async control(
    i: Parameters<DanceRepository["control"]>[0],
    f: DanceFence[],
    binding?: DanceControlBinding,
  ) {
    const prior = await this.controlIntent(i.commandId);
    if (prior) {
      insist(
        prior.localIntegrityHash === i.localIntegrityHash,
        "dance_idempotency_conflict",
        409,
      );
      await this.assert(f);
      return prior;
    }
    if (binding) verifyControlBinding(i, binding);
    const rows = controlStatements(this, i);
    if (binding)
      rows.push(
        this.stmt(
          "INSERT INTO dance_control_bindings VALUES(?,?,?,?,?,?)",
          i.commandId,
          binding.bindingHash,
          binding.intentHash,
          binding.sourceHash,
          binding.wallet,
          JSON.stringify(binding),
        ),
      );
    await this.atomic(f, rows);
    return i;
  }
  async controlIntent(k: string) {
    const row = await this.stmt(
      "SELECT body_json,local_integrity_hash FROM dance_control_intents WHERE command_id=?",
      k,
    ).first<{ body_json: string; local_integrity_hash: string }>();
    if (!row) return null;
    const intent = JSON.parse(row.body_json) as DanceControlIntent;
    const { localIntegrityHash, ...body } = intent;
    insist(
      intent.commandId === k &&
        localIntegrityHash === row.local_integrity_hash &&
        hashJson(body) === localIntegrityHash,
      "dance_control_corrupt",
      503,
    );
    return intent;
  }
  async locallyRevoked(
    c: string,
    a: string,
    w: string,
    context?: DanceRevokeContext,
  ) {
    const fence = localReviewerFence(c, a, w, context);
    const row = await this.stmt(
      "SELECT " + fence.sql + " allowed",
      ...fence.values,
    ).first<{ allowed: number }>();
    return row?.allowed !== 1;
  }
  async observe(id: string, i: DanceDecisionIntent, e: DanceCanonicalEvidence) {
    await this.atomic(
      [
        {
          sql: "EXISTS(SELECT 1 FROM dance_decision_intents WHERE review_id=? AND command_id=? AND preimage_json=? AND local_integrity_hash=?)",
          values: [
            id,
            i.commandId,
            decisionEvidencePreimage(i.preimage),
            i.localIntegrityHash,
          ],
        },
      ],
      [
        this.stmt(
          "INSERT INTO dance_chain_observations VALUES(?,?,?,?, " +
            DANCE_DB_NOW +
            ")",
          token(),
          id,
          i.commandId,
          JSON.stringify(e),
        ),
        this.stmt(
          "UPDATE dance_outbox SET status=? WHERE command_id=?",
          e.canonical ? e.finality : "orphaned",
          i.commandId,
        ),
      ],
    );
  }
  async outbox(k: string) {
    const r = await this.stmt(
      "SELECT command_id commandId,community_id communityId,subject_id subjectId,kind,payload_json payloadJson,local_integrity_hash localIntegrityHash,status FROM dance_outbox WHERE command_id=?",
      k,
    ).first<DanceOutbox>();
    insist(r, "dance_outbox_not_found", 404);
    return r;
  }
  async attempt(a: DanceAttempt, fences: DanceFence[]) {
    insist(fences.length > 0, "dance_dispatch_fence_required", 503);
    const box = await this.outbox(a.commandId);
    let binding: DanceControlBinding | null = null;
    if (box.kind === "grant" || box.kind === "revoke") {
      const row = await this.stmt(
        "SELECT binding_json FROM dance_control_bindings WHERE command_id=?",
        a.commandId,
      ).first<{ binding_json: string }>();
      const intent = await this.controlIntent(a.commandId);
      insist(row && intent, "dance_control_original_binding_missing", 503);
      insist(
        box.kind === intent.operation &&
          box.communityId === intent.communityId &&
          box.subjectId === intent.delegationId &&
          box.localIntegrityHash === intent.localIntegrityHash &&
          canonical(JSON.parse(box.payloadJson)) === canonical(intent),
        "dance_control_outbox_changed",
        503,
      );
      binding = JSON.parse(row.binding_json);
      verifyControlBinding(intent, binding!);
      verifyRetainedAttempt({ ...a, guardedBindingHash: binding!.bindingHash });
    }
    const statements = [
      this.stmt(
        "INSERT INTO dance_transaction_attempts VALUES(?,?,?,?,?)",
        a.attemptId,
        a.commandId,
        a.nonce,
        a.rawTransaction,
        a.transactionHash,
      ),
      this.stmt(
        "UPDATE dance_outbox SET status='unknown' WHERE command_id=?",
        a.commandId,
      ),
    ];
    if (binding)
      statements.push(
        this.stmt(
          "INSERT INTO dance_attempt_admissions VALUES(?,?,?,'guarded_before_broadcast')",
          a.attemptId,
          a.commandId,
          binding.bindingHash,
        ),
      );
    await this.atomic([...fences, dispatchFence(a.commandId)], statements);
  }
  /** Evidence retention only: no dispatch admission/status change or send. */
  async retainAttemptEvidence(a: DanceAttempt) {
    verifyRetainedAttempt({ ...a, guardedBindingHash: null });
    const old = await this.stmt(
      "SELECT command_id,nonce,raw_transaction,transaction_hash FROM dance_transaction_attempts WHERE attempt_id=? OR (command_id=? AND transaction_hash=?) UNION ALL SELECT command_id,nonce,raw_transaction,transaction_hash FROM dance_recovered_attempts WHERE attempt_id=? OR (command_id=? AND transaction_hash=?)",
      a.attemptId,
      a.commandId,
      a.transactionHash,
      a.attemptId,
      a.commandId,
      a.transactionHash,
    ).all<{
      command_id: string;
      nonce: string;
      raw_transaction: string;
      transaction_hash: string;
    }>();
    if (old.results.length) {
      insist(
        old.results.every(
          (r) =>
            r.command_id === a.commandId &&
            r.nonce === a.nonce &&
            r.raw_transaction === a.rawTransaction &&
            r.transaction_hash === a.transactionHash,
        ),
        "dance_attempt_identity_changed",
        503,
      );
      return;
    }
    await this.atomic(
      [
        {
          sql: "EXISTS(SELECT 1 FROM dance_outbox WHERE command_id=?)",
          values: [a.commandId],
        },
      ],
      [
        this.stmt(
          "INSERT INTO dance_recovered_attempts VALUES(?,?,?,?,?)",
          a.attemptId,
          a.commandId,
          a.nonce,
          a.rawTransaction,
          a.transactionHash,
        ),
      ],
    );
  }
  static request(operation: string, body: unknown) {
    return hashJson({ version: DANCE_VERSION, operation, body });
  }
}
