import {
  readyForMediaReview,
  readyForMediaSubmission,
} from "./community-media-access.ts";
import {
  eraseCommunityMedia,
  recoverCommunityMedia,
} from "./community-media-maintenance.ts";
import type {
  MediaActor,
  MediaBinding,
  MediaFeedPage,
  MediaIntent,
  MediaRecord,
  MediaStatus,
  PublishedMediaSong,
} from "../packages/community-media/contracts.ts";
import { MEDIA_VERSION } from "../packages/community-media/contracts.ts";
import {
  MAX_ATTEMPTS,
  mediaText,
  UNSUBMITTED_TTL_MS,
  PUBLIC_RETENTION_MS,
  readyFacts,
  requireMedia,
  sameBinding,
  sha256,
  SONG_CLIP_POLICY,
  terminal,
  validateIntent,
} from "../packages/community-media/validation.ts";

import type { CommunityMediaPorts } from "./community-media-ports.ts";
export type { CommunityMediaPorts } from "./community-media-ports.ts";
import {
  MEDIA_LEASE_MS,
  processCommunityMedia,
} from "./community-media-jobs.ts";
import { reconcileMediaArtifact } from "./community-media-reconciliation.ts";
export class CommunityMedia {
  readonly ports: CommunityMediaPorts;
  constructor(ports: CommunityMediaPorts) {
    this.ports = ports;
  }
  get communityId() {
    return this.ports.repository.communityId;
  }
  async actor(actor: MediaActor) {
    requireMedia(await this.ports.active(actor), "media_account_inactive", 403);
  }
  async song(record: MediaBinding) {
    const song = await this.ports.song(record.songKey, record.songRevision);
    requireMedia(
      song.communityId === record.communityId &&
        song.songKey === record.songKey &&
        song.songRevision === record.songRevision &&
        song.audioSha256 === record.audioSha256,
      "media_song_revision_changed",
      409,
    );
    return song;
  }
  async capability(actor: MediaActor, song: PublishedMediaSong) {
    await this.actor(actor);
    return this.ports.publicPosting(actor, song);
  }
  privateCapability() {
    const policy = this.ports.privateReviewPolicy;
    const allowed =
      !!policy &&
      policy.version.length > 0 &&
      policy.minSamples === 6 * 48000 &&
      policy.maxSamples === 30 * 48000;
    return {
      allowed,
      reason: allowed ? "active_account" : "media_private_policy_unconfigured",
    };
  }
  async reserve(actor: MediaActor, intent: MediaIntent) {
    await this.actor(actor);
    requireMedia(intent && typeof intent === "object", "invalid_media_intent");
    const song = await this.ports.song(intent.songKey, intent.songRevision);
    requireMedia(
      song.communityId === this.communityId,
      "media_wrong_community",
      403,
    );
    const policy =
      intent.purpose === "private-review"
        ? this.ports.privateReviewPolicy
        : SONG_CLIP_POLICY;
    requireMedia(policy, "media_private_policy_unconfigured", 503);
    if (intent.purpose === "private-review")
      requireMedia(
        this.privateCapability().allowed,
        "media_private_policy_unconfigured",
        503,
      );
    validateIntent(intent, song, policy);
    if (intent.purpose === "public-feed")
      requireMedia(
        (await this.capability(actor, song)).allowed,
        "media_public_posting_not_permitted",
        403,
      );
    const now = this.ports.now();
    const record = await this.ports.repository.reserve(
      {
        version: MEDIA_VERSION,
        id: crypto.randomUUID(),
        requestId: intent.requestId,
        revision: 1,
        state: "uploading",
        purpose: intent.purpose,
        publicConsent: intent.publicConsent,
        communityId: this.communityId,
        accountId: actor.accountId,
        songKey: song.songKey,
        songRevision: song.songRevision,
        audioSha256: song.audioSha256,
        recordingSha256: intent.recordingSha256,
        sourceBytes: intent.bytes,
        startSample: intent.startSample,
        durationSamples: intent.durationSamples,
        mediaPolicyVersion: policy.version,
        createdAt: now,
        uploadExpiresAt: now + 3_600_000,
        expiresAt:
          now +
          (intent.purpose === "private-review"
            ? UNSUBMITTED_TTL_MS
            : PUBLIC_RETENTION_MS),
        attempts: 0,
      },
      this.ports.quota,
    );
    requireMedia(
      sameBinding(record, {
        ...record,
        ...intent,
        audioSha256: song.audioSha256,
      }) &&
        record.sourceBytes === intent.bytes &&
        record.purpose === intent.purpose &&
        record.publicConsent === intent.publicConsent,
      "media_idempotency_conflict",
      409,
    );
    return this.statusOf(record);
  }
  async owned(id: string, actor: MediaActor) {
    await this.actor(actor);
    const record = await this.ports.repository.get(id);
    requireMedia(record.accountId === actor.accountId, "media_not_found", 404);
    return record;
  }
  async usable(record: MediaRecord) {
    requireMedia(
      !terminal(record) && this.ports.now() < record.expiresAt,
      "media_unavailable",
      410,
    );
    await this.actor({ accountId: record.accountId });
    return this.song(record);
  }
  prefix(id: string) {
    return `community-media/${encodeURIComponent(this.communityId)}/${id}/`;
  }
  async upload(id: string, actor: MediaActor, bytes: Uint8Array) {
    const before = await this.owned(id, actor);
    await this.usable(before);
    requireMedia(
      this.ports.now() < before.uploadExpiresAt,
      "media_upload_expired",
      410,
    );
    requireMedia(
      bytes.byteLength === before.sourceBytes &&
        (await sha256(bytes)) === before.recordingSha256,
      "media_recording_mismatch",
      422,
    );
    // A lost completion response can be replayed without replacing the sealed source.
    if (["queued", "processing", "ready", "failed"].includes(before.state))
      return this.statusOf(before);
    requireMedia(before.state === "uploading", "media_upload_busy", 409);
    const claim = crypto.randomUUID(),
      sourceKey = `${this.prefix(id)}source/${claim}`;
    const receiving = await this.ports.repository.save(before, {
      state: "receiving",
      claim,
      leaseUntil: this.ports.now() + MEDIA_LEASE_MS,
    });
    try {
      await this.ports.bucket.put(sourceKey, bytes, {
        sha256: before.recordingSha256,
        onlyIf: { etagDoesNotMatch: "*" },
      });
      // Recheck identity immediately before committing received bytes.
      await this.usable(receiving);
      const queued = await this.ports.repository.save(receiving, {
        state: "queued",
        sourceKey,
        claim: undefined,
        leaseUntil: undefined,
      });
      // Durable queued intent survives a transport failure; scheduled recovery retries.
      await this.ports.enqueue(id).catch(() => {});
      return this.statusOf(queued);
    } catch (error) {
      const current = await reconcileMediaArtifact(
        this,
        receiving,
        sourceKey,
        "source",
        error,
      );
      if (current.sourceKey === sourceKey && !terminal(current))
        return this.statusOf(current);
      throw error;
    }
  }
  process(id: string) {
    return processCommunityMedia(this, id);
  }
  async retry(id: string, actor: MediaActor) {
    const record = await this.owned(id, actor);
    const song = await this.usable(record);
    if (record.purpose === "public-feed")
      requireMedia(
        (await this.capability(actor, song)).allowed,
        "media_public_posting_not_permitted",
        403,
      );
    requireMedia(
      record.state === "failed" &&
        record.attempts < MAX_ATTEMPTS &&
        record.sourceKey,
      "media_retry_unavailable",
      409,
    );
    const queued = await this.ports.repository.save(record, {
      state: "queued",
      error: undefined,
    });
    await this.ports.enqueue(id).catch(() => {});
    return this.statusOf(queued);
  }
  async withdraw(id: string, actor: MediaActor) {
    const record = await this.owned(id, actor);
    const removed = terminal(record)
      ? record
      : await this.ports.repository.save(record, {
          state: "withdrawn",
          erasePending: true,
        });
    await this.erase(removed);
    return this.statusOf(await this.ports.repository.get(id));
  }
  /** Trusted moderator entrypoint; HTTP adapter never accepts an actor assertion. */
  async revoke(id: string, actor: MediaActor) {
    await this.actor(actor);
    const record = await this.ports.repository.get(id);
    requireMedia(
      await this.ports.reviewAuthority(actor, record),
      "media_review_forbidden",
      403,
    );
    const removed = terminal(record)
      ? record
      : await this.ports.repository.save(record, {
          state: "revoked",
          erasePending: true,
        });
    await this.erase(removed);
  }
  erase(record: MediaRecord) {
    return eraseCommunityMedia(this, record);
  }
  recover(after = "") {
    return recoverCommunityMedia(this, after);
  }
  statusOf(record: MediaRecord): MediaStatus {
    const expired =
      this.ports.now() >= record.expiresAt ||
      (["uploading", "receiving"].includes(record.state) &&
        this.ports.now() >= record.uploadExpiresAt);
    return {
      id: record.id,
      state: expired ? "expired" : record.state,
      purpose: record.purpose,
      error: record.error,
      canRetry:
        record.state === "failed" &&
        record.attempts < MAX_ATTEMPTS &&
        this.ports.now() < record.expiresAt,
      expiresAt: record.expiresAt,
      ...(record.state === "ready" && this.ports.now() < record.expiresAt
        ? {
            playbackUrl: `/api/media/${record.id}/playback`,
            ready: readyFacts(record),
          }
        : {}),
    };
  }
  async status(id: string, actor: MediaActor) {
    return this.statusOf(await this.owned(id, actor));
  }
  async playbackRecord(id: string, actor: MediaActor | null) {
    const record = await this.ports.repository.get(id),
      song = await this.usable(record);
    requireMedia(record.state === "ready", "media_not_ready", 409);
    if (record.purpose === "private-review") {
      requireMedia(actor, "media_authentication_required", 401);
      await this.actor(actor);
      requireMedia(
        actor.accountId === record.accountId ||
          (await this.ports.reviewAuthority(actor, record)),
        "media_not_found",
        404,
      );
    } else
      requireMedia(
        (await this.capability({ accountId: record.accountId }, song)).allowed,
        "media_unavailable",
        410,
      );
    return record;
  }
  readyForReview(id: string, binding: MediaBinding, reviewer: MediaActor) {
    return readyForMediaReview(this, id, binding, reviewer);
  }
  readyForSubmission(id: string, binding: MediaBinding, uploader: MediaActor) {
    return readyForMediaSubmission(this, id, binding, uploader);
  }
  async feed(limit = 20, cursor?: string): Promise<MediaFeedPage> {
    requireMedia(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 50,
      "invalid_media_limit",
    );
    let position: { readyAt: number; id: string } | undefined;
    if (cursor) {
      requireMedia(cursor.length < 256, "invalid_media_cursor");
      try {
        position = JSON.parse(atob(cursor));
      } catch {
        requireMedia(false, "invalid_media_cursor");
      }
      requireMedia(
        position &&
          Number.isSafeInteger(position.readyAt) &&
          typeof position.id === "string",
        "invalid_media_cursor",
      );
      mediaText(position.id, 80);
    }
    const rows = await this.ports.repository.feed(limit, position),
      items: MediaFeedPage["items"] = [];
    for (const record of rows) {
      try {
        const song = await this.usable(record);
        if (
          !(await this.capability({ accountId: record.accountId }, song))
            .allowed
        )
          continue;
        items.push({
          id: record.id,
          songKey: record.songKey,
          songRevision: record.songRevision,
          title: song.title,
          readyAt: record.readyAt!,
          durationMs: record.rendition!.durationMs,
          playbackUrl: `/api/media/${record.id}/playback`,
        });
      } catch {
        /* Fail closed on unavailable publication authority. */
      }
    }
    const last = rows.at(-1);
    return {
      version: MEDIA_VERSION,
      items,
      cursor:
        rows.length === limit && last
          ? btoa(JSON.stringify({ readyAt: last.readyAt, id: last.id }))
          : null,
    };
  }
}
