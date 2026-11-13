import { bytes32, canonical, exact, hashText, insist, object } from "../packages/community/common.ts";
import type {
  MediaActor, MediaIntent, MediaRecord, PublishedMediaSong,
} from "../packages/community-media/contracts.ts";
import type { MediaReservationFence } from "../packages/community-media/repository.ts";
import type { DanceCapture, DanceFence, DancePorts } from "../packages/dance/contracts.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import {
  danceId, sameCapturedPrincipal, validateAuthority, validateCapture, validateFence,
} from "../packages/dance/validation.ts";

/** Unapplied additive journal only. No DDL-on-read, migration ordinal or seed.
 * The existing community_media UNIQUE(community_id,account_id,request_id)
 * supplies the canonical mediaId. Never create a second media pipeline. */
export const DANCE_SOURCE3_BINDINGS_SCHEMA_PROPOSAL = `
CREATE TABLE dance_source3_requests (
 community_id TEXT NOT NULL,account_id TEXT NOT NULL,request_id TEXT NOT NULL,
 capture_id TEXT NOT NULL REFERENCES dance_captures(capture_id),
 capture_hash TEXT NOT NULL,intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
 PRIMARY KEY(community_id,account_id,request_id),UNIQUE(capture_id)
);
CREATE TRIGGER dance_source3_request_no_update BEFORE UPDATE ON dance_source3_requests
 BEGIN SELECT RAISE(ABORT,'dance_source3_original_retained'); END;
CREATE TRIGGER dance_source3_request_no_delete BEFORE DELETE ON dance_source3_requests
 BEGIN SELECT RAISE(ABORT,'dance_source3_original_retained'); END;
CREATE TRIGGER dance_source3_request_no_replace BEFORE INSERT ON dance_source3_requests
 WHEN EXISTS(SELECT 1 FROM dance_source3_requests WHERE
 (community_id=NEW.community_id AND account_id=NEW.account_id AND request_id=NEW.request_id)
 OR capture_id=NEW.capture_id)
 BEGIN SELECT RAISE(ABORT,'dance_source3_original_retained'); END;
`;

interface Original {
  capture_id: string;
  capture_hash: string;
  intent_json: string;
}

/** Preserve every trusted predicate, using one JSON binding instead of one
 * binding per scalar. JSON1 retains strings/numbers/null. Only anonymous SQL
 * parameters are supported; quoted text/comments are left byte-for-byte.
 * This is NOT an authority cache or a prechecked boolean. */
export function compactDanceFence(fences: DanceFence[]): DanceFence {
  fences.forEach(validateFence);
  const values = fences.flatMap(f => f.values);
  const original = fences.map(f => `(${f.sql})`).join(" AND ");
  const alias = "dance_source3_" + hashText(original).slice(2);
  let sql = "", parameter = 0;
  for (let i = 0; i < original.length;) {
    const c = original[i];
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c, start = i++;
      let closed = false;
      while (i < original.length) {
        if (original[i++] !== close) continue;
        if (original[i] === close) { i++; continue; }
        closed = true; break;
      }
      insist(closed, "dance_source3_fence_parameters", 503);
      sql += original.slice(start, i); continue;
    }
    if (original.slice(i, i + 2) === "--") {
      const end = original.indexOf("\n", i);
      insist(end >= 0, "dance_source3_fence_parameters", 503);
      sql += original.slice(i, end + 1); i = end + 1; continue;
    }
    if (original.slice(i, i + 2) === "/*") {
      const end = original.indexOf("*/", i + 2);
      insist(end >= 0, "dance_source3_fence_parameters", 503);
      sql += original.slice(i, end + 2); i = end + 2; continue;
    }
    insist(!(/[:@$]/.test(c) && /[A-Za-z_]/.test(original[i + 1] ?? "")),
      "dance_source3_fence_parameters", 503);
    if (c === "?") {
      insist(!/[0-9]/.test(original[i + 1] ?? ""), "dance_source3_fence_parameters", 503);
      sql += `json_extract(${alias}.bindings,'$[${parameter++}]')`;
    } else sql += c;
    i++;
  }
  const encoded = JSON.stringify(values);
  insist(fences.length > 0 && parameter === values.length && new TextEncoder().encode(sql).length <= 64000 &&
    new TextEncoder().encode(encoded).length <= 128 * 1024 && values.every(v => v === null || typeof v === "string" ||
      (typeof v === "number" && Number.isFinite(v))), "dance_source3_fence_budget", 503);
  return { sql: `EXISTS(SELECT 1 FROM (SELECT ? AS bindings) AS ${alias} WHERE ${sql})`,
    values: [encoded] };
}
export function source3ReservationFence(fences: DanceFence[]): MediaReservationFence {
  // The unchanged MediaRepository contributes 17 bindings; this contributes 1.
  return compactDanceFence(fences);
}

