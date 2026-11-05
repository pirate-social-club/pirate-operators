// Independently owned adaptation of the centralized fixed-slot attachments.
// See docs/song-stems-source-provenance.json for the inspected source boundary.
import { sha256 as digest, hexToBytes } from "viem";
import {
  bytes32,
  exact,
  insist,
  integer,
  MAX_AUDIO_BYTES,
  object,
  token,
} from "./common.ts";
import { ownedSubmission } from "./submissions.ts";
import { boundedAudio } from "./uploads.ts";
import { readMp3Probe } from "../moderation/mp3-windows.ts";

export const stemSlots = ["instrumental", "vocals"] as const;
export type StemSlot = (typeof stemSlots)[number];
export interface SealedStem {
  submission_id: string;
  slot: StemSlot;
  sha256: `0x${string}`;
  byte_length: number;
  state: "reserved" | "uploading" | "sealed";
  object_key: string | null;
  object_etag: string | null;
  duration_ms: number | null;
  lease_token: string | null;
  lease_until: number;
}
export async function submissionStems(db: D1Database, id: string) {
  return (
    await db
      .prepare("SELECT * FROM media_stems WHERE submission_id=? ORDER BY slot")
      .bind(id)
      .all<SealedStem>()
  ).results;
}
export function stemView(rows: SealedStem[]) {
  return rows.map((r) => ({
    slot: r.slot,
    state: r.state,
    sha256: r.sha256,
    byteLength: r.byte_length,
  }));
}
export async function reserveStem(
  db: D1Database,
  accountId: string,
  id: string,
  slot: StemSlot,
  value: unknown,
  time = Date.now(),
) {
  const master = await ownedSubmission(db, id, accountId);
  insist(
    master.upload_state === "uploaded" || master.upload_state === "sealed",
    "master_upload_required",
    409,
  );
  const input = object(value);
  exact(input, ["sha256", "byteLength"]);
  const sha256 = bytes32(input.sha256),
    byteLength = integer(input.byteLength, 1, MAX_AUDIO_BYTES);
  await db
    .prepare(
      "INSERT INTO media_stems(submission_id,slot,sha256,byte_length,state,created_at) VALUES(?,?,?,?,'reserved',?) ON CONFLICT(submission_id,slot) DO NOTHING",
    )
    .bind(id, slot, sha256, byteLength, time)
    .run();
  const row = (await submissionStems(db, id)).find((r) => r.slot === slot)!;
  insist(
    row.sha256 === sha256 && row.byte_length === byteLength,
    "stem_slot_conflict",
    409,
  );
  return row;
}
async function finish(
  db: D1Database,
  row: SealedStem,
  etag: string,
  duration: number,
  time: number,
) {
  const updated = await db
    .prepare(
      "UPDATE media_stems SET state='sealed',object_etag=?,duration_ms=?,sealed_at=?,lease_token=NULL,lease_until=0 WHERE submission_id=? AND slot=? AND state='uploading' AND lease_token=? AND object_key=?",
    )
    .bind(
      etag,
      duration,
      time,
      row.submission_id,
      row.slot,
      row.lease_token,
      row.object_key,
    )
    .run();
  if (updated.meta.changes !== 1) {
    const saved = (await submissionStems(db, row.submission_id)).find(
      (r) => r.slot === row.slot,
    );
    insist(
      saved?.state === "sealed" &&
        saved.object_key === row.object_key &&
        saved.object_etag === etag,
      "stem_upload_lease_lost",
      409,
    );
  }
}
async function probeObject(media: R2Bucket, row: SealedStem) {
  const saved = await media.get(row.object_key!);
  insist(
    saved &&
      saved.size === row.byte_length &&
      saved.customMetadata?.sha256 === row.sha256,
    "sealed_stem_unavailable",
    503,
  );
  const probe = await readMp3Probe(
    saved.body,
    3600000,
    AbortSignal.timeout(30000),
  );
  return { etag: saved.etag, duration: probe.durationMs };
}
export async function uploadStem(
  db: D1Database,
  media: R2Bucket,
  accountId: string,
  id: string,
  slot: StemSlot,
  request: Request,
  time = Date.now(),
) {
  await ownedSubmission(db, id, accountId);
  let row = (await submissionStems(db, id)).find((r) => r.slot === slot);
  insist(row, "stem_reservation_required", 409);
  if (row.state === "sealed") {
    await requireStems(db, media, id, [slot]);
    return { sealed: true };
  }
  if (row.state === "uploading") {
    const head = await media.head(row.object_key!);
    if (
      head &&
      head.size === row.byte_length &&
      head.customMetadata?.sha256 === row.sha256
    ) {
      const probe = await probeObject(media, row);
      await finish(db, row, probe.etag, probe.duration, time);
      return { sealed: true };
    }
    insist(row.lease_until <= time, "stem_upload_in_progress", 409);
  }
  const lease = token(),
    key = `stems/${id}/${slot}/${lease}`;
  const claimed = await db
    .prepare(
      "UPDATE media_stems SET state='uploading',lease_token=?,lease_until=?,object_key=? WHERE submission_id=? AND slot=? AND (state='reserved' OR (state='uploading' AND lease_until<=?)) RETURNING *",
    )
    .bind(lease, time + 180000, key, id, slot, time)
    .first<SealedStem>();
  insist(claimed, "stem_upload_in_progress", 409);
  row = claimed;
  const bytes = await boundedAudio(request, row.byte_length);
  insist(digest(bytes) === row.sha256, "stem_digest_mismatch", 409);
  // Validate complete MP3 framing before retaining or accepting either stem.
  const probe = await readMp3Probe(
    new Blob([bytes]).stream(),
    3600000,
    AbortSignal.timeout(30000),
  );
  const saved = await media.put(key, bytes, {
    sha256: hexToBytes(row.sha256),
    httpMetadata: { contentType: "audio/mpeg" },
    customMetadata: { sha256: row.sha256 },
  });
  insist(saved, "stem_not_stored", 503);
  await finish(db, row, saved.etag, probe.durationMs, time);
  return { sealed: true };
}
export async function requireStems(
  db: D1Database,
  media: Pick<R2Bucket, "head">,
  id: string,
  slots: readonly StemSlot[] = stemSlots,
) {
  const rows = await submissionStems(db, id);
  const sealed: SealedStem[] = [];
  for (const slot of slots) {
    const row = rows.find((r) => r.slot === slot);
    insist(
      row?.state === "sealed" &&
        row.object_key &&
        row.object_etag &&
        row.duration_ms! > 0,
      "song_stems_required",
      409,
    );
    const head = await media.head(row.object_key);
    insist(
      head &&
        head.etag === row.object_etag &&
        head.size === row.byte_length &&
        head.customMetadata?.sha256 === row.sha256,
      "sealed_stem_unavailable",
      503,
    );
    sealed.push(row);
  }
  return sealed;
}
