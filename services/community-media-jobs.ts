import type { CommunityMedia } from "./community-media.ts";
import {
  digest,
  requireMedia,
  sha256,
} from "../packages/community-media/validation.ts";

export const MEDIA_LEASE_MS = 120_000;
export async function processCommunityMedia(
  service: CommunityMedia,
  id: string,
) {
  let record = await service.ports.repository.get(id);
  if (record.state !== "queued") return;
  const claim = crypto.randomUUID();
  try {
    record = await service.ports.repository.save(record, {
      state: "processing",
      claim,
      leaseUntil: service.ports.now() + MEDIA_LEASE_MS,
      attempts: record.attempts + 1,
      error: undefined,
    });
  } catch {
    return;
  } // Another consumer owns this generation.
  const outputKey = `${service.prefix(id)}rendition/${claim}.mp4`;
  try {
    const song = await service.usable(record);
    if (record.purpose === "public-feed")
      requireMedia(
        (await service.capability({ accountId: record.accountId }, song))
          .allowed,
        "media_public_posting_not_permitted",
        403,
      );
    requireMedia(service.ports.processor, "media_processor_unavailable", 503);
    requireMedia(record.sourceKey, "media_source_missing", 422);
    const source = await service.ports.bucket.get(record.sourceKey);
    requireMedia(source, "media_source_missing", 422);
    const input = new Uint8Array(await source.arrayBuffer());
    requireMedia(
      input.byteLength === record.sourceBytes &&
        (await sha256(input)) === record.recordingSha256,
      "media_recording_mismatch",
      422,
    );
    const output = await service.ports.processor.render(input, record, song);
    requireMedia(
      output.bytes.byteLength <= 32 * 1024 * 1024 &&
        output.bytes.byteLength === output.facts.bytes &&
        (await sha256(output.bytes)) === digest(output.facts.sha256),
      "media_rendition_mismatch",
      422,
    );
    requireMedia(
      output.facts.videoCodec === "h264" &&
        output.facts.audioCodec === "aac" &&
        Math.abs(output.facts.durationMs - record.durationSamples / 48) <= 100,
      "media_rendition_invalid",
      422,
    );
    await service.ports.bucket.put(outputKey, output.bytes, {
      sha256: output.facts.sha256,
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "video/mp4" },
    });
    await service.usable(record);
    if (record.purpose === "public-feed")
      requireMedia(
        (await service.capability({ accountId: record.accountId }, song))
          .allowed,
        "media_public_posting_not_permitted",
        403,
      );
    requireMedia(
      service.ports.now() < record.leaseUntil!,
      "media_processing_lease_expired",
      409,
    );
    await service.ports.repository.save(record, {
      state: "ready",
      renditionKey: outputKey,
      rendition: output.facts,
      readyAt: service.ports.now(),
      claim: undefined,
      leaseUntil: undefined,
    });
  } catch (error) {
    await service.ports.bucket.delete(outputKey);
    const current = await service.ports.repository.get(id);
    if (current.state === "processing" && current.claim === claim) {
      const known =
        error instanceof Error && /^media_[a-z_]+$/.test(error.message)
          ? error.message
          : "media_processing_failed";
      await service.ports.repository.save(current, {
        state: "failed",
        error: known,
        claim: undefined,
        leaseUntil: undefined,
      });
    }
  }
}
