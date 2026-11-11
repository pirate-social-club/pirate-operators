import {
  accountSession,
  authenticatedWrite,
  type AuthContext,
} from "../packages/community/accounts.ts";
import { CommunityError, insist } from "../packages/community/common.ts";
import {
  PUBLIC_POSTING_UNDECIDED,
  type MediaActor,
  type MediaRecord,
} from "../packages/community-media/contracts.ts";
import { BoundMediaProcessor } from "../packages/community-media/processor-transport.ts";
import { MediaRepository } from "../packages/community-media/repository.ts";
import {
  DANCE_PRIVATE_MEDIA_POLICY,
  type DancePorts,
} from "../packages/dance/contracts.ts";
import { DanceStore } from "../packages/dance/store.ts";
import { CommunityMedia } from "./community-media.ts";
import { communityMediaApi } from "./community-media-api.ts";
import type { CommunityMediaPorts } from "./community-media-ports.ts";
import { danceCommunityApi } from "./dance-community-api.ts";
import {
  dancePrivatePlaybackAuthority,
  integratedDanceMedia,
} from "./dance-media-integration.ts";
import { DanceReviewService } from "./dance-review.ts";

export type PrivateMediaJob = {
  kind: "community-media/1";
  communityId: string;
  mediaId: string;
};
export type CommunityQueueJob =
  | { kind?: "publication"; jobId: string }
  | PrivateMediaJob;

export class CommunityPrivateDance {
  readonly communityId: string;
  readonly media: CommunityMedia;
  readonly dance: DancePorts;
  readonly db: D1Database;
  constructor(input: {
    db: D1Database;
    bucket: R2Bucket;
    communityId: AuthContext["communityId"];
    /** Managed service binding; there is no client-selected processor origin. */
    renderer: Pick<Fetcher, "fetch">;
    dance: Omit<DancePorts, "media">;
    active: CommunityMediaPorts["active"];
    song: CommunityMediaPorts["song"];
    reservation: NonNullable<CommunityMediaPorts["privateReservation"]>;
    preview(actor: MediaActor, media: MediaRecord): Promise<boolean>;
    enqueue(job: PrivateMediaJob): Promise<void>;
    now?: () => number;
  }) {
    this.db = input.db;
    this.communityId = input.communityId;
    const store = new DanceStore(input.db);
    const denied = (error: unknown) =>
      error instanceof CommunityError &&
      [401, 403, 404, 409, 410].includes(error.status);
    this.media = new CommunityMedia({
      repository: new MediaRepository(input.db, input.communityId),
      bucket: input.bucket,
      now: input.now ?? Date.now,
      active: input.active,
      song: input.song,
      async privateReservation(actor, intent, song) {
        const fence = await input.reservation(actor, intent, song);
        insist(
          fence &&
            typeof fence.sql === "string" &&
            fence.sql.trim() &&
            Array.isArray(fence.values),
          "media_reservation_fence_unavailable",
          503,
        );
        return fence;
      },
      publicPosting: async () => PUBLIC_POSTING_UNDECIDED,
      privateReviewPolicy: DANCE_PRIVATE_MEDIA_POLICY,
      processor: new BoundMediaProcessor(input.renderer),
      enqueue: (mediaId) =>
        input.enqueue({
          kind: "community-media/1",
          communityId: this.communityId,
          mediaId,
        }),
      async reviewAuthority(actor, media) {
        if (!media.submissionId || actor.accountId === media.accountId)
          return false;
        try {
          const review = await store.review(media.submissionId);
          if (review.receipt.mediaId !== media.id || review.localDenied)
            return false;
          const access = await dance.permissions.read(actor.accountId, review);
          await store.assertAccess(review, access.fences);
          return true;
        } catch (error) {
          if (denied(error)) return false;
          throw error;
        }
      },
      privatePlaybackAuthority: (actor, media) => playback(actor, media),
    });
    this.dance = { ...input.dance, media: integratedDanceMedia(this.media) };
    const dance = new DanceReviewService(store, this.dance, this.communityId);
    const playback = dancePrivatePlaybackAuthority(dance, input.preview);
  }

  async fetch(request: Request, context: AuthContext, headers: Headers) {
    insist(
      context.communityId === this.communityId,
      "media_wrong_community",
      403,
    );
    const dance = await danceCommunityApi(
      request,
      { db: this.db, dance: this.dance },
      context,
      headers,
    );
    if (dance) return dance;
    return communityMediaApi(request, this.media, {
      origin: context.origin,
      actor: async (r, write) => {
        try {
          const session = write
            ? await authenticatedWrite(r, this.db, context)
            : await accountSession(r, this.db, context);
          return { accountId: session.account_id };
        } catch (error) {
          if (!write && error instanceof CommunityError && error.status === 401)
            return null;
          throw error;
        }
      },
    });
  }

  async process(job: PrivateMediaJob) {
    insist(
      job.kind === "community-media/1" &&
        job.communityId === this.communityId &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          job.mediaId,
        ),
      "media_job_scope_changed",
      409,
    );
    await this.media.process(job.mediaId);
  }

  async tick() {
    const previous = await this.db
      .prepare(
        "SELECT after_id,revision FROM community_media_recovery WHERE community_id=?",
      )
      .bind(this.communityId)
      .first<{ after_id: string; revision: number }>();
    const after = (await this.media.recover(previous?.after_id)) ?? "";
    if (previous) {
      await this.db
        .prepare(
          "UPDATE community_media_recovery SET after_id=?,revision=revision+1 WHERE community_id=? AND revision=?",
        )
        .bind(after, this.communityId, previous.revision)
        .run();
    } else {
      await this.db
        .prepare(
          "INSERT INTO community_media_recovery VALUES(?,?,0) ON CONFLICT DO NOTHING",
        )
        .bind(this.communityId, after)
        .run();
    }
  }
}
