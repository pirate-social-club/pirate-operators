import type { CommunityMedia } from "./community-media.ts";
import type { MediaRecord } from "../packages/community-media/contracts.ts";
import {
  requireMedia,
  terminal,
} from "../packages/community-media/validation.ts";

/** A rejected response is not a rollback. First recover committed state, or
 * fence the old CAS before cleanup. Unreadable/unchanged state preserves bytes.
 */
export async function reconcileMediaArtifact(
  service: CommunityMedia,
  lease: MediaRecord,
  key: string,
  kind: "source" | "rendition",
  error: unknown,
): Promise<MediaRecord> {
  const repository = service.ports.repository;
  let current = await repository.get(lease.id); // An unavailable read must throw.
  const referenced = () =>
    kind === "source"
      ? current.sourceKey === key
      : current.renditionKey === key;
  if (referenced() && !terminal(current)) return current;
  const expectedState = kind === "source" ? "receiving" : "processing";
  if (current.state === expectedState && current.claim === lease.claim) {
    const code =
      error instanceof Error && /^media_[a-z_]+$/.test(error.message)
        ? error.message
        : "media_processing_failed";
    try {
      current = await repository.save(current, {
        state: kind === "source" ? "uploading" : "failed",
        claim: undefined,
        leaseUntil: undefined,
        ...(kind === "rendition" ? { error: code } : {}),
      });
    } catch {
      // Includes a lost response to the fencing write itself. Never assume it
      // lost the race with an in-flight queued/ready commit.
      current = await repository.get(lease.id);
    }
  }
  if (referenced() && !terminal(current)) return current;
  requireMedia(
    current.revision > lease.revision,
    "media_commit_outcome_unknown",
    503,
  );
  if (terminal(current)) {
    // The eraser persists erasePending before touching even a late object.
    await service.erase(current);
  } else {
    // A newer canonical revision disarms the old conditional commit. Only now
    // is an unreferenced artifact known not to be committed or still pending.
    await service.ports.bucket.delete(key);
  }
  return current;
}
