import type {
  MediaActor,
  MediaCapability,
  MediaDurationPolicy,
  MediaProcessor,
  MediaQuota,
  MediaRecord,
  PublishedMediaSong,
} from "../packages/community-media/contracts.ts";
import type { MediaRepository } from "../packages/community-media/repository.ts";

export interface CommunityMediaPorts {
  repository: MediaRepository;
  bucket: R2Bucket;
  now(): number;
  active(actor: MediaActor): Promise<boolean>;
  song(key: string, revision: number): Promise<PublishedMediaSong>;
  /** Must deny unless an explicit owner-selected policy admits this account. */
  publicPosting(
    actor: MediaActor,
    song: PublishedMediaSong,
  ): Promise<MediaCapability>;
  reviewAuthority(actor: MediaActor, media: MediaRecord): Promise<boolean>;
  processor?: MediaProcessor;
  quota?: MediaQuota;
  /** Frozen by community/Dance admission, never selected by the browser. */
  privateReviewPolicy?: MediaDurationPolicy;
  enqueue(id: string): Promise<void>;
}