export class DanceSource3Bindings {
  readonly store: DanceStore;
  readonly communityId: string;
  readonly sourceHash: string;
  readonly ports: Omit<DancePorts, "media">;
  constructor(input: {
    db: D1Database; communityId: string; sourceHash: string;
    dance: Omit<DancePorts, "media">;
  }) {
    this.store = new DanceStore(input.db);
    this.communityId = input.communityId;
    this.sourceHash = bytes32(input.sourceHash);
    this.ports = Object.freeze({ ...input.dance });
  }
  private original(actor: MediaActor, requestId: string) {
    return this.store.db.prepare(`SELECT capture_id,capture_hash,intent_json
      FROM dance_source3_requests WHERE community_id=? AND account_id=? AND request_id=?`)
      .bind(this.communityId, danceId(actor.accountId), danceId(requestId)).first<Original>();
  }
  private async access(actor: MediaActor, id: string, expectedHash: string) {
    actor = structuredClone(actor);
    const row = await this.store.db.prepare(`SELECT c.capture_json,s.consent_json
      FROM dance_captures c JOIN dance_consents s ON s.capture_id=c.capture_id
      WHERE c.capture_id=? AND c.community_id=? AND c.account_id=?`)
      .bind(danceId(id), this.communityId, danceId(actor.accountId))
      .first<{ capture_json: string; consent_json: string }>();
    insist(row, "dance_source3_capture_missing", 403);
    const capture: DanceCapture = {
      ...JSON.parse(row.capture_json), consent: JSON.parse(row.consent_json),
    };
    validateCapture(capture);
    insist(capture.captureId === id && capture.communityId === this.communityId &&
      capture.learner.accountId === actor.accountId && capture.captureHash === bytes32(expectedHash) &&
      capture.source.sourceHash === this.sourceHash,
      "dance_source3_capture_changed", 409);
    const authority = structuredClone(await this.ports.authority(this.communityId, actor.accountId, actor.accountId));
    validateAuthority(authority, actor.accountId, actor.accountId);
    sameCapturedPrincipal(authority.actor, capture.learner);
    insist(authority.owner.canonicalAccepted && authority.owner.epoch === capture.expected.ownerEpoch &&
      authority.epochs.configurationRevision === capture.expected.configurationRevision &&
      authority.epochs.rulesEpoch === capture.expected.rulesEpoch &&
      authority.epochs.mediaEpoch === capture.expected.mediaEpoch,
      "dance_source3_authority_changed", 403);
    const fences: DanceFence[] = [authority.fence,
      structuredClone(await this.ports.authorization(structuredClone(capture))),
      structuredClone(await this.ports.rules(structuredClone(capture))), {
        sql: `EXISTS(SELECT 1 FROM dance_captures c JOIN dance_consents s ON s.capture_id=c.capture_id
          WHERE c.capture_id=? AND c.community_id=? AND c.account_id=? AND c.capture_json=?
          AND s.consent_json=? AND json_extract(c.capture_json,'$.expiresAtMs')>${DANCE_DB_NOW})
          AND ${DANCE_DB_NOW}<?`,
        values: [id, this.communityId, actor.accountId, row.capture_json, row.consent_json,
          authority.owner.expiresAtMs],
      }];
    return { capture, fences };
  }
  private assert(fences: DanceFence[]) {
    return this.store.assert(fences.map(f => compactDanceFence([f])));
  }
  private matches(c: DanceCapture, intent: MediaIntent, song?: PublishedMediaSong) {
    // Retain the exact permitted original envelope; reject surplus URL/session
    // or secret fields rather than persisting or silently stripping them.
    exact(object(intent), ["requestId", "songKey", "songRevision", "recordingSha256", "bytes",
      "startSample", "durationSamples", "purpose", "publicConsent"]);
    insist(intent.purpose === "private-review" && intent.publicConsent === false &&
      intent.songKey === c.songKey && intent.songRevision === c.songRevision &&
      intent.startSample === c.startSample && intent.durationSamples === c.durationSamples &&
      /^[a-f0-9]{64}$/.test(intent.recordingSha256) &&
      Number.isSafeInteger(intent.bytes) && intent.bytes > 0,
      "dance_source3_intent_changed", 409);
    if (song) insist(song.communityId === c.communityId && song.songKey === c.songKey &&
      song.songRevision === c.songRevision && song.audioSha256 === c.audioSha256.slice(2) &&
      song.durationSamples === c.songDurationSamples, "dance_source3_song_changed", 409);
  }
  private requestFence(actor: MediaActor, requestId: string, original: Original): DanceFence {
    return {
      sql: `EXISTS(SELECT 1 FROM dance_source3_requests WHERE community_id=? AND account_id=?
        AND request_id=? AND capture_id=? AND capture_hash=? AND intent_json=?)`,
      values: [this.communityId, actor.accountId, requestId, original.capture_id,
        original.capture_hash, original.intent_json],
    };
  }
  /** Called only AFTER cookie/origin/CSRF/expected-account authentication.
   * A browser witness is a lookup key; stored capture/consent and current
   * canonical authority determine admission. Lost ACKs retain this original. */
  async bindIntent(actor: MediaActor, captureId: string, captureHash: string, intent: MediaIntent) {
    actor = structuredClone(actor); intent = structuredClone(intent);
    const { capture, fences } = await this.access(actor, captureId, captureHash);
    this.matches(capture, intent);
    danceId(intent.requestId);
    const original: Original = { capture_id: captureId, capture_hash: captureHash,
      intent_json: canonical(intent) };
    const reconcile = async () => {
      const saved = await this.original(actor, intent.requestId);
      insist(saved && canonical(saved) === canonical(original), "dance_source3_original_conflict", 409);
      await this.assert([...fences, this.requestFence(actor, intent.requestId, saved)]);
    };
    if (await this.original(actor, intent.requestId)) return reconcile();
    try {
      await this.store.atomic(fences.map(f => compactDanceFence([f])), [this.store.db.prepare(`INSERT INTO dance_source3_requests
        (community_id,account_id,request_id,capture_id,capture_hash,intent_json) VALUES(?,?,?,?,?,?)`)
        .bind(this.communityId, actor.accountId, intent.requestId, captureId, captureHash, original.intent_json)]);
    } catch (error) {
      if (!(await this.original(actor, intent.requestId))) throw error;
      // Re-read the exact original after a failed/lost commit response; never delete it.
    }
    await reconcile();
  }
  async reservation(actor: MediaActor, intent: MediaIntent, song: PublishedMediaSong) {
    actor = structuredClone(actor); intent = structuredClone(intent); song = structuredClone(song);
    const original = await this.original(actor, intent.requestId);
    insist(original && original.intent_json === canonical(intent), "dance_source3_original_missing", 403);
    const { capture, fences } = await this.access(actor, original.capture_id, original.capture_hash);
    this.matches(capture, intent, song);
    return source3ReservationFence([...fences, this.requestFence(actor, intent.requestId, original)]);
  }
  async preview(actor: MediaActor, media: MediaRecord) {
    actor = structuredClone(actor); media = structuredClone(media);
    insist(media.accountId === actor.accountId && media.communityId === this.communityId &&
      media.purpose === "private-review" && !media.submissionId && media.state === "ready" &&
      !media.erasePending, "dance_source3_preview_denied", 403);
    const original = await this.original(actor, media.requestId);
    insist(original, "dance_source3_original_missing", 403);
    const { capture, fences } = await this.access(actor, original.capture_id, original.capture_hash);
    const intent = JSON.parse(original.intent_json) as MediaIntent;
    this.matches(capture, intent);
    insist(media.songKey === capture.songKey && media.songRevision === capture.songRevision &&
      media.audioSha256 === capture.audioSha256.slice(2) &&
      media.recordingSha256 === intent.recordingSha256 && media.sourceBytes === intent.bytes &&
      media.startSample === intent.startSample && media.durationSamples === intent.durationSamples &&
      media.mediaPolicyVersion === capture.mediaPolicyVersion && media.publicConsent === false,
      "dance_source3_media_changed", 409);
    // ID is supplied by the persisted source3 row, never by latest-ready lookup.
    const row = await this.store.db.prepare(`SELECT body FROM community_media WHERE
      community_id=? AND account_id=? AND request_id=? AND id=? AND revision=? AND state='ready'`)
      .bind(this.communityId, actor.accountId, media.requestId, media.id, media.revision)
      .first<{ body: string }>();
    insist(row && canonical(JSON.parse(row.body)) === canonical(media), "dance_source3_media_changed", 409);
    await this.assert([...fences, this.requestFence(actor, media.requestId, original), {
      sql: `EXISTS(SELECT 1 FROM community_media WHERE id=? AND community_id=? AND account_id=?
        AND request_id=? AND revision=? AND state='ready' AND body=? AND expires_at>${DANCE_DB_NOW}
        AND COALESCE(json_extract(body,'$.erasePending'),0)=0)`,
      values: [media.id, this.communityId, actor.accountId, media.requestId, media.revision, row.body],
    }]);
    return true;
  }
  async assertUploaderMedia(id: string, actor: MediaActor, recordingSha256: string) {
    actor = structuredClone(actor);
    const row = await this.store.db.prepare(`SELECT body FROM community_media
      WHERE id=? AND community_id=? AND account_id=?`)
      .bind(id, this.communityId, actor.accountId).first<{ body: string }>();
    insist(row, "dance_source3_media_changed", 409);
    const media = JSON.parse(row.body) as MediaRecord;
    insist(media.recordingSha256 === bytes32(recordingSha256).slice(2), "dance_source3_media_changed", 409);
    // Retained trusted submissions use existing review/deadline authority.
    // Their exact immutable capture/request association is still required.
    const original = await this.original(actor, media.requestId);
    insist(original && (!media.submissionId || media.submissionId === original.capture_id),
      "dance_source3_original_missing", 403);
    if (!media.submissionId) await this.preview(actor, media);
  }
  async assertSubmission(id: string, captureHash: string, recordingSha256: string) {
    const row = await this.store.db.prepare(`SELECT m.account_id,m.body,b.capture_hash
      FROM community_media m JOIN dance_source3_requests b ON b.community_id=m.community_id
      AND b.account_id=m.account_id AND b.request_id=m.request_id
      WHERE m.id=? AND m.community_id=?`)
      .bind(id, this.communityId).first<{ account_id: string; body: string; capture_hash: string }>();
    insist(row && row.capture_hash === bytes32(captureHash), "dance_source3_capture_changed", 409);
    await this.assertUploaderMedia(id, { accountId: row.account_id }, recordingSha256);
  }
}
