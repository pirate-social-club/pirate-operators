import { bytes32, insist } from "../packages/community/common.ts";
import type { DancePorts, DanceReview } from "../packages/dance/contracts.ts";
import type { DanceProductionChoice, DanceProductionTarget } from "../packages/dance/production.ts";
import { sameDanceTarget, validDanceTarget } from "../packages/dance/production.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { danceId, sameCapturedPrincipal, validateCapture, validateFence, wallet } from "../packages/dance/validation.ts";
import { DanceReviewService } from "./dance-review.ts";
import { requireProductionTarget, requireSameProductionTarget, type DanceSelectedCatalogue } from "./dance-production.ts";

/** Authenticated reads over ACTUAL stored captures/reviews and the existing
 * permission service. They never allocate commands or mutate media/authority. */
export class DanceProductionReads {
  readonly store: DanceStore;
  readonly api: DanceReviewService;
  readonly db: D1Database;
  readonly ports: DancePorts;
  readonly catalogue: DanceSelectedCatalogue;
  readonly communityId: string;
  constructor(db: D1Database, ports: DancePorts,
    catalogue: DanceSelectedCatalogue, communityId: string) {
    this.db = db;
    this.ports = ports;
    this.catalogue = catalogue;
    this.communityId = communityId;
    this.store = new DanceStore(db);
    this.api = new DanceReviewService(this.store, ports, communityId);
  }
  async songKeyForPost(actor: string, postId: string) {
    bytes32(postId);
    const f = await this.api.permissions.facts(actor, actor);
    const songKey = bytes32(this.catalogue.songKeyForPost(postId));
    await this.store.assert([f.fence]);
    return { version: "pirate.dance-song-key/1", communityId: this.communityId,
      accountId: actor, postId, songKey, bindingOnly: true };
  }
  async cataloguePage(actor: string, songKey: string, cursor: string | null) {
    bytes32(songKey);
    const f = await this.api.permissions.facts(actor, actor);
    const { page, fence } = await this.catalogue.list(this.communityId, actor, songKey, cursor);
    insist(page.version === "pirate.dance-catalogue/1" && page.communityId === this.communityId &&
      page.accountId === actor && Array.isArray(page.choices) && page.choices.length <= 100 &&
      (page.cursor === null || (typeof page.cursor === "string" && page.cursor.length <= 2048)) &&
      page.consent && ["admitted", "review_pending"].includes(page.consent.admission) &&
      typeof page.consent.text === "string" && !!page.consent.version &&
      page.choices.every((c: DanceProductionChoice) => validDanceTarget(c) && c.communityId === this.communityId &&
        c.songKey === songKey && typeof c.title === "string" && !!c.title &&
        Number.isSafeInteger(c.durationMs) && c.durationMs >= 6000 && c.durationMs <= 30000 &&
        ["ready", "pending", "unavailable"].includes(c.playback) && typeof c.recordingAllowed === "boolean"),
      "dance_catalogue_binding_mismatch", 503);
    bytes32(page.consent.termsHash); bytes32(page.consent.publicityPolicyHash);
    await this.store.assert([f.fence, validateFence(fence)]);
    return { ...page, owner: f.actor.accountId === f.owner.accountId && wallet(f.actor.wallet) === wallet(f.owner.wallet) };
  }
  async latest(actor: string, target: DanceProductionTarget): Promise<DanceReview | null> {
    requireProductionTarget(target, this.communityId);
    const facts = await this.api.permissions.facts(actor, actor);
    const row = await this.db.prepare(`SELECT r.review_id FROM dance_reviews r
      JOIN dance_captures c ON c.capture_id=r.review_id
      WHERE r.community_id=? AND r.account_id=?
        AND json_extract(c.capture_json,'$.songKey')=?
        AND json_extract(c.capture_json,'$.songRevision')=?
        AND json_extract(c.capture_json,'$.audioSha256')=?
        AND json_extract(c.capture_json,'$.reference.id') IS ?
        AND json_extract(c.capture_json,'$.reference.revision') IS ?
        AND json_extract(c.capture_json,'$.offer.offerId') IS ?
      ORDER BY json_extract(r.receipt_json,'$.trustedSubmittedAtMs') DESC,r.review_id DESC LIMIT 1`)
      .bind(this.communityId, actor, target.songKey, target.songRevision, target.audioSha256,
        target.reference?.id ?? null, target.reference?.revision ?? null, target.offerId)
      .first<{ review_id: string }>();
    const review = row ? await this.api.get(actor, row.review_id) : null;
    if (review) requireSameProductionTarget(review.capture, target);
    await this.store.assert([facts.fence]);
    return review;
  }
  async captureAccess(actor: string, id: string) {
    danceId(id);
    const c = await this.store.capture(id);
    insist(c.communityId === this.communityId && c.learner.accountId === actor, "dance_not_found", 404);
    validateCapture(c);
    const facts = await this.api.permissions.facts(actor, actor);
    sameCapturedPrincipal(facts.actor, c.learner);
    const rules = await this.ports.rules(c), authorization = await this.ports.authorization(c);
    insist((await this.store.now()) < c.expiresAtMs, "dance_capture_expired", 410);
    // Expiry is re-evaluated by the last atomic D1 guard, after every await.
    await this.store.assert([facts.fence, rules, authorization, {
      sql: `EXISTS(SELECT 1 FROM dance_captures c JOIN dance_consents s ON s.capture_id=c.capture_id
        WHERE c.capture_id=? AND c.community_id=? AND c.account_id=? AND c.capture_json=?
        AND json_extract(s.consent_json,'$.captureHash')=?
        AND json_extract(c.capture_json,'$.expiresAtMs')>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))`,
      values: [c.captureId, this.communityId, actor, JSON.stringify({ ...c, consent: null }), c.captureHash],
    }]);
    return c;
  }
  async guide(actor: string, id: string, origin: string) {
    const c = await this.captureAccess(actor, id), grant = await this.catalogue.guide(c);
    insist(grant.communityId === c.communityId && grant.songKey === c.songKey &&
      grant.songRevision === c.songRevision && grant.audioSha256 === c.audioSha256,
      "dance_guide_target_changed", 409);
    const url = new URL(grant.playback_url, origin);
    insist(url.protocol === "https:" && !url.username && !url.password && !url.hash,
      "dance_guide_unavailable", 503);
    if (grant.access === "public") {
      const postId = await this.catalogue.songPostId(c);
      insist(grant.expires_at === undefined && url.origin === origin &&
        url.pathname === `/api/public/posts/${postId}/audio` && !url.search,
        "dance_guide_target_changed", 409);
    } else insist(Number.isSafeInteger(grant.expires_at) &&
      grant.expires_at <= Math.floor(Number.MAX_SAFE_INTEGER / 1000) &&
      grant.expires_at * 1000 > await this.store.now(), "dance_guide_expired", 410);
    await this.captureAccess(actor, id);
    return { ...grant, playback_url: url.href };
  }
  async reference(actor: string, target: DanceProductionTarget) {
    insist(target.reference, "dance_reference_unavailable", 404);
    const facts = await this.api.permissions.facts(actor, actor);
    const { grant, fence } = await this.catalogue.reference(actor, target);
    const url = new URL(grant.url);
    insist(validDanceTarget(grant.target) && sameDanceTarget(grant.target, target) &&
      url.protocol === "https:" && !url.username && !url.password &&
      Number.isSafeInteger(grant.renewAt) && Number.isSafeInteger(grant.expiresAt) &&
      grant.renewAt > await this.store.now() && grant.expiresAt > grant.renewAt,
      "dance_reference_unavailable", 410);
    await this.store.assert([facts.fence, validateFence(fence)]);
    return grant;
  }
}
