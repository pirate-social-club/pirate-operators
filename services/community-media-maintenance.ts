import type { CommunityMedia } from "./community-media.ts";
import type { MediaRecord } from "../packages/community-media/contracts.ts";
import {
  MAX_ATTEMPTS,
  terminal,
} from "../packages/community-media/validation.ts";

export async function eraseCommunityMedia(
  service: CommunityMedia,
  record: MediaRecord,
) {
  if (!terminal(record)) return;
  try {
    // Re-establish accounting even after an earlier sweep succeeded. A worker
    // may have written a late object after that sweep; failed deletion must not
    // leave retained bytes outside the quota predicate.
    record = await service.ports.repository.get(record.id);
    if (!terminal(record)) return;
    // Every sweep owns a fresh CAS revision, including overlapping sweeps
    // that both observe erasePending=true. Only its own revision may clear.
    record = await service.ports.repository.save(record, {
      erasePending: true,
    });
    let cursor: string | undefined;
    do {
      const page = await service.ports.bucket.list({
        prefix: service.prefix(record.id),
        cursor,
      });
      if (page.objects.length)
        await service.ports.bucket.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (record.erasePending || record.sourceKey || record.renditionKey)
      await service.ports.repository.save(record, {
        erasePending: false,
        sourceKey: undefined,
        renditionKey: undefined,
      });
  } catch {
    /* Tombstone stays inaccessible; scheduled recovery retries erasure. */
  }
}

export async function recoverCommunityMedia(
  service: CommunityMedia,
  after = "",
) {
  const records = await service.ports.repository.records(100, after);
  const wakes: string[] = [];
  for (let record of records) {
    if (
      !terminal(record) &&
      (service.ports.now() >= record.expiresAt ||
        (["uploading", "receiving"].includes(record.state) &&
          service.ports.now() >= record.uploadExpiresAt))
    ) {
      record = await service.ports.repository.save(record, {
        state: "expired",
        erasePending: true,
      });
    }
    if (terminal(record)) {
      await service.erase(record);
      continue;
    }
    if (
      ["receiving", "processing"].includes(record.state) &&
      (record.leaseUntil ?? 0) <= service.ports.now()
    ) {
      record = await service.ports.repository.save(record, {
        state:
          record.state === "receiving"
            ? "uploading"
            : record.attempts < MAX_ATTEMPTS
              ? "queued"
              : "failed",
        claim: undefined,
        leaseUntil: undefined,
        error: "media_worker_interrupted",
      });
    }
    if (record.state === "queued") wakes.push(record.id);
  }
  // Retention is independent of the transport. Queued rows are already the
  // durable wake intent, so failure leaves them eligible on the next sweep.
  for (const id of wakes) {
    try {
      await service.ports.enqueue(id);
    } catch {
      // Keep the row queued and finish the cursor page.
    }
  }
  return records.length === 100 ? records.at(-1)!.id : null;
}
