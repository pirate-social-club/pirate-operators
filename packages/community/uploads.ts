import { insist, token } from "./common.ts";
import { ownedSubmission, type Submission } from "./submissions.ts";

const checksum = (hex: string) =>
  Uint8Array.from(hex.slice(2).match(/../g)!, (b) => Number.parseInt(b, 16));
async function boundedAudio(request: Request, length: number) {
  insist(
    request.headers.get("content-type")?.split(";")[0] === "audio/mpeg",
    "mp3_required",
    415,
  );
  const reader = request.body?.getReader();
  insist(reader, "audio_required");
  // The maximum is 25 MiB. Allocate once and release each input chunk; the
  // runtime never buffers an unbounded request or duplicates the full MP3.
  const bytes = new Uint8Array(length);
  let offset = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.length > length) {
        await reader.cancel();
        insist(false, "audio_length_mismatch", 413);
      }
      bytes.set(part.value, offset);
      offset += part.value.length;
    }
  } finally {
    reader.releaseLock();
  }
  insist(offset === length, "audio_length_mismatch");
  return bytes;
}
async function finishUpload(
  db: D1Database,
  row: Submission,
  lease: string,
  etag: string,
) {
  const updated = await db
    .prepare(
      `UPDATE media_submissions SET upload_state='uploaded',object_etag=?,upload_lease=NULL,upload_lease_until=0
    WHERE submission_id=? AND upload_state='uploading' AND upload_lease=? AND object_key=?`,
    )
    .bind(etag, row.submission_id, lease, row.object_key)
    .run();
  insist(updated.meta.changes === 1, "upload_lease_lost", 409);
}

export async function uploadAudio(
  db: D1Database,
  media: R2Bucket,
  accountId: string,
  id: string,
  request: Request,
  time = Date.now(),
) {
  let row = await ownedSubmission(db, id, accountId);
  if (row.upload_state === "uploaded" || row.upload_state === "sealed")
    return { uploaded: true };
  // A lost R2 response is reconciled from the checksum-validated object before
  // claiming a replacement upload. Sealed objects are never overwritten.
  if (row.upload_state === "uploading") {
    const head = await media.head(row.object_key);
    if (
      head &&
      head.size === row.audio_bytes &&
      head.customMetadata?.sha256 === row.audio_sha256
    ) {
      await finishUpload(db, row, row.upload_lease!, head.etag);
      return { uploaded: true };
    }
    insist(row.upload_lease_until <= time, "upload_in_progress", 409);
  }
  const lease = token(),
    key = `staging/${id}/${lease}`;
  const claimed = await db
    .prepare(
      `UPDATE media_submissions SET upload_state='uploading',upload_lease=?,upload_lease_until=?,object_key=?
    WHERE submission_id=? AND account_id=? AND (upload_state='reserved' OR (upload_state='uploading' AND upload_lease_until<=?)) RETURNING *`,
    )
    .bind(lease, time + 180_000, key, id, accountId, time)
    .first<Submission>();
  insist(claimed, "upload_in_progress", 409);
  row = claimed;
  const bytes = await boundedAudio(request, row.audio_bytes);
  // R2 rejects the put if bytes do not match the immutable reservation. Each
  // lease has its own object key, so a stale writer cannot replace sealed media.
  const saved = await media.put(key, bytes, {
    sha256: checksum(row.audio_sha256),
    httpMetadata: { contentType: "audio/mpeg" },
    customMetadata: { sha256: row.audio_sha256 },
  });
  insist(saved, "upload_not_stored", 503);
  await finishUpload(db, row, lease, saved.etag);
  return { uploaded: true };
}
