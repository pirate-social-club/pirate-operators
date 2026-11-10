import { hashJson, insist } from "../packages/community/common.ts";
import {
  DANCE_SOURCE,
  DANCE_VERSION,
  type DanceQueue,
  type DanceReview,
} from "../packages/dance/contracts.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import {
  danceId,
  mediaBinding,
  validateMedia,
} from "../packages/dance/validation.ts";
import { DanceCaptureService } from "./dance-capture.ts";

export class DanceReviewService extends DanceCaptureService {
  async get(actor: string, reviewId: string): Promise<DanceReview> {
    danceId(actor);
    danceId(reviewId);
    const r = await this.store.review(reviewId),
      access = await this.permissions.read(actor, r);
    await this.store.atomic(access.fences, []);
    if (r.state === "pending" && (await this.store.now()) >= r.reviewDeadlineMs)
      return { ...r, state: "expired" };
    return r;
  }
  /** Called by lane3 on EACH GET/HEAD/range, never a reusable bearer URL. */
  async inspect(actor: string, reviewId: string) {
    const r = await this.get(actor, reviewId);
    const m = await this.ports.media(r.mediaId, mediaBinding(r.capture), actor);
    validateMedia(r.capture, m, r.recordingSha256);
    insist(m.revision === r.mediaRevision, "dance_media_changed", 409);
    const access = await this.permissions.read(actor, r);
    insist(
      access.facts.learner.revision === r.capture.accountRevision,
      "dance_capture_authorization_changed",
      403,
    );
    await this.store.atomic(
      [
        ...access.fences,
        m.fence,
        {
          sql: `${DANCE_DB_NOW} < ? AND ${DANCE_DB_NOW} < ?
      AND EXISTS(SELECT 1 FROM dance_reviews WHERE review_id=? AND state IN ('pending','reviewed') AND revision=?)`,
          values: [m.expiresAtMs, r.reviewDeadlineMs, r.reviewId, r.revision],
        },
      ],
      [],
    );
    return { mediaId: r.mediaId, reviewId: r.reviewId };
  }
  async decide(
    actor: string,
    commandId: string,
    reviewId: string,
    revision: number,
    verdict: "passed" | "not_passed",
  ) {
    [actor, commandId, reviewId].forEach(danceId);
    insist(
      verdict === "passed" || verdict === "not_passed",
      "dance_verdict_invalid",
    );
    insist(
      Number.isSafeInteger(revision) && revision > 0,
      "dance_revision_invalid",
    );
    const r = await this.store.review(reviewId);
    insist(r.capture.communityId === this.communityId, "dance_not_found", 404);
    const f = await this.permissions.facts(actor, r.capture.accountId);
    const reviewer = await this.permissions.reviewer(f);
    const hash = DanceStore.request("verdict", { reviewId, revision, verdict });
    const prior = await this.store.receipt(
      this.communityId,
      actor,
      commandId,
      hash,
    );
    if (prior) return this.recovery(actor, commandId, hash, reviewId);
    insist(
      r.state === "pending" && r.revision === revision,
      "dance_revision_conflict",
      409,
    );
    insist(
      f.learner.revision === r.capture.accountRevision &&
        f.learner.identityId === r.capture.identityId &&
        f.learner.wallet === r.capture.wallet,
      "dance_capture_authorization_changed",
      403,
    );
    const m = await this.ports.media(r.mediaId, mediaBinding(r.capture), actor);
    validateMedia(r.capture, m, r.recordingSha256);
    insist(m.revision === r.mediaRevision, "dance_media_changed", 409);
    const rules = await this.ports.rules(r.capture);
    const selected = r.capture.offer;
    const offer = selected ? await this.ports.offer(r.capture) : null;
    if (selected && offer)
      insist(
        offer.inputHash === selected.inputHash &&
          offer.sourceId === selected.sourceId,
        "dance_offer_binding_mismatch",
        409,
      );
    const reason =
      verdict !== "passed"
        ? "not_passed"
        : !selected
          ? "practice"
          : !offer?.admitted
            ? "source_not_admitted"
            : !offer.open
              ? "offer_closed"
              : "candidate_held";
    const window = selected ?? { opensAtMs: 0, cutoffAtMs: 0 };
    const fences = [
      f.fence,
      reviewer.fence,
      m.fence,
      rules,
      ...(offer ? [offer.fence] : []),
    ];
    try {
      await this.store.atomic(fences, [
        this.store.stmt(
          `UPDATE dance_reviews SET state='reviewed',revision=revision+1,terminal_at_ms=${DANCE_DB_NOW}
          WHERE review_id=? AND state='pending' AND revision=? AND ${DANCE_DB_NOW}<deadline_ms
          AND ${DANCE_DB_NOW} < ?`,
          reviewId,
          revision,
          m.expiresAtMs,
        ),
        this.store.changed(),
        this.store.stmt(
          `INSERT INTO dance_verdicts
          SELECT review_id,json_object('version',?,'verdict',?,'reviewerAccountId',?,'reviewerIdentityId',?,'authority',?,
            'committedAtMs',terminal_at_ms,'cue','not_required','score',NULL,'chainAdmission','held',
            'rewardReason',CASE WHEN ?='candidate_held' AND NOT(terminal_at_ms>=? AND terminal_at_ms<?)
              THEN 'outside_window' ELSE ? END),terminal_at_ms,?
          FROM dance_reviews WHERE review_id=?`,
          DANCE_SOURCE,
          verdict,
          actor,
          f.actor.identityId,
          reviewer.authority,
          reason,
          window.opensAtMs,
          window.cutoffAtMs,
          reason,
          hashJson({
            version: DANCE_SOURCE,
            reviewId,
            capture: r.capture,
            recordingSha256: r.recordingSha256,
            verdict,
          }),
          reviewId,
        ),
        this.store.saveReceipt(
          this.communityId,
          actor,
          commandId,
          hash,
          reviewId,
        ),
      ]);
    } catch (error) {
      const recovered = await this.recovery(
        actor,
        commandId,
        hash,
        reviewId,
      ).catch(() => null);
      if (recovered) return recovered;
      throw error;
    }
    return this.recovery(actor, commandId, hash, reviewId);
  }
  async end(
    actor: string,
    commandId: string,
    reviewId: string,
    revision: number,
    operation: "withdraw" | "expire",
  ) {
    [actor, commandId, reviewId].forEach(danceId);
    insist(
      operation === "withdraw" || operation === "expire",
      "dance_invalid_operation",
    );
    const r = await this.store.review(reviewId),
      access = await this.permissions.read(actor, r);
    insist(actor === r.capture.accountId, "dance_withdraw_forbidden", 403);
    const hash = DanceStore.request(operation, { reviewId, revision });
    const prior = await this.store.receipt(
      this.communityId,
      actor,
      commandId,
      hash,
    );
    if (prior) return this.recovery(actor, commandId, hash, reviewId);
    const condition =
      operation === "expire" ? `${DANCE_DB_NOW}>=deadline_ms` : "1";
    try {
      await this.store.atomic(access.fences, [
        this.store.stmt(
          `UPDATE dance_reviews
        SET state=?,revision=revision+1,terminal_at_ms=${DANCE_DB_NOW}
        WHERE review_id=? AND revision=? AND state='pending' AND (${condition})`,
          operation === "expire" ? "expired" : "withdrawn",
          reviewId,
          revision,
        ),
        this.store.changed(),
        this.store.saveReceipt(
          this.communityId,
          actor,
          commandId,
          hash,
          reviewId,
        ),
      ]);
    } catch (error) {
      const recovered = await this.recovery(
        actor,
        commandId,
        hash,
        reviewId,
      ).catch(() => null);
      if (recovered) return recovered;
      throw error;
    }
    return this.recovery(actor, commandId, hash, reviewId);
  }
  async queue(
    actor: string,
    cursor: string | null = null,
  ): Promise<DanceQueue> {
    danceId(actor);
    if (cursor !== null) danceId(cursor);
    // Queue permission has no selected learner. Its SQL and each item read
    // enforce distinct account AND identity before returning private details.
    const f = await this.permissions.facts(actor, actor);
    const reviewer = await this.permissions.reviewer(f, false);
    const rows = await this.store
      .stmt(
        `SELECT r.review_id FROM dance_reviews r
      JOIN dance_captures c ON c.capture_id=r.review_id
      WHERE r.community_id=? AND r.state='pending' AND r.deadline_ms>${DANCE_DB_NOW}
      AND r.account_id<>? AND json_extract(c.capture_json,'$.identityId')<>?
      AND (? IS NULL OR r.review_id>?) ORDER BY r.review_id LIMIT 51`,
        this.communityId,
        actor,
        f.actor.identityId,
        cursor,
        cursor,
      )
      .all<{ review_id: string }>();
    await this.store.atomic([f.fence, reviewer.fence], []);
    const ids = rows.results.slice(0, 50),
      items: DanceReview[] = [];
    for (const id of ids) items.push(await this.get(actor, id.review_id));
    return {
      version: DANCE_VERSION,
      items,
      cursor: rows.results.length > 50 ? ids.at(-1)!.review_id : null,
    };
  }
}
