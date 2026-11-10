import { bytes32, insist, token } from "../packages/community/common.ts";
import {
  REVIEW_WINDOW_MS,
  type DanceCapture,
  type DancePorts,
} from "../packages/dance/contracts.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import {
  danceId,
  mediaBinding,
  validateCapture,
  validateMedia,
} from "../packages/dance/validation.ts";
import { DancePermissions } from "./dance-authority.ts";

export class DanceCaptureService {
  readonly store: DanceStore;
  readonly permissions: DancePermissions;
  readonly ports: DancePorts;
  readonly communityId: string;
  constructor(db: D1Database, ports: DancePorts, communityId: string) {
    bytes32(communityId);
    this.store = new DanceStore(db);
    this.ports = ports;
    this.communityId = communityId;
    this.permissions = new DancePermissions(this.store, ports, communityId);
  }
  async capture(
    actor: string,
    commandId: string,
    selection: {
      songKey: string;
      offerId: string | null;
      referenceId: string | null;
    },
  ): Promise<DanceCapture> {
    danceId(actor);
    danceId(commandId);
    bytes32(selection.songKey);
    if (selection.offerId !== null) danceId(selection.offerId);
    if (selection.referenceId !== null) danceId(selection.referenceId);
    const f = await this.permissions.facts(actor, actor);
    const hash = DanceStore.request("capture", selection);
    const find = () =>
      this.store
        .stmt(
          `SELECT request_hash,capture_json FROM dance_captures
      WHERE community_id=? AND account_id=? AND command_id=?`,
          this.communityId,
          actor,
          commandId,
        )
        .first<{ request_hash: string; capture_json: string }>();
    const prior = await find();
    if (prior) {
      insist(prior.request_hash === hash, "dance_idempotency_conflict", 409);
      await this.store.atomic([f.fence], []);
      return JSON.parse(prior.capture_json);
    }
    const admitted = await this.ports.admitCapture(
      this.communityId,
      actor,
      selection,
    );
    const c: DanceCapture = { ...admitted.capture, captureId: token() };
    validateCapture(c);
    insist(
      c.communityId === this.communityId &&
        c.accountId === actor &&
        c.identityId === f.actor.identityId &&
        c.accountRevision === f.actor.revision &&
        c.wallet === f.actor.wallet &&
        c.songKey === selection.songKey &&
        (c.offer?.offerId ?? null) === selection.offerId &&
        (c.reference?.id ?? null) === selection.referenceId,
      "dance_capture_binding_mismatch",
      409,
    );
    try {
      await this.store.atomic(
        [
          f.fence,
          admitted.fence,
          { sql: `${DANCE_DB_NOW} < ?`, values: [c.expiresAtMs] },
        ],
        [
          this.store.stmt(
            `INSERT INTO dance_captures VALUES(?,?,?,?,?,?,${DANCE_DB_NOW})`,
            c.captureId,
            this.communityId,
            actor,
            commandId,
            hash,
            JSON.stringify(c),
          ),
        ],
      );
      return c;
    } catch (error) {
      const recovered = await find();
      if (!recovered) throw error;
      insist(
        recovered.request_hash === hash,
        "dance_idempotency_conflict",
        409,
      );
      const current = await this.permissions.facts(actor, actor);
      await this.store.atomic([current.fence], []);
      return JSON.parse(recovered.capture_json);
    }
  }
  protected async recovery(
    actor: string,
    command: string,
    hash: string,
    reviewId: string,
  ) {
    const r = await this.store.review(reviewId);
    const read = await this.permissions.read(actor, r);
    await this.store.atomic(read.fences, []);
    return this.store.receipt(this.communityId, actor, command, hash);
  }
  async submit(
    actor: string,
    commandId: string,
    captureId: string,
    mediaId: string,
  ) {
    [actor, commandId, captureId, mediaId].forEach(danceId);
    const c = await this.store.capture(captureId);
    insist(
      c.communityId === this.communityId && c.accountId === actor,
      "dance_not_found",
      404,
    );
    const f = await this.permissions.facts(actor, actor);
    const hash = DanceStore.request("submit", { captureId, mediaId });
    const prior = await this.store.receipt(
      this.communityId,
      actor,
      commandId,
      hash,
    );
    if (prior) return this.recovery(actor, commandId, hash, captureId);
    insist(
      c.accountRevision === f.learner.revision &&
        c.identityId === f.learner.identityId,
      "dance_capture_authorization_changed",
      403,
    );
    const m = await this.ports.media(mediaId, mediaBinding(c), actor);
    validateMedia(c, m);
    insist(m.id === mediaId, "dance_media_binding_mismatch", 409);
    const created = await this.store
      .stmt(
        "SELECT created_at_ms FROM dance_captures WHERE capture_id=?",
        captureId,
      )
      .first<{ created_at_ms: number }>();
    insist(
      created && m.uploadedAtMs >= created.created_at_ms,
      "dance_recording_predates_capture",
      409,
    );
    const deadline = m.uploadedAtMs + REVIEW_WINDOW_MS;
    const rules = await this.ports.rules(c);
    try {
      await this.store.atomic(
        [
          f.fence,
          m.fence,
          rules,
          {
            sql: `${DANCE_DB_NOW} >= ? AND ${DANCE_DB_NOW} < ? AND ${DANCE_DB_NOW} < ? AND ${DANCE_DB_NOW} < ?`,
            values: [m.uploadedAtMs, c.expiresAtMs, m.expiresAtMs, deadline],
          },
        ],
        [
          this.store.stmt(
            `INSERT INTO dance_reviews
        (review_id,community_id,account_id,media_id,media_revision,recording_digest,
         uploaded_at_ms,submitted_at_ms,deadline_ms,state)
        VALUES(?,?,?,?,?,?,?,${DANCE_DB_NOW},?,'pending')`,
            captureId,
            this.communityId,
            actor,
            mediaId,
            m.revision,
            m.recordingSha256,
            m.uploadedAtMs,
            deadline,
          ),
          this.store.saveReceipt(
            this.communityId,
            actor,
            commandId,
            hash,
            captureId,
          ),
        ],
      );
    } catch (error) {
      const recovered = await this.recovery(
        actor,
        commandId,
        hash,
        captureId,
      ).catch(() => null);
      if (recovered) return recovered;
      throw error;
    }
    return this.recovery(actor, commandId, hash, captureId);
  }
}
