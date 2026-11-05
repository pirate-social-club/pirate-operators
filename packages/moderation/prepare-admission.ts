import { hexToBytes, sha256 } from "viem";
import { canonical, insist, text } from "../community/common.ts";
import {
  admissionRequest,
  fetchCapability,
  type Capability,
} from "./capabilities.ts";
import type { ManagedAdmission } from "./admission-store.ts";
import type { ManagedPairing } from "./pairing.ts";
import {
  readMp3FrameWindow,
  readMp3Probe,
  type Mp3Probe,
} from "./mp3-windows.ts";
import type { AudioWindowFacts } from "./admission.ts";

export interface PreparedAdmission {
  requestHash: string;
  title: string;
  lyrics: string;
  probe: Mp3Probe;
  windows: (AudioWindowFacts & { objectKey: string; byteLength: number })[];
}
export interface AdmissionMedia {
  head(
    key: string,
  ): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    body: ReadableStream<Uint8Array>;
  } | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: AdmissionPutOptions,
  ): Promise<unknown>;
}
export interface AdmissionPutOptions {
  sha256?: Uint8Array;
  httpMetadata?: { contentType: string };
  customMetadata?: Record<string, string>;
}
async function retainInput(
  media: AdmissionMedia,
  key: string,
  cap: Capability,
  mediaType: string,
  transport?: (request: Request) => Promise<Response>,
) {
  const existing = await media.head(key);
  if (existing) {
    insist(
      existing.size === cap.byteLength &&
        existing.customMetadata?.sha256 === cap.sha256,
      "retained_input_conflict",
      503,
    );
    return;
  }
  const bytes = await fetchCapability(cap, transport);
  await media.put(key, bytes, {
    sha256: hexToBytes(cap.sha256),
    httpMetadata: { contentType: mediaType },
    customMetadata: { sha256: cap.sha256 },
  });
}
export async function prepareAdmission(
  db: D1Database,
  media: AdmissionMedia,
  row: ManagedAdmission,
  pairing: ManagedPairing,
  transport?: (request: Request) => Promise<Response>,
): Promise<PreparedAdmission> {
  if (row.prepared_json) {
    const saved = JSON.parse(row.prepared_json) as PreparedAdmission;
    insist(
      saved.requestHash === row.request_hash,
      "prepared_admission_conflict",
      503,
    );
    return saved;
  }
  const request = admissionRequest(JSON.parse(row.request_json), pairing),
    prefix = `admissions/${row.admission_id}`;
  await retainInput(
    media,
    `${prefix}/audio`,
    request.inputs.song,
    "audio/mpeg",
    transport,
  );
  await retainInput(
    media,
    `${prefix}/title`,
    request.inputs.title,
    "text/plain; charset=utf-8",
    transport,
  );
  if (request.inputs.lyrics)
    await retainInput(
      media,
      `${prefix}/lyrics`,
      request.inputs.lyrics,
      "text/plain; charset=utf-8",
      transport,
    );
  const titleObject = await media.get(`${prefix}/title`),
    lyricsObject = request.inputs.lyrics
      ? await media.get(`${prefix}/lyrics`)
      : null;
  insist(
    titleObject && (!request.inputs.lyrics || lyricsObject),
    "retained_text_missing",
    503,
  );
  const title = text(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await titleObject.arrayBuffer(),
      ),
      200,
    ),
    lyrics = lyricsObject
      ? text(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            await lyricsObject.arrayBuffer(),
          ),
          32768,
        )
      : "";
  insist(title.trim().length > 0, "title_required");
  const source = await media.get(`${prefix}/audio`);
  insist(source, "retained_audio_missing", 503);
  const signal = AbortSignal.timeout(30000),
    probe = await readMp3Probe(source.body, 3600000, signal),
    windows: PreparedAdmission["windows"] = [];
  for (const role of ["primary", "alternate"] as const) {
    const original = await media.get(`${prefix}/audio`);
    insist(original, "retained_audio_missing", 503);
    const window = await readMp3FrameWindow(
        original.body,
        probe.durationMs,
        role,
        4000000,
        signal,
      ),
      sampleSha256 = sha256(window.bytes),
      objectKey = `${prefix}/sample-${role}`;
    await media.put(objectKey, window.bytes, {
      sha256: hexToBytes(sampleSha256),
      httpMetadata: { contentType: "audio/mpeg" },
      customMetadata: { sha256: sampleSha256 },
    });
    windows.push({
      role,
      firstFrame: window.firstFrame,
      frameCount: window.frameCount,
      startMs: window.offsetMs,
      durationMs: window.durationMs,
      sampleSha256,
      objectKey,
      byteLength: window.bytes.length,
    });
  }
  const prepared = {
    requestHash: row.request_hash,
    title,
    lyrics,
    probe,
    windows,
  };
  const saved = await db
    .prepare(
      `UPDATE managed_admissions SET prepared_json=? WHERE admission_id=? AND prepared_json IS NULL AND lease_token=? AND lease_until>?`,
    )
    .bind(canonical(prepared), row.admission_id, row.lease_token, Date.now())
    .run();
  insist(saved.meta.changes === 1, "admission_lease_lost", 409);
  return prepared;
}
